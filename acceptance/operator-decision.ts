import { profileDigest } from "../execution/profile.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile, rm, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Command } from "commander";
import { z } from "zod";
import { withBeadsHttp } from "./beads-http-fixture.ts";
import { fixtureMetricsEnv } from "./beads-fixture.ts";
import { loadConfig, AgentRole, ReasoningLevel } from "../config.ts";
import { ExecutionBeads } from "../execution/beads.ts";
import { ExecutionStore, ExecutionPhase, pendingDecision } from "../execution/store.ts";
import { retryWriterFence } from "../execution/recovery.ts";
import { draftSchema, planDigest } from "../planning/plan.ts";
import { processMatchesStart, run } from "../process.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const options = new Command()
  .requiredOption("--bd <path>")
  .requiredOption("--dolt <path>")
  .requiredOption("--output <path>")
  .parse()
  .opts<{ bd: string; dolt: string; output: string }>();
await mkdir(options.output, { recursive: true });
await withBeadsHttp(options.bd, options.dolt, async (fixture, source) => {
  const state = await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "st-decision-"));
  await writeFile(
    join(options.output, "setup.json"),
    JSON.stringify({ fixture: fixture.directory, state, pid: process.pid }),
  );
  const agent = join(fixture.directory, "agent"),
    configFile = join(fixture.directory, "config.json");
  await mkdir(join(agent, "themes"), { recursive: true });
  await copyFile(join(root, "resources/theme.json"), join(agent, "themes/dotfiles.json"));
  await writeFile(join(agent, "settings.json"), JSON.stringify({ theme: "dotfiles", quietStartup: true }));
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(GIT_|PI_|STUDIO_|BEADS_|BD_|DOLT_|ZELLIJ|WORKTREE_)/u.test(key),
      ),
    ),
    ...fixtureMetricsEnv,
    HOME: fixture.directory,
    PI_CODING_AGENT_DIR: agent,
    STUDIO_CONFIG: configFile,
    STUDIO_STATE_DIR: state,
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (...args: string[]) => run("git", args, { cwd: fixture.workspace, env });
  await writeFile(join(fixture.workspace, ".gitignore"), ".beads/\n.worktrees/\n");
  await writeFile(join(fixture.workspace, "README.md"), "Disposable operator decision fixture\n");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await git("config", "core.hooksPath", "/dev/null");
  await git("add", ".");
  await git("commit", "-qm", "Fixture");
  const base = (await git("rev-parse", "HEAD")).trim();
  const store = new ExecutionStore(state);
  const service = new ExecutionBeads(source);
  const graph = randomUUID(),
    prefix = await service.prefix(),
    parent = `${prefix}-${graph.replaceAll("-", "")}`;
  const question = "Which accepted marker should decision.txt contain?",
    secondQuestion = "Confirm that the marker stays inside decision.txt?";
  const answer = "operator chosen",
    secondAnswer = "yes, inside decision.txt";
  const overlapIds: string[] = [];
  let workerQuestions = 0,
    workerAfterAnswer = 0,
    correctionRejections = 0,
    providerError: unknown;
  let releaseFinal: (() => void) | undefined;
  const finalGate = new Promise<void>((resolve) => {
    releaseFinal = resolve;
  });
  const requests: { model: string; messages: unknown }[] = [];
  const server = createServer((incoming, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of incoming) body += String(chunk);
      const request = z
        .object({
          model: z.enum(AgentRole),
          messages: z.array(
            z.looseObject({
              role: z.string(),
              content: z.unknown().optional(),
            }),
          ),
        })
        .parse(JSON.parse(body));
      requests.push(request);
      const prompt = request.messages
        .filter((message) => message.role === "user")
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : z
                .array(z.object({ text: z.string() }))
                .parse(message.content)
                .map((part) => part.text)
                .join("\n"),
        )
        .join("\n");
      const conversation = JSON.stringify(request.messages),
        tools = request.messages.filter((message) => message.role === "tool");
      let text = "",
        call: { name: string; arguments: string } | undefined;
      if (request.model === AgentRole.Worker) {
        if (conversation.includes("Decision marker")) {
          if (!prompt.includes(`"answer":"${answer}"`)) {
            workerQuestions++;
            text = JSON.stringify({ operatorDecision: { question } });
          } else if (
            !prompt.includes(`"answer":"${secondAnswer}"`) &&
            prompt.includes("Confirm the scoped marker before accepting this revision")
          ) {
            workerQuestions++;
            text = JSON.stringify({
              operatorDecision: { question: secondQuestion },
            });
          } else {
            if (prompt.includes(`"answer":"${secondAnswer}"`)) {
              workerAfterAnswer++;
              await finalGate;
            }
            if (tools.length === 0)
              call = {
                name: "write",
                arguments: JSON.stringify({
                  path: "decision.txt",
                  content: `${answer}\n`,
                }),
              };
            else
              text = JSON.stringify({
                summary: "Used the scoped operator answer in decision.txt",
              });
          }
        } else {
          assert.equal(
            store.attempts().find((row) => row.bead?.id === `${parent}.ask`)?.phase,
            ExecutionPhase.Complete,
            "Overlapping work was admitted before normal completion",
          );
          text = JSON.stringify({ summary: "Retained accepted marker" });
        }
      } else {
        assert.equal(request.model, AgentRole.Reviewer);
        if (tools.length === 0) {
          assert.ok(!conversation.includes("Used the scoped operator answer"));
          assert.ok(conversation.includes('exitCode\\":0') || conversation.includes('exitCode":0'));
          call = {
            name: "read",
            arguments: JSON.stringify({ path: "decision.txt" }),
          };
        } else if (tools.length === 1) {
          assert.ok(JSON.stringify(tools).includes(answer));
          call = {
            name: "review_context",
            arguments: JSON.stringify({
              behavior: "decision.txt contains the accepted marker",
              changeSite: "The first line of decision.txt",
            }),
          };
        } else if (correctionRejections === 0) {
          correctionRejections++;
          text = JSON.stringify({
            approved: false,
            repairableInScope: true,
            summary: "Confirm the scoped marker before accepting this revision",
          });
        } else
          text = JSON.stringify({
            approved: true,
            summary: "Read the exact verified marker revision",
          });
      }
      const delta = !call
        ? { role: "assistant", content: text }
        : {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: randomUUID(),
                type: "function",
                function: call,
              },
            ],
          };
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const [part, finish] of [
        [delta, null],
        [{}, !call ? "stop" : "tool_calls"],
      ])
        response.write(
          `data: ${JSON.stringify({ id: randomUUID(), object: "chat.completion.chunk", created: 1, model: request.model, choices: [{ index: 0, delta: part, finish_reason: finish }] })}\n\n`,
        );
      response.end("data: [DONE]\n\n");
    })().catch((error: unknown) => {
      providerError = error;
      response.writeHead(500).end();
    });
  });
  let supervisor: ReturnType<typeof spawn> | undefined,
    diagnostics = "";
  const start = () => {
    supervisor = spawn(join(root, "scripts/studio"), ["runtime", "serve"], {
      cwd: fixture.workspace,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    supervisor.stdout?.on("data", (chunk: Buffer) => {
      diagnostics += chunk.toString();
    });
    supervisor.stderr?.on("data", (chunk: Buffer) => {
      diagnostics += chunk.toString();
    });
  };
  const stop = async () => {
    if (supervisor?.pid !== undefined && supervisor.exitCode === null && supervisor.signalCode === null) {
      supervisor.kill("SIGTERM");
      await once(supervisor, "close");
    }
  };
  const wait = async (label: string, predicate: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + (process.env["CI"] === "true" ? 120000 : 60000);
    while (Date.now() < deadline) {
      if (providerError !== undefined)
        throw providerError instanceof Error
          ? providerError
          : new Error("Native fixture provider returned a non-error failure");
      const failed = store
        .attempts()
        .find(
          (row) => row.bead !== undefined && row.phase === ExecutionPhase.Parked && pendingDecision(row) === undefined,
        );
      if (failed) throw new Error(`${label}: ${failed.message}`);
      if (await predicate()) return;
      await delay(100);
    }
    throw new Error(`${label}\n${diagnostics}`);
  };
  const attempt = () => store.attempts().find((row) => row.bead?.id === `${parent}.ask`);
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    await writeFile(
      join(agent, "models.json"),
      JSON.stringify({
        providers: {
          "openai-codex": {
            baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
            api: "openai-completions",
            apiKey: "fixture",
            models: Object.values(AgentRole).map((id) => ({
              id,
              reasoning: true,
            })),
          },
          fixture: {
            baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
            api: "openai-completions",
            apiKey: "fixture",
            models: [{ id: "tiny" }],
          },
        },
      }),
    );
    const context = z
      .object({ database: z.string() })
      .parse(JSON.parse((await fixture.command(["context", "--json"])).stdout));
    const project = {
      id: source.projectId,
      root: fixture.workspace,
      source,
      base,
      merge: false,
      verificationReadPaths: [],
      beadsWorkspace: fixture.workspace,
      beadsExecutable: options.bd,
      beadsDatabase: context.database,
    };
    const config = {
      beadsService: source,
      runtime: {
        enabled: true,
        pollMs: 1000,
        concurrency: 1,
        projects: [{ ...project, id: undefined }],
      },
      integrations: { worktrees: { enabled: true, executable: "worktree" } },
      profile: Object.fromEntries(
        Object.values(AgentRole).map((role) => [
          role,
          {
            provider: "openai-codex",
            model: role,
            reasoning: ReasoningLevel.Low,
          },
        ]),
      ),
    };
    await writeFile(configFile, JSON.stringify(config));
    await run(process.execPath, [join(root, "scripts/prepare-delegation.mjs")], {
      cwd: root,
      env,
    });
    store.enroll({ ...project, profileDigest: profileDigest(await loadConfig(configFile)) });
    const enrolled = store.project(project.id);
    const configured = (await loadConfig(configFile)).runtime.projects[0];
    assert.ok(configured !== undefined);
    assert.deepEqual(
      {
        ...configured,
        id: project.id,
        root: enrolled.root,
        merge: enrolled.merge,
        profileDigest: enrolled.profileDigest,
      },
      enrolled,
      "Fixture enrollment must match actual scheduler configuration",
    );
    const draft = draftSchema.parse({
      summary: "Real operator decision",
      tasks: [
        {
          key: "ask",
          title: "Decision marker",
          description: "Ask the operator before writing the marker",
          acceptance: "decision.txt contains the operator chosen marker",
          owns: ["decision.txt"],
          check: [
            process.execPath,
            "-e",
            'if(await Bun.file("decision.txt").text()!=="operator chosen\\n")process.exit(42);console.log("DECISION_VERIFIED")',
          ],
        },
      ],
    });
    await service.createGraph(graph, planDigest(draft), "Operator decision", draft, {
      root: parent,
      ask: `${parent}.ask`,
    });
    assert.equal((await fixture.command(["update", `${parent}.ask`, "--priority", "0"])).code, 0);
    // Separate approved graphs deliberately overlap; a single draft rejects same-wave overlaps.
    for (const [key, priority] of [
      ["one", "1"],
      ["two", "2"],
    ] as const) {
      const graphId = randomUUID(),
        rootId = `${prefix}-${graphId.replaceAll("-", "")}`,
        beadId = `${rootId}.${key}`;
      const overlap = draftSchema.parse({
        summary: `Queued overlap ${key}`,
        tasks: [
          {
            key,
            title: `Overlap ${key}`,
            description: "Retain marker",
            acceptance: "File exists",
            owns: key === "one" ? ["decision.txt"] : [],
            check: [process.execPath, "-e", 'if(!(await Bun.file("decision.txt").exists()))process.exit(42)'],
          },
        ],
      });
      await service.createGraph(graphId, planDigest(overlap), `Queued overlap ${key}`, overlap, {
        root: rootId,
        [key]: beadId,
      });
      overlapIds.push(beadId);
      assert.equal((await fixture.command(["update", beadId, "--priority", priority])).code, 0);
    }
    start();
    await wait("No real worker decision", () => attempt()?.phase === ExecutionPhase.AwaitingDecision);
    const first = attempt();
    assert.ok(first !== undefined);
    const initialQuestion = pendingDecision(first);
    assert.ok(initialQuestion !== undefined);
    await wait("Writer did not settle", async () => !(await retryWriterFence(store.attempt(first.id))));
    assert.equal(first.verification, undefined);
    assert.equal(first.head, undefined);
    assert.equal(workerQuestions, 1);
    await wait(
      "Overlaps were not queued",
      () =>
        store
          .attempts()
          .filter((row) => overlapIds.includes(row.bead?.id ?? ""))
          .every((row) => row.phase === ExecutionPhase.Queued) &&
        store.attempts().filter((row) => overlapIds.includes(row.bead?.id ?? "")).length === 2,
    );
    await stop();
    start();
    await wait("Supervisor did not restore", () => store.supervisor()?.pid === supervisor?.pid);
    await delay(1500);
    const restored = store.attempt(first.id);
    assert.deepEqual(restored.operatorDecisions, first.operatorDecisions);
    assert.deepEqual(restored.checkout, first.checkout);
    assert.equal(restored.launchToken, first.launchToken);
    assert.equal(workerQuestions, 1);
    await assert.rejects(
      run(join(root, "scripts/studio"), ["runtime", "retry", first.id], {
        cwd: fixture.workspace,
        env,
      }),
      /operator decision is pending/u,
    );
    const input = join(options.output, "ui-input.json");
    await writeFile(
      input,
      JSON.stringify({
        project: fixture.workspace,
        env: Object.fromEntries(
          [
            "HOME",
            "PATH",
            "LANG",
            "LC_ALL",
            "LC_CTYPE",
            "TERM",
            "COLORTERM",
            "PI_CODING_AGENT_DIR",
            "STUDIO_CONFIG",
            "STUDIO_STATE_DIR",
            "PI_SKIP_VERSION_CHECK",
            "PI_TELEMETRY",
            "GIT_CONFIG_GLOBAL",
            "GIT_CONFIG_NOSYSTEM",
            "XDG_STATE_HOME",
            "XDG_CONFIG_HOME",
          ].flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]])),
        ),
        source,
        task: `${parent}.ask`,
        question,
        answer,
      }),
    );
    await run(
      "uv",
      [
        "run",
        "--script",
        join(root, "acceptance/operator-decision-ui.py"),
        "--input",
        input,
        "--output",
        options.output,
      ],
      {
        cwd: root,
        env: {
          ...env,
          UV_PYTHON_DOWNLOADS: "never",
          UV_CACHE_DIR: process.env["UV_CACHE_DIR"] ?? join(homedir(), ".cache", "uv"),
        },
        timeout: 90000,
      },
    );
    await wait("No second real decision", () => pendingDecision(store.attempt(first.id))?.question === secondQuestion);
    await wait("Second question writer did not settle", async () => !(await retryWriterFence(store.attempt(first.id))));
    const second = store.attempt(first.id);
    const secondRequest = pendingDecision(second);
    assert.ok(secondRequest !== undefined);
    assert.notEqual(secondRequest.id, initialQuestion.id);
    assert.equal(correctionRejections, 1);
    assert.match(second.reviewFinding ?? "", /Confirm the scoped marker/u);
    assert.equal(second.verification?.exitCode, 0);
    assert.equal(second.review, undefined);
    await assert.rejects(
      run(join(root, "scripts/studio"), ["runtime", "answer", first.id, initialQuestion.id, "--text", answer], {
        cwd: fixture.workspace,
        env,
      }),
      /stale or superseded/u,
    );
    const lost = spawn(
      join(root, "scripts/studio"),
      ["runtime", "answer", first.id, secondRequest.id, "--text", secondAnswer],
      { cwd: fixture.workspace, env, stdio: ["ignore", "ignore", "pipe"] },
    );
    let errors = "";
    lost.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    const [exit] = z.tuple([z.number().nullable(), z.string().nullable()]).parse(await once(lost, "exit"));
    assert.equal(exit, 0, errors);
    await wait("Answer was not consumed", () => workerAfterAnswer > 0);
    const answered = store.attempt(first.id);
    const replay: unknown = JSON.parse(
      await run(
        join(root, "scripts/studio"),
        ["runtime", "answer", first.id, secondRequest.id, "--text", secondAnswer],
        { cwd: fixture.workspace, env },
      ),
    );
    assert.equal(z.object({ request: z.string() }).parse(replay).request, secondRequest.id);
    assert.deepEqual(store.attempt(first.id), answered);
    await assert.rejects(
      run(join(root, "scripts/studio"), ["runtime", "answer", first.id, secondRequest.id, "--text", "conflict"], {
        cwd: fixture.workspace,
        env,
      }),
      /different answer/u,
    );
    assert.equal(store.attempts().filter((row) => row.bead?.id === `${parent}.ask`).length, 1);
    assert.deepEqual(answered.checkout, first.checkout);
    releaseFinal?.();
    await wait(
      "Answer did not pass verifier/review and close",
      () => store.attempt(first.id).phase === ExecutionPhase.Complete,
    );
    const complete = store.attempt(first.id);
    assert.equal(complete.verification?.exitCode, 0);
    assert.match(complete.verification.output, /DECISION_VERIFIED/u);
    assert.ok(complete.review !== undefined);
    assert.ok(complete.operatorDecisions !== undefined);
    assert.equal(complete.operatorDecisions.length, 2);
    assert.ok(complete.operatorDecisions.every((entry) => entry.appliedHead === complete.head));
    assert.equal((await service.get(`${parent}.ask`)).status, "closed");
    await wait("Overlaps did not complete after normal closure", () =>
      store
        .attempts()
        .filter((row) => overlapIds.includes(row.bead?.id ?? ""))
        .every((row) => row.phase === ExecutionPhase.Complete),
    );
    await writeFile(
      join(options.output, "proof.json"),
      JSON.stringify(
        {
          first,
          restored,
          second,
          answered,
          complete,
          workerQuestions,
          restartNoExtraWorker: true,
          sameAttemptAndCheckout: true,
          lostAnswerAcknowledgementReplayed: true,
          overlapsFencedUntilClosure: true,
          verification: 0,
          independentReview: true,
          repairableReviewRejectionThenQuestion: true,
        },
        null,
        2,
      ),
    );
    console.log(
      "Real background operator questions, native /tasks answer, restart retention, lost-answer-ACK replay, same attempt/checkout, queued overlaps, original verification, independent review and closure passed.",
    );
  } finally {
    releaseFinal?.();
    await stop();
    await writeFile(join(options.output, "supervisor.log"), diagnostics);
    await writeFile(join(options.output, "provider-requests.json"), JSON.stringify(requests, null, 2));
    const hosts = [];
    for (const record of store.attempts()) {
      if (
        record.pid !== undefined &&
        record.started !== undefined &&
        (await processMatchesStart(record.pid, record.started))
      ) {
        try {
          process.kill(-record.pid, "SIGTERM");
        } catch {
          /* This owned host may have finished. */
        }
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && (await processMatchesStart(record.pid, record.started))) await delay(20);
        const exited = !(await processMatchesStart(record.pid, record.started));
        if (!exited) process.kill(-record.pid, "SIGKILL");
        hosts.push({
          attempt: record.id,
          pid: record.pid,
          started: record.started,
          exited,
        });
      }
    }
    await writeFile(
      join(options.output, "cleanup.json"),
      JSON.stringify({
        fixture: fixture.directory,
        hosts,
        supervisorStopped: true,
      }),
    );
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    await writeFile(
      join(options.output, "final-status.json"),
      JSON.stringify(
        {
          supervisor: store.supervisor(),
          projects: store.projects(),
          attempts: store.attempts(),
        },
        null,
        2,
      ),
    );
    store.close();
    await rm(state, { recursive: true, force: true });
  }
});
