import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { registerDiscovery } from "../discovery/extension.ts";
import { Discoveries, HandoffPhase } from "../discovery/store.ts";
import { readySpecification } from "./fixtures/socrates.ts";
import { specificationToken } from "../socrates/assessment.ts";
import { SpecStatus } from "../socrates/spec.ts";
import { draftSchema } from "../lead-plan.ts";
import {
  configSchema,
  DefaultProvider,
  exampleConfig,
  ModelCapability,
  ReasoningLevel,
  runtimeProjectSchema,
  StudioProfile,
} from "../config.ts";
import {
  ExecutionStore,
  activeTaskReviews,
  executionSchema,
  ExecutionPhase,
} from "../execution/store.ts";
import { retainClaim, writerFence } from "../execution/recovery.ts";
import { ExecutionBeads } from "../execution/beads.ts";
import { beadSchema, owner } from "../task-service.ts";
import { taskDetails } from "../beads.ts";

await test("a changed worker mapping blocks admission while retaining the task's owned paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-assignment-"));
  const store = new ExecutionStore(directory);
  const project = randomUUID();
  const id = randomUUID();
  const provider = DefaultProvider.ChatGPTSubscription;
  const configuration = configSchema.parse({
    profiles: {
      personal: {
        ...exampleConfig.profiles.personal,
        workerModels: { fast: { provider, model: "different-fast" } },
      },
    },
  });
  const bead = beadSchema.parse({
    id: "assigned",
    title: "First",
    status: "in_progress",
    revision: "accepted",
    metadata: {
      "pi.attempt": id,
      "studio.profile": StudioProfile.Personal,
      "studio.task": {
        key: "first",
        title: "First",
        description: "Bounded task",
        acceptance: "Verified result",
        owns: ["src/first.ts"],
        assignment: {
          capability: ModelCapability.Fast,
          reasoning: ReasoningLevel.Low,
        },
      },
      "studio.worker": {
        provider,
        model: "approved-fast",
        reasoning: ReasoningLevel.Low,
      },
    },
  });
  try {
    store.saveAttempt(
      executionSchema.parse({
        id,
        project,
        profile: StudioProfile.Personal,
        phase: ExecutionPhase.Claiming,
        message: "Claimed",
      }),
    );
    const service = new ExecutionBeads({
      projectId: project,
      url: "http://127.0.0.1:9",
    });
    await assert.rejects(
      retainClaim(store, service, id, bead, configuration),
      /approved worker differs from the enrolled profile/u,
    );
    const retained = store.attempt(id);
    assert.deepEqual(retained.owns, ["src/first.ts"]);
    assert.equal(retained.worker, undefined);
    assert.equal(retained.phase, ExecutionPhase.Claiming);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("discovery listing is scoped to the canonical project and retains duplicate titles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-discovery-"));
  const store = new Discoveries(join(directory, "state"));
  try {
    const project = join(directory, "project");
    const other = join(directory, "other");
    const empty = join(directory, "empty");
    const alias = join(directory, "alias");
    await mkdir(project);
    await mkdir(other);
    await mkdir(empty);
    await symlink(project, alias);
    const title = "Fix the runtime handoff";
    const first = store.create(project, "first", title);
    const foreign = store.create(other, "foreign", title);
    const second = store.create(alias, "second", title);
    assert.notEqual(first.id, second.id);
    assert.deepEqual(store.list(project), [second, first]);
    assert.deepEqual(store.list(alias), [second, first]);
    assert.deepEqual(store.list(other), [foreign]);
    assert.deepEqual(store.list(empty), []);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("daily-driver Socrates starts by title and resumes the picker selection without rewriting it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-discovery-commands-"));
  const state = join(directory, "state");
  const project = join(directory, "project");
  const other = join(directory, "other");
  const empty = join(directory, "empty");
  const previousState = process.env["STUDIO_STATE_DIR"];
  const store = new Discoveries(state);
  try {
    await mkdir(project);
    await mkdir(other);
    await mkdir(empty);
    process.env["STUDIO_STATE_DIR"] = state;
    const session = SessionManager.inMemory(project);
    const agentDir = join(directory, "agent");
    const loader = new DefaultResourceLoader({
      cwd: project,
      agentDir,
      settingsManager: SettingsManager.inMemory(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        (pi) => {
          registerDiscovery(pi, () => undefined);
        },
      ],
    });
    await loader.reload();
    const { errors, extensions, runtime } = loader.getExtensions();
    assert.deepEqual(errors, []);
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const runner = new ExtensionRunner(
      extensions,
      runtime,
      project,
      session,
      new ModelRegistry(modelRuntime),
    );
    const messages: unknown[] = [];
    runtime.appendEntry = (type, data) => {
      session.appendCustomEntry(type, data);
    };
    runtime.sendUserMessage = (content) => {
      messages.push(content);
    };
    let options: string[] = [];
    let pickerOpenings = 0;
    let choice: number | undefined;
    let switchBranch: (() => void) | undefined;
    const notices: string[] = [];
    runtime.getThinkingLevel = () => "off";
    const ctx = {
      ...runner.createCommandContext(),
      hasUI: true,
      ui: {
        ...runner.getUIContext(),
        select: (_title: string, choices: string[]) => {
          pickerOpenings++;
          options = choices;
          switchBranch?.();
          return Promise.resolve(
            choice === undefined ? undefined : choices[choice],
          );
        },
        notify: (notice: string) => {
          notices.push(notice);
        },
      },
    };
    const socrates = runner.getCommand("socrates");
    const picker = runner.getCommand("discoveries");
    assert.ok(socrates !== undefined && picker !== undefined);

    await socrates.handler("", ctx);
    assert.deepEqual(
      store.list(project).map(({ title }) => title),
      ["Discovery"],
    );
    const title = "Fix the runtime handoff";
    await socrates.handler(`  ${title}  `, ctx);
    const first = store.list(project)[0];
    assert.ok(first?.specification !== undefined);
    assert.equal(first.title, title);
    assert.equal(first.specification.status, SpecStatus.Interrogating);
    const answered = store.change(first.id, (record) => {
      const spec = record.specification;
      assert.ok(spec !== undefined);
      record.specification = {
        ...spec,
        exchange: {
          prompt: {
            decisionId: "D1",
            question: "When should work begin?",
            options: [],
          },
          answer: { kind: "custom", text: "After review" },
        },
      };
    });
    const foreign = store.create(other, "foreign", "Foreign discovery");
    session.newSession();
    assert.notEqual(session.getSessionId(), first.conversation);
    for (const argument of [title, title, "list", "new Another topic"]) {
      await socrates.handler(argument, ctx);
      const newest = store.list(project)[0];
      assert.ok(newest !== undefined);
      assert.equal(newest.title, argument);
      assert.notEqual(newest.id, first.id);
    }
    const records = store.list(project);
    const turnCount = messages.length;
    const leaf = session.getLeafId();

    await picker.handler("", { ...ctx, cwd: empty });
    assert.deepEqual(notices, ["No saved discoveries for this project."]);
    assert.equal(pickerOpenings, 0);
    assert.equal(session.getLeafId(), leaf);

    await picker.handler("", ctx);
    assert.equal(session.getLeafId(), leaf, "Cancel leaves binding intact");
    assert.equal(options.length, records.length);
    assert.ok(options.every((label) => !label.includes(foreign.title)));
    assert.ok(records.every(({ id }) => !options.join("\n").includes(id)));
    const duplicateLabels = options.filter((label) => label.includes(title));
    assert.equal(new Set(duplicateLabels).size, 3);
    for (const [index, record] of records.entries()) {
      if (record.title !== title || record.id === first.id) continue;
      choice = index;
      await picker.handler("", ctx);
      const picked = session.getLeafEntry();
      assert.ok(picked?.type === "custom");
      assert.deepEqual(picked.data, {
        id: record.id,
        project: record.project,
        session: session.getSessionId(),
      });
    }

    choice = options.findIndex((label) => label.includes("answer saved"));
    assert.ok(choice >= 0);
    assert.ok(leaf !== null);
    switchBranch = () => {
      session.branch(leaf);
    };
    await assert.rejects(
      picker.handler("", ctx),
      /again for this conversation/u,
    );
    assert.equal(session.getLeafId(), leaf);
    switchBranch = undefined;
    await picker.handler("", ctx);
    const marker = session.getLeafEntry();
    assert.ok(marker?.type === "custom");
    assert.deepEqual(marker.data, {
      id: first.id,
      project: first.project,
      session: session.getSessionId(),
    });
    await picker.handler("", ctx);
    assert.equal(session.getLeafId(), marker.id, "Reselecting is a no-op");
    choice = undefined;
    await picker.handler("", ctx);
    assert.equal(session.getLeafId(), marker.id);
    assert.equal(messages.length, turnCount, "Picking should not start a turn");

    await socrates.handler("  ", ctx);
    assert.equal(messages.length, turnCount + 1);
    assert.equal(
      messages.at(-1),
      "Resume Socrates discovery using the recorded operator answer.",
    );
    assert.equal(session.getLeafId(), marker.id);
    assert.deepEqual(store.get(first.id), answered);
    assert.deepEqual(store.list(project), records);

    await socrates.handler(first.id, ctx);
    const literal = store.list(project)[0];
    assert.ok(literal !== undefined);
    assert.equal(literal.title, first.id);
    assert.notEqual(literal.id, first.id);
  } finally {
    if (previousState === undefined) delete process.env["STUDIO_STATE_DIR"];
    else process.env["STUDIO_STATE_DIR"] = previousState;
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("discovery approval freezes the displayed version before effects and prevents cross-lead stale approval", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-discovery-"));
  const projectPath = join(directory, "project");
  await mkdir(projectPath);
  const store = new Discoveries(join(directory, "state"));
  const peer = new Discoveries(join(directory, "state"));
  try {
    const discovery = store.create(
      projectPath,
      randomUUID(),
      "Research without Beads",
    );
    const other = store.create(projectPath, randomUUID(), "Separate discovery");
    assert.notEqual(other.id, discovery.id);
    const draft = draftSchema.parse({
      summary: "Approved work",
      tasks: [
        {
          key: "first",
          title: "First",
          description: "Bounded task",
          delivery: "local",
          acceptance: "Verified result",
          requirements: ["R1"],
          assignment: {
            capability: ModelCapability.Fast,
            reasoning: ReasoningLevel.Low,
          },
        },
      ],
    });
    assert.throws(
      () =>
        draftSchema.parse({
          ...draft,
          tasks: [{ ...draft.tasks[0], key: "root" }],
        }),
      /reserved/u,
    );
    const displayed = store.change(discovery.id, (record) => {
      const specification = readySpecification(record.revision);
      record.specification = {
        ...specification,
        status: SpecStatus.Frozen,
        approvalAt: "2026-11-24T00:00:00Z",
      };
      record.planSpecificationRevision = specificationToken(specification);
      record.leadPlan.draft = draft;
    });
    const authorityId = randomUUID();
    const authority = {
      ...runtimeProjectSchema.parse({
        root: projectPath,
        source: { url: "http://127.0.0.1:9", projectId: authorityId },
        profile: StudioProfile.Personal,
        base: "main",
        beadsWorkspace: projectPath,
        beadsDatabase: "fixture",
      }),
      id: authorityId,
    };
    peer.change(discovery.id, (record) => {
      record.leadPlan.draft = {
        ...draft,
        tasks: draft.tasks.map((task) => ({
          ...task,
          assignment: {
            capability: ModelCapability.Fast,
            reasoning: ReasoningLevel.Medium,
          },
        })),
      };
    });
    assert.throws(
      () => store.beginHandoff(displayed, authority),
      /changed before approval/u,
    );
    const current = peer.get(discovery.id);
    const workers = {
      first: {
        provider: DefaultProvider.ChatGPTSubscription,
        model: "fixture-fast",
        reasoning: ReasoningLevel.Medium,
      },
    };
    const frozen = store.beginHandoff(
      current,
      authority,
      { pid: process.pid, started: "fixture-start" },
      false,
      workers,
    );
    assert.equal(frozen.handoff?.phase, HandoffPhase.Pending);
    assert.throws(
      () =>
        peer.change(discovery.id, (record) => {
          record.revision = randomUUID();
        }),
      /handoff is pending/u,
    );
    assert.throws(
      () => peer.beginHandoff(current, authority, undefined, false, workers),
      /already in progress/u,
    );
    assert.equal(peer.get(other.id).title, "Separate discovery");
    const retry = peer.beginHandoff(
      peer.get(discovery.id),
      authority,
      { pid: process.pid, started: "recovered-owner" },
      true,
      workers,
    );
    assert.equal(
      retry.handoff?.operation,
      frozen.handoff.operation,
      "Recovery retains the original graph effect identity",
    );
    assert.throws(
      () =>
        store.beginHandoff(
          store.get(discovery.id),
          {
            ...authority,
            source: { ...authority.source, url: "http://127.0.0.1:10" },
          },
          { pid: process.pid, started: "recovered-owner" },
          true,
          workers,
        ),
      /original project authority/u,
    );
    assert.throws(
      () =>
        store.beginHandoff(
          store.get(discovery.id),
          authority,
          { pid: process.pid, started: "recovered-owner" },
          true,
          { first: { ...workers.first, model: "different-fast" } },
        ),
      /original project authority and draft, including worker selections/u,
    );

    peer.change(
      discovery.id,
      (record) => {
        if (record.handoff !== undefined)
          record.handoff.phase = HandoffPhase.Uncertain;
      },
      true,
    );
    assert.throws(
      () =>
        store.change(discovery.id, (record) => {
          record.leadPlan.draft = draft;
        }),
      /handoff is pending or uncertain/u,
    );
  } finally {
    peer.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("unknown native launches retain writer fences and project merge overrides remain isolated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-runtime-state-"));
  const store = new ExecutionStore(directory);
  try {
    const first = randomUUID();
    const second = randomUUID();
    const uncertain = executionSchema.parse({
      id: randomUUID(),
      project: first,
      profile: StudioProfile.Personal,
      phase: ExecutionPhase.Uncertain,
      launchToken: randomUUID(),
      message: "Missing launch receipt",
    });
    assert.equal(
      await writerFence(uncertain),
      true,
      "Missing PID cannot establish a dead writer",
    );
    assert.equal(
      await writerFence({ ...uncertain, launchSettled: true }),
      false,
      "Positive settled receipt releases the local fence",
    );
    store.setOverride(first, {
      enabled: true,
      actor: "lead",
      reason: "Approved project delivery",
      at: new Date().toISOString(),
    });
    assert.equal(store.override(first)?.enabled, true);
    assert.equal(store.override(second), undefined);
    store.setOverride(first, {
      enabled: false,
      actor: "lead",
      reason: "Hold project merges",
      at: new Date().toISOString(),
    });
    assert.equal(store.override(first)?.enabled, false);
    store.setOverride(first, undefined, {
      actor: "lead",
      reason: "Restore configured default",
    });
    assert.equal(store.override(first), undefined);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("task review details follow the current project, bead and attempt owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-task-review-"));
  const id = randomUUID();
  const project = randomUUID();
  const bead = beadSchema.parse({
    id: "fixture-1",
    title: "Inline diffs",
    revision: "fixture",
    status: "in_progress",
    assignee: owner(id),
  });
  const attempt = executionSchema.parse({
    id,
    project,
    bead,
    profile: StudioProfile.Personal,
    phase: ExecutionPhase.Reviewing,
    message: "Reviewing current revision",
  });
  const reviews = () => activeTaskReviews(project, [bead], directory);
  assert.equal(reviews().size, 0);
  const store = new ExecutionStore(directory);
  try {
    store.saveAttempt(attempt);
    const details = () =>
      taskDetails(bead, project, undefined, reviews().get(bead.id));
    assert.match(details(), /in_progress · Reviewing/u);
    const finding =
      "Which width wins? diff.ts and view.ts compute separate thresholds.";
    store.change(id, (row) => {
      row.phase = ExecutionPhase.Running;
      row.reviewFinding = finding;
    });
    assert.ok(details().includes(`Changes requested\n${finding}`));
    assert.equal(activeTaskReviews(randomUUID(), [bead], directory).size, 0);
    for (const other of [
      { ...bead, id: "different" },
      { ...bead, assignee: owner(randomUUID()) },
      { ...bead, status: "closed" },
    ]) {
      assert.equal(activeTaskReviews(project, [other], directory).size, 0);
    }
    store.change(id, (row) => {
      row.phase = ExecutionPhase.Reviewing;
      row.reviewFinding = undefined;
    });
    assert.match(details(), /in_progress · Reviewing/u);
    assert.ok(!details().includes(finding));
    store.change(id, (row) => {
      row.review = "Candidate approved";
      row.phase = ExecutionPhase.Integrating;
    });
    assert.equal(reviews().size, 0);
    store.change(id, (row) => {
      row.reviewFinding = finding;
      row.phase = ExecutionPhase.Parked;
    });
    assert.ok(details().includes(finding));
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("review-only execution authority refuses mutation before contacting a service", async () => {
  const service = new ExecutionBeads({
    url: "http://127.0.0.1:9",
    projectId: randomUUID(),
    reviewOnly: true,
  });
  await assert.rejects(service.claimNext(randomUUID()), /review-only/u);
  await assert.rejects(
    service.createGraph(
      randomUUID(),
      "digest",
      "No writes",
      draftSchema.parse({ summary: "Read only", tasks: [] }),
      { root: "fixture-root" },
    ),
    /review-only/u,
  );
  const bead = beadSchema.parse({
    id: "fixture-1",
    title: "Read only",
    status: "in_progress",
    revision: "revision",
  });
  await assert.rejects(
    service.finishAccepted(bead, randomUUID(), "No closure"),
    /review-only/u,
  );
});

await test("independent schedulers and delivery corrections share atomic inference capacity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-capacity-"));
  const store = new ExecutionStore(directory);
  const peer = new ExecutionStore(directory);
  try {
    const project = randomUUID();
    const first = executionSchema.parse({
      id: randomUUID(),
      project,
      profile: StudioProfile.Personal,
      phase: ExecutionPhase.Queued,
      message: "queued",
    });
    const correction = executionSchema.parse({
      id: randomUUID(),
      project,
      profile: StudioProfile.Personal,
      phase: ExecutionPhase.Waiting,
      launchToken: randomUUID(),
      message: "correction",
    });
    store.saveAttempt(first);
    store.saveAttempt(correction);
    assert.equal(
      store.reserveInference(first.id, 1, (row) => {
        row.phase = ExecutionPhase.Launching;
        row.launchToken = randomUUID();
      }),
      true,
    );
    assert.equal(
      peer.reserveInference(correction.id, 1, (row) => {
        row.phase = ExecutionPhase.Running;
      }),
      false,
    );
    store.change(first.id, (row) => {
      row.phase = ExecutionPhase.Delivery;
    });
    assert.equal(
      peer.reserveInference(correction.id, 1, (row) => {
        row.phase = ExecutionPhase.Running;
      }),
      true,
    );
    assert.equal(
      store.reserveInference(first.id, 1, (row) => {
        row.phase = ExecutionPhase.Running;
      }),
      false,
    );
  } finally {
    peer.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("configured two and three host limits retain shared admission and release guards", async () => {
  assert.equal(configSchema.parse({}).runtime.concurrency, 2);
  assert.equal(configSchema.parse({ runtime: {} }).runtime.concurrency, 2);
  assert.equal(
    configSchema.safeParse({ runtime: { concurrency: 4 } }).success,
    false,
  );
  for (const concurrency of [2, 3]) {
    const limit = configSchema.parse({ runtime: { concurrency } }).runtime
      .concurrency;
    const directory = await mkdtemp(join(tmpdir(), "studio-capacity-"));
    const store = new ExecutionStore(directory);
    const peer = new ExecutionStore(directory);
    try {
      const attempts = Array.from({ length: limit + 1 }, () =>
        executionSchema.parse({
          id: randomUUID(),
          project: randomUUID(),
          profile: StudioProfile.Personal,
          phase: ExecutionPhase.Queued,
          message: "queued",
        }),
      );
      for (const attempt of attempts) store.saveAttempt(attempt);
      const reserve = (id: string) =>
        peer.reserveInference(id, limit, (row) => {
          row.phase = ExecutionPhase.Running;
          row.launchToken = randomUUID();
        });
      for (const attempt of attempts.slice(0, limit))
        assert.equal(reserve(attempt.id), true);
      const first = attempts[0];
      const waiting = attempts[limit];
      assert.ok(first !== undefined);
      assert.ok(waiting !== undefined);
      assert.equal(reserve(waiting.id), false);
      store.change(first.id, (row) => {
        row.phase = ExecutionPhase.Reviewing;
      });
      assert.equal(reserve(waiting.id), false);
      store.change(first.id, (row) => {
        row.phase = ExecutionPhase.Delivery;
      });
      assert.equal(reserve(waiting.id), true);
    } finally {
      peer.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

await test("unfinished attempts pin enrolled authority while merge defaults stay adjustable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-enrollment-"));
  const store = new ExecutionStore(directory);
  try {
    const id = randomUUID();
    const project = {
      ...runtimeProjectSchema.parse({
        root: directory,
        source: { url: "http://127.0.0.1:9", projectId: id },
        profile: StudioProfile.Personal,
        base: "main",
        beadsWorkspace: directory,
        beadsDatabase: "fixture",
      }),
      id,
    };
    store.enroll(project);
    store.saveAttempt(
      executionSchema.parse({
        id: randomUUID(),
        project: id,
        profile: StudioProfile.Personal,
        phase: ExecutionPhase.Claiming,
        message: "retained claim intent",
      }),
    );
    assert.throws(
      () =>
        store.validateEnrollment({
          ...project,
          source: { ...project.source, reviewOnly: true },
        }),
      /pin this project's authority/u,
    );
    store.enroll({ ...project, merge: true });
    assert.equal(store.project(id).merge, true);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
