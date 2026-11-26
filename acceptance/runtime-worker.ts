import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, readFile, writeFile, rename } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { z } from "zod";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { fixtureMetricsEnv } from "./beads-fixture.ts";
import { withBeadsHttp } from "./beads-http-fixture.ts";
import { AgentRole, StudioProfile, ReasoningLevel, ModelCapability, DefaultProvider } from "../config.ts";
import { ExecutionBeads } from "../execution/beads.ts";
import { ExecutionStore, ExecutionPhase } from "../execution/store.ts";
import { draftSchema, planDigest } from "../lead-plan.ts";
import { run } from "../process.ts";
import { parkedDetails, retainedEvidence } from "../tasks/model.ts";
import { retryWriterFence } from "../execution/recovery.ts";
import { safeGit } from "../execution/git.ts";
import { alive } from "../execution/supervisor.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const fastModel = "fast-worker";
const program = new Command()
  .requiredOption("--bd <path>")
  .requiredOption("--dolt <path>")
  .option("--recovery-output <directory>", "Keep guarded-retry receipts and native terminal captures");
program.parse();
const options = program.opts<{
  bd: string;
  dolt: string;
  recoveryOutput?: string;
}>();
await withBeadsHttp(options.bd, options.dolt, async (fixture, source) => {
  const agent = join(fixture.directory, "agent");
  // Darwin activation sockets must fit sockaddr_un, including the per-session suffix.
  const state = await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : fixture.directory, "st-recovery-"));
  const configFile = join(fixture.directory, "runtime.json");
  await mkdir(agent);
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(GIT_|PI_|WORKTREE_|BEADS_|BD_|DOLT_|STUDIO_)/u.test(key)),
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
    XDG_STATE_HOME: join(fixture.directory, "xdg-state"),
    XDG_CONFIG_HOME: join(fixture.directory, "xdg-config"),
  };
  const git = (...args: string[]) => run("git", args, { cwd: fixture.workspace, env });
  await writeFile(join(fixture.workspace, ".gitignore"), ".worktrees/\n.beads/\n");
  await writeFile(join(fixture.workspace, "README.md"), "Runtime fixture\n");
  await writeFile(join(fixture.workspace, "rejected.txt"), "Prior tracked result\n");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await git("config", "core.hooksPath", "/dev/null");
  await git("add", ".");
  await git("commit", "-qm", "Fixture");
  const base = (await git("rev-parse", "HEAD")).trim();
  const requests: string[] = [];
  // Hosted runners may still be verifying accepted work after the local one-minute budget.
  const completionMs = process.env["CI"] === "true" ? 180000 : 60000;
  let deadline: number | undefined;
  let release: (() => void) | undefined;
  const waitForLeadExit = new Promise<void>((resolve) => {
    release = () => {
      deadline ??= Date.now() + completionMs;
      resolve();
    };
  });
  let sawWorker: (() => void) | undefined;
  const workerStarted = new Promise<void>((resolve) => {
    sawWorker = resolve;
  });
  // Keep the first writer live until a later nonconflicting assignment passes independent review.
  let releaseFirst: (() => void) | undefined;
  const unrelatedReviewed = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let releaseOverlap: (() => void) | undefined;
  const successorStarted = new Promise<void>((resolve) => {
    releaseOverlap = resolve;
  });
  let releaseSecond: (() => void) | undefined;
  const overlapIntegrated = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  let sawConcurrentReview = false;
  let sawOverlapAfterCompletion = false;
  const readabilityFinding =
    "consume.ts:1 — flag hides which state permits consumption. A caller changing the acceptance rule has to guess what true means.";
  const integrationFinding =
    "consume.ts:2 — the integrated prerequisite can span lines. Clarify whether the prefix belongs to the whole prerequisite or each line.";
  const workerNarrative = "fixture-author-walkthrough";
  let unrelatedWrites = 0;
  let rejectedSecondHead: string | undefined;
  let approvedSecondHead: string | undefined;
  let rejectedIntegration: string | undefined;
  let correctedIntegration: string | undefined;
  let providerError: unknown;
  let repairRejected = false;
  const server = createServer((incoming, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of incoming) body += String(chunk);
      const request = z
        .object({
          model: z.union([z.enum(AgentRole), z.literal(fastModel)]),
          reasoning_effort: z.enum(ReasoningLevel).optional(),
          messages: z.array(
            z.looseObject({
              role: z.string(),
              content: z.unknown().optional(),
              tool_call_id: z.string().optional(),
            }),
          ),
        })
        .parse(JSON.parse(body));
      requests.push(request.model);
      const conversation = JSON.stringify(request.messages);
      const kind =
        conversation.includes("Recovery overlap") || conversation.includes("Blocked by rejected verification")
          ? "recovery-overlap"
          : conversation.includes("Deliberate verifier rejection")
            ? "rejected"
            : conversation.includes("Consume prerequisite")
              ? "second"
              : conversation.includes("Overlap ownership")
                ? "overlap"
                : conversation.includes("Progress unrelated")
                  ? "third"
                  : "first";
      const path =
        kind === "rejected"
          ? "rejected.txt"
          : kind === "second"
            ? "consume.ts"
            : kind === "third"
              ? "third.txt"
              : "first.txt";
      const content =
        kind === "rejected" && repairRejected
          ? "corrected prerequisite\n"
          : kind === "third"
            ? "unrelated verified progress\n"
            : kind === "overlap"
              ? "verified prerequisite\noverlap completed\n"
              : "verified prerequisite\n";
      const toolMessages = request.messages.filter((message) => message.role === "tool");
      let call: { name: string; arguments: string } | undefined;
      let text = "";
      if (request.model === AgentRole.Worker || request.model === fastModel) {
        assert.equal(request.model, kind === "first" ? fastModel : AgentRole.Worker);
        assert.equal(
          request.reasoning_effort,
          kind === "first" ? ReasoningLevel.Medium : kind === "second" ? ReasoningLevel.High : ReasoningLevel.Low,
          `Worker reasoning for ${kind}`,
        );
        if (kind === "recovery-overlap") {
          assert(
            store
              .attempts()
              .some(
                (row) => row.bead?.title === "Deliberate verifier rejection" && row.phase === ExecutionPhase.Complete,
              ),
            "Queued ownership must stay fenced until retry completes verification/review",
          );
          await new Promise<void>(() => {});
        }
        if (kind === "first") sawWorker?.();
        await waitForLeadExit;
        if (kind === "first") await unrelatedReviewed;
        if (kind === "second") {
          releaseOverlap?.();
          await overlapIntegrated;
        }
        if (kind === "overlap") {
          const first = store.attempts().find((row) => row.bead?.id === `${parent}.first`);
          assert.equal(
            first?.phase,
            ExecutionPhase.Complete,
            "Overlapping ownership must wait for the prior writer to finish",
          );
          sawOverlapAfterCompletion = true;
          await successorStarted;
        }
        if (kind === "second" && toolMessages.length === 0)
          call = {
            name: "read",
            arguments: JSON.stringify({ path: "first.txt" }),
          };
        else if ((kind !== "second" && toolMessages.length === 0) || (kind === "second" && toolMessages.length === 1)) {
          let updatedContent = content;
          if (kind === "third") unrelatedWrites++;
          if (kind === "second") {
            assert.match(
              JSON.stringify(toolMessages),
              /verified prerequisite/u,
              "Successor did not receive predecessor code",
            );
            const finding = [readabilityFinding, integrationFinding].find((item) => conversation.includes(item));
            if (finding !== undefined) {
              const attempt = store.attempts().find((row) => row.bead?.id === `${parent}.second`);
              assert(attempt !== undefined);
              assert.deepEqual(
                attempt.reviewFeedback,
                [finding],
                "The correction must retain the original finding on the same attempt",
              );
              assert.equal(attempt.reviewFinding, finding, "The task panel must be able to show the actionable repair");
            }
            const flag = finding === undefined ? "flag" : "accepted";
            updatedContent = `export function consume(prerequisite: string, ${flag}: boolean) {\n  return ${flag} ? "consumed " + prerequisite : prerequisite;\n}\n`;
            if (finding === integrationFinding)
              updatedContent = "// Prefix the whole prerequisite once, even when it spans lines.\n" + updatedContent;
          }
          call = {
            name: "write",
            arguments: JSON.stringify({ path, content: updatedContent }),
          };
        } else
          text = JSON.stringify({
            summary: `${workerNarrative}-summary`,
            // Unused publication fields must not block local verification and review.
            title: "",
            body: null,
          });
      } else if (request.model === AgentRole.Reviewer) {
        assert.equal(request.reasoning_effort, ReasoningLevel.Low);
        const inspectIntegratedInput = kind === "second" && approvedSecondHead !== undefined;
        const readCount = inspectIntegratedInput ? 2 : 1;
        if (toolMessages.length <= readCount) {
          assert(!conversation.includes(workerNarrative), "The cold read included the author's walkthrough");
          assert(
            !conversation.includes(readabilityFinding) && !conversation.includes(integrationFinding),
            "Earlier feedback leaked into a fresh cold read",
          );
          if (kind === "second")
            assert(
              conversation.includes("behavior verified in both states"),
              "The reviewer did not receive the actual verifier output",
            );
        }
        if (toolMessages.length === 0) call = { name: "read", arguments: JSON.stringify({ path }) };
        else if (inspectIntegratedInput && toolMessages.length === 1)
          call = {
            name: "read",
            arguments: JSON.stringify({ path: "first.txt" }),
          };
        else if (toolMessages.length === readCount) {
          if (inspectIntegratedInput) assert.match(JSON.stringify(toolMessages[1]?.content), /overlap completed/u);
          assert.match(
            JSON.stringify(toolMessages),
            kind === "second"
              ? /function consume/u
              : kind === "third"
                ? /unrelated verified progress/u
                : kind === "rejected"
                  ? /corrected prerequisite/u
                  : /verified prerequisite/u,
          );
          call = {
            name: "review_context",
            arguments: JSON.stringify({
              behavior:
                kind === "second"
                  ? "consume.ts:1 prefixes the prerequisite when the second argument is true."
                  : `${path}:1 contains the expected prerequisite or progress record.`,
              changeSite:
                kind === "second"
                  ? "consume.ts:2 selects which state consumes the prerequisite."
                  : `Change the record in ${path}:1.`,
            }),
          };
        } else {
          if (kind === "third") {
            const first = store.attempts().find((row) => row.bead?.id === `${parent}.first`);
            const overlap = store.attempts().find((row) => row.bead?.id === `${parent}.overlap`);
            assert.equal(
              first?.phase,
              ExecutionPhase.Running,
              "Unrelated review must make progress while the first worker is held",
            );
            assert(overlap !== undefined);
            assert.equal(
              overlap.phase,
              ExecutionPhase.Queued,
              "Conflicting higher-priority work must have been admitted before unrelated work",
            );
            assert.equal(
              overlap.launchToken,
              undefined,
              "Conflicting assignment must remain queued while unrelated work progresses",
            );
            sawConcurrentReview = true;
            releaseFirst?.();
          }
          text = JSON.stringify({
            approved: true,
            summary: "Independent fixture review read the exact committed task result",
          });
          if (kind === "second" && approvedSecondHead === undefined) {
            assert(
              conversation.includes(workerNarrative),
              "The review context did not reveal the worker report after the cold read",
            );
            const candidate = store.attempts().find((row) => row.bead?.id === `${parent}.second`);
            assert(candidate?.head !== undefined);
            assert(conversation.includes(candidate.head), "The worker revision is missing from the review");
            const implementation = JSON.stringify(toolMessages[0]?.content);
            if (implementation.includes("flag: boolean")) {
              assert.equal(
                rejectedSecondHead,
                undefined,
                "A rejected candidate was reviewed again without being repaired",
              );
              rejectedSecondHead = candidate.head;
              text = JSON.stringify({
                approved: false,
                summary: readabilityFinding,
              });
            } else {
              assert.match(implementation, /accepted: boolean/u);
              assert(rejectedSecondHead !== undefined);
              assert(
                conversation.includes(readabilityFinding),
                "The correction review did not receive the original feedback for disposition",
              );
              approvedSecondHead = candidate.head;
              assert.notEqual(approvedSecondHead, rejectedSecondHead);
            }
          } else if (inspectIntegratedInput) {
            const candidate = store.attempts().find((row) => row.bead?.id === `${parent}.second`);
            assert(candidate?.checkout !== undefined);
            const revision = (
              await run("git", ["rev-parse", "HEAD"], {
                cwd: candidate.checkout.path,
                env,
              })
            ).trim();
            assert(conversation.includes(revision));
            if (rejectedIntegration === undefined) {
              assert.notEqual(revision, approvedSecondHead);
              rejectedIntegration = revision;
              text = JSON.stringify({
                approved: false,
                repairableInScope: true,
                summary: integrationFinding,
              });
            } else {
              assert.match(JSON.stringify(toolMessages[0]?.content), /Prefix the whole prerequisite once/u);
              assert(conversation.includes(integrationFinding));
              assert.notEqual(revision, rejectedIntegration);
              correctedIntegration = revision;
            }
          }
        }
      } else throw new Error(`Unexpected inference in free/control lead: ${request.model}`);
      const delta = !call
        ? { role: "assistant", content: text }
        : {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${request.model}_${String(toolMessages.length)}`,
                type: "function",
                function: call,
              },
            ],
          };
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason: !call ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
      );
    })().catch((error: unknown) => {
      providerError = error;
      response.writeHead(500).end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  await writeFile(
    join(agent, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
          api: "openai-completions",
          apiKey: "fixture",
          models: [{ id: "tiny" }],
        },
        "openai-codex": {
          baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
          api: "openai-completions",
          apiKey: "fixture",
          models: [...Object.values(AgentRole), fastModel].map((id) => ({
            id,
            reasoning: true,
            compat: { supportsReasoningEffort: true },
          })),
        },
      },
    }),
  );
  const context = z
    .object({ database: z.string() })
    .parse(JSON.parse((await fixture.command(["context", "--json"])).stdout));
  let supervisor: ReturnType<typeof spawn> | undefined;
  let crashedAttempt: string | undefined;
  let crashedSession: string | undefined;
  let crashError: unknown;
  let crashDone: (() => void) | undefined;
  const crashed = new Promise<void>((resolve) => {
    crashDone = resolve;
  });
  let claimRequests = 0;
  let interruptedActor: string | undefined;
  let interruptedReadRequests = 0;
  const claimActors = new Map<string, number>();
  let noteInterruptedClaim: (() => void) | undefined;
  const interruptedClaimReady = new Promise<void>((resolve) => {
    noteInterruptedClaim = resolve;
  });
  let releaseInterruptedClaim: (() => void) | undefined;
  const interruptedClaimResponse = new Promise<void>((resolve) => {
    releaseInterruptedClaim = resolve;
  });
  const proxy = createServer((incoming, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of incoming) body += String(chunk);
      const requestUrl = new URL(incoming.url ?? "/", source.url);
      const claim = z
        .object({
          actor: z.string(),
          expected_status: z.literal("open"),
          expected_assignee: z.literal(""),
          patch: z.object({
            status: z.literal("in_progress"),
            assignee: z.string(),
            metadata: z.object({
              merge: z.object({ "pi.attempt": z.string() }),
            }),
          }),
        })
        .safeParse(incoming.method === "PATCH" ? JSON.parse(body) : undefined);
      if (claim.success) {
        const actor = claim.data.actor;
        assert.equal(claim.data.patch.assignee, actor);
        assert.equal(actor, `pi:${claim.data.patch.metadata.merge["pi.attempt"]}`);
        claimRequests++;
        claimActors.set(actor, (claimActors.get(actor) ?? 0) + 1);
      }
      const completion =
        incoming.method === "PATCH" && incoming.url?.endsWith(".first") === true && body.includes('"status":"closed"');
      if (completion && crashedAttempt === undefined) {
        await interruptedClaimReady;
        assert(interruptedActor !== undefined);
        assert.equal(
          store.attempt(interruptedActor.slice(3)).phase,
          ExecutionPhase.Claiming,
          "Fault boundary must interrupt the observed unbound claim intent",
        );
        const attempt = store.attempts().find((row) => row.bead?.id === `${parent}.first`);
        assert(attempt?.integration !== undefined && attempt.resultRef !== undefined && attempt.pid !== undefined);
        assert(supervisor?.pid !== undefined);
        assert.equal((await service.get(`${parent}.first`)).status, "in_progress");
        crashedAttempt = attempt.id;
        crashedSession = attempt.controllerSession;
        assert(crashedSession !== undefined);
        const stopped = once(supervisor, "close");
        const schedulerPid = supervisor.pid;
        // Interrupt the durable admission intent while its empty ready read is in flight.
        process.kill(-schedulerPid, "SIGKILL");
        process.kill(-attempt.pid, "SIGKILL");
        await stopped;
        response.destroy();
        releaseInterruptedClaim?.();
        crashDone?.();
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers))
        if (value !== undefined && name !== "host" && name !== "connection" && name !== "content-length")
          headers.set(name, Array.isArray(value) ? value.join(",") : value);
      const forwarded = await fetch(`${source.url}${incoming.url ?? "/"}`, {
        method: incoming.method ?? "GET",
        headers,
        ...(body.length === 0 ? {} : { body }),
      });
      const payload = await forwarded.text();
      if (
        incoming.method === "GET" &&
        requestUrl.pathname === "/v0/beads/ready" &&
        requestUrl.searchParams.getAll("exclude_type").includes("epic") &&
        interruptedActor === undefined &&
        forwarded.ok &&
        z.object({ items: z.array(z.unknown()) }).parse(JSON.parse(payload)).items.length === 0
      ) {
        // Ready reads carry no actor. Bind this read to the single persisted,
        // unbound admission intent before interrupting the scheduler.
        const pending = store
          .attempts()
          .filter((attempt) => attempt.phase === ExecutionPhase.Claiming && attempt.bead === undefined);
        assert.equal(pending.length, 1, "An empty admission read must identify one durable intent");
        const intent = pending[0];
        assert(intent !== undefined);
        interruptedActor = `pi:${intent.id}`;
        interruptedReadRequests++;
        noteInterruptedClaim?.();
        await interruptedClaimResponse;
      }
      if (
        forwarded.ok &&
        incoming.method === "PATCH" &&
        incoming.url?.endsWith(".overlap") === true &&
        body.includes('"status":"closed"')
      )
        releaseSecond?.();
      response.writeHead(forwarded.status, {
        "Content-Type": "application/json",
      });
      response.end(payload);
    })().catch((error: unknown) => {
      crashError = error;
      response.writeHead(500).end();
      crashDone?.();
    });
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const proxyAddress = proxy.address();
  assert(proxyAddress !== null && typeof proxyAddress !== "string");
  const project = {
    id: source.projectId,
    root: fixture.workspace,
    source: { ...source, url: `http://127.0.0.1:${String(proxyAddress.port)}` },
    profile: StudioProfile.Personal,
    base,
    merge: false,
    verificationReadPaths: [],
    beadsWorkspace: fixture.workspace,
    beadsExecutable: options.bd,
    beadsDatabase: context.database,
  };
  const runtimeConfig = {
    beadsService: project.source,
    runtime: {
      enabled: true,
      pollMs: 1000,
      projects: [{ ...project, id: undefined }],
    },
    integrations: { worktrees: { enabled: true, executable: "worktree" } },
    profiles: {
      personal: {
        ...Object.fromEntries(
          Object.values(AgentRole).map((role) => [
            role,
            {
              provider: DefaultProvider.ChatGPTSubscription,
              model: role,
              reasoning: ReasoningLevel.Low,
            },
          ]),
        ),
        workerModels: {
          fast: {
            provider: DefaultProvider.ChatGPTSubscription,
            model: fastModel,
          },
        },
      },
    },
  };
  runtimeConfig.integrations.worktrees.enabled = false;
  const saveConfig = async () => {
    const temporary = `${configFile}.next`;
    await writeFile(temporary, JSON.stringify(runtimeConfig));
    await rename(temporary, configFile);
  };
  await saveConfig();
  await run(process.execPath, [join(root, "scripts/prepare-delegation.mjs")], {
    cwd: root,
    env,
  });
  const graph = randomUUID();
  const service = new ExecutionBeads(source);
  const prefix = await service.prefix();
  const parent = `${prefix}-${graph.replaceAll("-", "")}`;
  const draft = draftSchema.parse({
    summary: "Unattended dependency fixture",
    tasks: [
      {
        key: "first",
        title: "Produce prerequisite",
        description: "Produce prerequisite",
        acceptance: "first.txt contains verified prerequisite",
        assignment: {
          capability: ModelCapability.Fast,
          reasoning: ReasoningLevel.Medium,
        },
        owns: ["first.txt"],
        check: [
          process.execPath,
          "-e",
          'if(await Bun.file("first.txt").text()!=="verified prerequisite\\n")process.exit(1)',
        ],
      },
      {
        key: "second",
        title: "Consume prerequisite",
        description: "Consume prerequisite",
        acceptance:
          "Read first.txt. Export consume(prerequisite, accepted) from consume.ts. Prefix accepted inputs with 'consumed ' and return other inputs unchanged.",
        owns: ["consume.ts"],
        assignment: {
          capability: ModelCapability.Standard,
          reasoning: ReasoningLevel.High,
        },
        blockedBy: ["first"],
        check: [
          process.execPath,
          "-e",
          'const {consume}=await import("./consume.ts"); const input=await Bun.file("first.txt").text(); if(consume(input,true)!=="consumed "+input || consume(input,false)!==input)process.exit(1); console.log(["behavior verified","in both states"].join(" "))',
        ],
      },
      {
        key: "third",
        title: "Progress unrelated",
        description: "Progress unrelated",
        acceptance: "Make independent progress while the first worker waits",
        owns: ["third.txt"],
        check: [
          process.execPath,
          "-e",
          'if(await Bun.file("third.txt").text()!=="unrelated verified progress\\n")process.exit(1)',
        ],
      },
      {
        key: "held",
        title: "Held",
        description: "Wait",
        acceptance: "Never dispatched",
        hold: true,
      },
    ],
  });
  const approvedWorkers = {
    first: {
      provider: DefaultProvider.ChatGPTSubscription,
      model: fastModel,
      reasoning: ReasoningLevel.Medium,
    },
    second: {
      provider: DefaultProvider.ChatGPTSubscription,
      model: AgentRole.Worker,
      reasoning: ReasoningLevel.High,
    },
  };
  await service.createGraph(
    graph,
    planDigest(draft),
    "Unattended acceptance",
    draft,
    {
      root: parent,
      first: `${parent}.first`,
      second: `${parent}.second`,
      third: `${parent}.third`,
      held: `${parent}.held`,
    },
    StudioProfile.Personal,
    false,
    approvedWorkers,
  );
  // Separate approved breakdowns can overlap even though each individual draft rejects same-wave overlap.
  const overlappingGraph = randomUUID();
  const overlappingRoot = `${prefix}-${overlappingGraph.replaceAll("-", "")}`;
  const overlappingDraft = draftSchema.parse({
    summary: "Separately approved overlapping work",
    tasks: [
      {
        key: "overlap",
        title: "Overlap ownership",
        description: "Overlap ownership",
        acceptance: "Wait for prior ownership then append overlap completion",
        owns: ["first.txt"],
        check: [
          process.execPath,
          "-e",
          'if(await Bun.file("first.txt").text()!=="verified prerequisite\\noverlap completed\\n")process.exit(1)',
        ],
      },
    ],
  });
  await service.createGraph(
    overlappingGraph,
    planDigest(overlappingDraft),
    "Overlapping acceptance",
    overlappingDraft,
    {
      root: overlappingRoot,
      overlap: `${parent}.overlap`,
    },
  );
  // Existing/cross-discovery Beads dependencies must receive accepted code without sharing graph metadata.
  const ungroup = await fixture.command(["update", `${parent}.first`, "--unset-metadata", "studio.graph"]);
  assert.equal(ungroup.code, 0, ungroup.stderr);
  const regroup = await fixture.command([
    "update",
    `${parent}.second`,
    "--set-metadata",
    `studio.graph=${randomUUID()}`,
  ]);
  assert.equal(regroup.code, 0, regroup.stderr);
  for (const [key, priority] of [
    ["first", "0"],
    ["overlap", "1"],
    ["third", "2"],
  ]) {
    const prioritize = await fixture.command(["update", `${parent}.${key ?? ""}`, "--priority", priority ?? "2"]);
    assert.equal(prioritize.code, 0, prioritize.stderr);
  }
  const store = new ExecutionStore(state);
  store.enroll(project);
  let diagnostics = "";
  const startSupervisor = () => {
    const child = spawn(join(root, "scripts/studio"), ["runtime", "serve"], {
      cwd: fixture.workspace,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => {
      diagnostics += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostics += chunk.toString();
    });
    supervisor = child;
  };
  startSupervisor();
  const lead = spawn(
    join(root, "scripts/studio"),
    ["lead", "--", "--mode", "rpc", "--offline", "--no-mcp", "--model", "openai-codex/lead"],
    {
      cwd: fixture.workspace,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const leadLines = createInterface({ input: lead.stdout });
  let leadErrors = "";
  lead.stderr.on("data", (chunk: Buffer) => {
    leadErrors += chunk.toString();
  });
  const timeout = setTimeout(() => {
    release?.();
  }, 30000);
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rejectedAdmission = async (reason: string) => {
      const deadline = Date.now() + 10000;
      while (!diagnostics.includes(reason)) {
        if (Date.now() > deadline) throw new Error(`Runtime did not reject unavailable integration: ${diagnostics}`);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        });
      }
      assert.equal(claimRequests, 0, "An unavailable worktree integration must not claim Beads work");
      assert.equal(store.attempts().length, 0, "Admission preflight must precede durable claim intent");
      assert.equal((await service.get(`${parent}.first`)).status, "open");
    };
    await rejectedAdmission("Enable integrations.worktrees.enabled");
    runtimeConfig.integrations.worktrees.enabled = true;
    runtimeConfig.integrations.worktrees.executable = join(fixture.directory, "missing-runtime-worktree");
    await saveConfig();
    await rejectedAdmission(`Install ${runtimeConfig.integrations.worktrees.executable}`);
    runtimeConfig.integrations.worktrees.executable = "worktree";
    await saveConfig();
    await Promise.race([
      workerStarted,
      new Promise<never>((_resolve, reject) => {
        startupTimer = setTimeout(() => {
          reject(new Error(`Worker did not start: ${diagnostics}\n${JSON.stringify(store.attempts())}`));
        }, 25000);
      }),
    ]);
    if (startupTimer) clearTimeout(startupTimer);
    const requestLead = async (command: "get_state" | "get_commands"): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const id = `free-lead-${randomUUID()}`;
        const cleanup = () => {
          clearTimeout(timer);
          leadLines.off("line", inspect);
        };
        const inspect = (line: string) => {
          try {
            const value: unknown = JSON.parse(line);
            const envelope = z.looseObject({ id: z.string().optional() }).parse(value);
            if (envelope.id !== id) return;
            const reply = z
              .object({
                id: z.literal(id),
                type: z.literal("response"),
                command: z.literal(command),
                success: z.literal(true),
                data: z.unknown(),
              })
              .parse(value);
            cleanup();
            resolve(reply.data);
          } catch (error) {
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Free lead did not respond to ${command} while worker was blocked: ${leadErrors}`));
        }, 5000);
        leadLines.on("line", inspect);
        lead.stdin.write(`${JSON.stringify({ id, type: command })}\n`);
      });
    const leadState = z
      .object({
        isStreaming: z.literal(false),
        pendingMessageCount: z.literal(0),
        model: z.looseObject({ id: z.literal(AgentRole.Lead) }),
      })
      .parse(await requestLead("get_state"));
    assert.equal(leadState.isStreaming, false);
    const leadCommands = z
      .object({ commands: z.array(z.looseObject({ name: z.string() })) })
      .parse(await requestLead("get_commands"));
    assert(
      leadCommands.commands.some((command) => command.name === "discoveries"),
      "The free lead must expose independent discovery while implementation is blocked",
    );
    assert.equal(store.attempts().find((row) => row.bead?.id === `${parent}.first`)?.phase, ExecutionPhase.Running);
    const schedulingOwner = store.supervisor();
    assert(schedulingOwner !== undefined);
    const competing = spawn(join(root, "scripts/studio"), ["runtime", "serve"], {
      cwd: fixture.workspace,
      env,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let competingError = "";
    competing.stderr.on("data", (chunk: Buffer) => {
      competingError += chunk.toString();
    });
    const competingDeadline = setTimeout(() => {
      if (competing.pid !== undefined && competing.exitCode === null && competing.signalCode === null)
        process.kill(-competing.pid, "SIGKILL");
    }, 10000);
    const competingResult: unknown[] = await once(competing, "close");
    const competingCode = z.number().nullable().parse(competingResult[0]);
    clearTimeout(competingDeadline);
    assert.notEqual(competingCode, 0, "A second supervisor must not acquire a live scheduler's project");
    assert.match(competingError, /live Studio runtime already owns scheduling/u);
    assert.equal(store.supervisor()?.id, schedulingOwner.id);
    if (lead.pid !== undefined) process.kill(-lead.pid, "SIGTERM");
    await once(lead, "close");
    release?.();
    assert(deadline !== undefined);
    let restarted = false;
    for (;;) {
      if (providerError !== undefined)
        throw providerError instanceof Error
          ? providerError
          : new Error("Fixture provider failed", { cause: providerError });
      if (crashedAttempt !== undefined && !restarted) {
        await crashed;
        assert.equal(crashError, undefined);
        assert.equal((await service.get(`${parent}.first`)).status, "in_progress");
        assert.equal(store.attempt(crashedAttempt).integration !== undefined, true);
        startSupervisor();
        restarted = true;
      }
      const attempts = store.attempts();
      const completed = attempts.filter((attempt) => attempt.phase === ExecutionPhase.Complete);
      const failed = attempts.find(
        (attempt) =>
          attempt.bead !== undefined && [ExecutionPhase.Parked, ExecutionPhase.Uncertain].includes(attempt.phase),
      );
      if (failed || Date.now() >= deadline) {
        const logs = await Promise.all(
          attempts.map((attempt) =>
            readFile(join(state, "runtime-sessions", attempt.id, "host.log"), "utf8").catch(() => ""),
          ),
        );
        throw new Error(
          `Unattended fixture ${!failed ? `timed out after ${String(completionMs)} ms` : "failed"}: ${JSON.stringify(attempts)}\n${diagnostics}\n${logs.join("\n")}\nLead: ${leadErrors}`,
        );
      }
      if (completed.length >= 4) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Let the final queue poll record its claim receipt before checking admission history.
    assert(supervisor !== undefined);
    const stopped = once(supervisor, "close", {
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    assert(supervisor.kill("SIGTERM"));
    const exit: unknown[] = await stopped;
    assert.equal(exit[0], 0, diagnostics);
    const admitted = store.attempts().filter((attempt) => attempt.bead !== undefined);
    assert.equal(admitted.length, 4, "Competing supervisors must not duplicate admission");
    assert.deepEqual(
      admitted.map((row) => row.bead?.id).sort(),
      ["first", "overlap", "second", "third"].map((key) => `${parent}.${key}`),
      "Each eligible bead must have exactly one admitted attempt",
    );
    assert(admitted.every((row) => row.phase === ExecutionPhase.Complete));
    assert(interruptedActor !== undefined);
    assert.equal(
      claimActors.get(interruptedActor) ?? 0,
      0,
      "An interrupted empty admission must never issue a claim write",
    );
    const interrupted = store.attempt(interruptedActor.slice(3));
    assert.equal(interrupted.phase, ExecutionPhase.Uncertain);
    assert.equal(interrupted.bead, undefined);
    assert.equal(interruptedReadRequests, 1);
    assert.equal(claimRequests, 4, "Each completed task must have one guarded claim write");
    for (const attempt of admitted) assert.equal(claimActors.get(`pi:${attempt.id}`), 1);
    for (const count of claimActors.values()) assert.equal(count, 1);
    console.log(
      JSON.stringify({
        interruptedClaimRetained: true,
        interruptedActorRequests: claimActors.get(interruptedActor) ?? 0,
        interruptedAdmissionReads: interruptedReadRequests,
        completedFixtureTasks: 4,
      }),
    );
    const first = admitted.find((attempt) => attempt.bead?.id === `${parent}.first`);
    const second = admitted.find((attempt) => attempt.bead?.id === `${parent}.second`);
    assert(first?.integration !== undefined && second?.checkout !== undefined);
    assert.deepEqual(first.worker, approvedWorkers.first);
    assert.deepEqual(second.worker, approvedWorkers.second);
    assert.equal(first.id, crashedAttempt, "Recovery must retain the admitted attempt identity");
    assert.equal(first.recoveries, 1, "Known-dead control host must resume the same accepted attempt");
    assert.equal(second.base, first.integration);
    assert(rejectedSecondHead !== undefined && approvedSecondHead !== undefined);
    assert(rejectedIntegration !== undefined && correctedIntegration !== undefined);
    assert.equal(second.integration, correctedIntegration, "The accepted integration must be the reviewed repair");
    await git("merge-base", "--is-ancestor", rejectedIntegration, correctedIntegration);
    assert.equal(second.reviewFeedback, undefined);
    assert.equal(second.reviewFinding, undefined);
    assert.equal(unrelatedWrites, 1, "A clear assignment should pass review without a repair");
    assert.match(await readFile(join(second.checkout.path, "first.txt"), "utf8"), /^verified prerequisite\n/u);
    assert.equal(first.controllerSession, crashedSession, "Recovery retains the enrolled native controller identity");
    assert.equal((await service.get(`${parent}.held`)).status, "deferred");
    assert.equal(providerError, undefined);
    assert(sawConcurrentReview, "Unrelated assignment must progress despite an overlapping queued task");
    assert(sawOverlapAfterCompletion);
    assert(requests.includes(AgentRole.Worker) && requests.includes(AgentRole.Reviewer));
    assert(!requests.includes(AgentRole.Lead));
    assert(admitted.every((attempt) => new Set(attempt.sessions).size >= 2));
    const rejectedGraph = randomUUID();
    const rejectedRoot = `${prefix}-${rejectedGraph.replaceAll("-", "")}`;
    const rejectedDraft = draftSchema.parse({
      summary: "Negative verification receipt",
      tasks: [
        {
          key: "rejected",
          title: "Deliberate verifier rejection",
          description: "Create rejected.txt with verified prerequisite followed by a newline",
          acceptance:
            "Correct rejected.txt only after explicit guarded retry; verification and independent review are mandatory",
          owns: ["rejected.txt"],
          check: [
            process.execPath,
            "-e",
            'if(await Bun.file("rejected.txt").text()!=="corrected prerequisite\\n"){console.error("EXPECTED_REJECTION");process.exit(42)};console.log("RECOVERY_VERIFIED")',
          ],
        },
        {
          key: "blocked",
          title: "Blocked by rejected verification",
          description: "Must not run before acceptance",
          acceptance: "Remains unclaimed",
          owns: ["blocked.txt"],
          blockedBy: ["rejected"],
        },
      ],
    });
    const rejectedId = `${rejectedRoot}.rejected`;
    const blockedId = `${rejectedRoot}.blocked`;
    await service.createGraph(
      rejectedGraph,
      planDigest(rejectedDraft),
      "Negative verification receipt",
      rejectedDraft,
      { root: rejectedRoot, rejected: rejectedId, blocked: blockedId },
    );
    startSupervisor();
    const waitRecovery = async (label: string, predicate: () => boolean | Promise<boolean>) => {
      const until = Date.now() + (process.env["CI"] === "true" ? 90_000 : 30_000);
      while (!(await predicate())) {
        if (providerError !== undefined)
          throw new Error("Native fixture inference failed", {
            cause: providerError,
          });
        assert(Date.now() < until, `${label}: ${JSON.stringify(store.attempts())}\n${diagnostics}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    const findRejected = () => store.attempts().find((row) => row.bead?.id === rejectedId);
    const dependentFenced = async () => {
      assert.equal(
        store.attempts().some((row) => row.bead?.id === blockedId),
        false,
      );
      assert.equal((await service.get(blockedId)).status, "open");
    };
    await waitRecovery("Negative verification did not settle", async () => {
      await dependentFenced();
      return findRejected()?.phase === ExecutionPhase.Parked;
    });
    const rejected = findRejected();
    assert(rejected?.verification !== undefined && rejected.checkout !== undefined && rejected.base !== undefined);
    assert.equal(rejected.verification.exitCode, 42);
    assert.match(rejected.verification.output, /EXPECTED_REJECTION/u);
    assert.match(rejected.message, /Agreed verification failed/u);
    assert.equal((await service.get(rejectedId)).status, "in_progress");
    // Independently approved work is admitted by the real scheduler, then fenced by retained ownership.
    const conflicts: string[] = [];
    for (const [label, owns] of [
      ["parent", ["rejected.txt/child"]],
      ["unspecified", []],
    ] as const) {
      const graphId = randomUUID();
      const rootId = `${prefix}-${graphId.replaceAll("-", "")}`;
      const conflictDraft = draftSchema.parse({
        summary: "Recovery overlap",
        tasks: [
          {
            key: "queued",
            title: `Recovery overlap ${label}`,
            description: "Must wait for retained writer",
            acceptance: "Never starts while rejected work retains ownership",
            owns: [...owns],
          },
        ],
      });
      const beadId = `${rootId}.queued`;
      conflicts.push(beadId);
      await service.createGraph(graphId, planDigest(conflictDraft), "Recovery overlap", conflictDraft, {
        root: rootId,
        queued: beadId,
      });
    }
    await waitRecovery("Two overlapping tasks were not queued", async () => {
      await dependentFenced();
      return conflicts.every((id) =>
        store.attempts().some((row) => row.bead?.id === id && row.phase === ExecutionPhase.Queued),
      );
    });
    const task = await service.get(rejectedId);
    const snapshot = {
      tasks: [task],
      attempts: store.attempts(),
      observedAt: "native",
      focusable: new Set<string>(),
      limitReached: false,
    };
    const explanation = parkedDetails(task, snapshot);
    assert.match(explanation ?? "", /Recovery overlap parent/u);
    assert.match(explanation ?? "", /Recovery overlap unspecified/u);
    assert.match(explanation ?? "", /Other admission fences may also apply/u);
    const evidence = retainedEvidence(task, snapshot);
    assert.match(evidence, /EXPECTED_REJECTION/u);
    const diff = await safeGit(project.root, rejected.checkout.path, ["diff", rejected.base]);
    assert.match(diff, /verified prerequisite/u);
    await waitRecovery(
      "Prior failed writer did not settle",
      async () => !(await retryWriterFence(store.attempt(rejected.id))),
    );
    if (options.recoveryOutput !== undefined) {
      await mkdir(options.recoveryOutput, { recursive: true });
      await writeFile(
        join(options.recoveryOutput, "failed-receipt.json"),
        JSON.stringify(
          {
            attempt: store.attempt(rejected.id),
            queued: conflicts,
            explanation,
            evidence,
            diff,
          },
          null,
          2,
        ),
      );
      const session = (
        await run(
          process.execPath,
          [
            "--no-env-file",
            "-e",
            'import {SessionManager} from "@earendil-works/pi-coding-agent"; const session=SessionManager.create(process.cwd());session.appendMessage({role:"user",content:"recovery-fixture-ready",timestamp:Date.now()});console.log(session.getSessionFile())',
          ],
          { cwd: fixture.workspace, env },
        )
      ).trim();
      const input = join(options.recoveryOutput, "terminal-input.json");
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
              "UV_PYTHON",
              "UV_PYTHON_DOWNLOADS",
            ].flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]])),
          ),
          session,
          task: rejectedId,
        }),
      );
      await run(
        "uv",
        [
          "run",
          "--script",
          join(root, "acceptance/task-recovery.py"),
          "--input",
          input,
          "--output",
          options.recoveryOutput,
        ],
        {
          cwd: root,
          env: {
            ...env,
            UV_CACHE_DIR: process.env["UV_CACHE_DIR"] ?? join(homedir(), ".cache", "uv"),
          },
          timeout: 90000,
        },
      );
    }
    repairRejected = true;
    const retry = await run(join(root, "scripts/studio"), ["runtime", "retry", rejected.id], {
      cwd: fixture.workspace,
      env,
    });
    assert.equal(retry.trim(), "");
    await waitRecovery("Same-attempt retry did not complete", async () => {
      const current = store.attempt(rejected.id);
      if (current.phase !== ExecutionPhase.Complete) await dependentFenced();
      return current.phase === ExecutionPhase.Complete;
    });
    const recovered = store.attempt(rejected.id);
    assert.equal(store.attempts().filter((row) => row.bead?.id === rejectedId).length, 1);
    assert.equal(recovered.verification?.exitCode, 0);
    assert.match(recovered.verification.output, /RECOVERY_VERIFIED/u);
    assert(recovered.review !== undefined);
    assert(recovered.sessions.length > rejected.sessions.length, "Retry must run worker and independent review again");
    assert.equal((await service.get(rejectedId)).status, "closed");
    if (options.recoveryOutput !== undefined)
      await writeFile(
        join(options.recoveryOutput, "recovered-receipt.json"),
        JSON.stringify(
          {
            attempt: recovered,
            sameAttempt: recovered.id === rejected.id,
            overlaps: conflicts,
            decisionProtocol: "deferred; no per-attempt operator question/answer is implemented",
          },
          null,
          2,
        ),
      );
    console.log(
      JSON.stringify({
        failedCheck: 42,
        queuedOverlaps: 2,
        retainedDiff: true,
        sameAttemptRetry: true,
        verification: 0,
        independentReview: true,
        dependentFencedUntilCompletion: true,
      }),
    );
    console.log(
      "Unattended native Pi workers, exact-revision cold reads and verified readability corrections, held work, responsive free-lead input, exclusive scheduling, overlapping-path serialization, unrelated concurrent progress, and predecessor-code propagation passed after closing the lead and crashing/restarting the host and supervisor between integration and completion.",
    );
  } finally {
    clearTimeout(timeout);
    if (startupTimer) clearTimeout(startupTimer);
    release?.();
    releaseFirst?.();
    releaseOverlap?.();
    releaseInterruptedClaim?.();
    releaseSecond?.();
    if (lead.pid !== undefined && lead.exitCode === null) {
      try {
        process.kill(-lead.pid, "SIGKILL");
      } catch {
        /* already closed */
      }
    }
    for (const attempt of store.attempts())
      if (attempt.pid !== undefined && attempt.started !== undefined && (await alive(attempt.pid, attempt.started))) {
        try {
          process.kill(-attempt.pid, "SIGTERM");
        } catch {
          /* already closed */
        }
      }
    if (supervisor?.pid !== undefined && supervisor.exitCode === null && supervisor.signalCode === null)
      process.kill(-supervisor.pid, "SIGTERM");
    await Promise.race([
      !supervisor || supervisor.exitCode !== null || supervisor.signalCode !== null
        ? Promise.resolve()
        : once(supervisor, "close"),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    leadLines.close();
    store.close();
    await rm(state, { recursive: true, force: true });
    server.close();
    server.closeAllConnections();
    proxy.close();
    proxy.closeAllConnections();
  }
});
