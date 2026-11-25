import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { registerProjectPolicy } from "../execution/policy.ts";
import { registerDiscovery } from "../discovery/extension.ts";
import { Discoveries, HandoffPhase } from "../discovery/store.ts";
import { runtimeProjectSchema, StudioProfile } from "../config.ts";
import { randomUUID } from "node:crypto";
import { SpecStatus } from "../socrates/spec.ts";
import { draftSchema, planDigest } from "../lead-plan.ts";
import { readySpecification } from "./fixtures/socrates.ts";
import { coverageToken } from "../socrates/assessment.ts";

async function discoveryFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "studio-conversation-plan-"));
  const state = join(directory, "state");
  const project = join(directory, "project");
  const other = join(directory, "other");
  const previousState = process.env["STUDIO_STATE_DIR"];
  const previousConfig = process.env["STUDIO_CONFIG"];
  const store = new Discoveries(state);
  t.after(async () => {
    if (previousState === undefined) delete process.env["STUDIO_STATE_DIR"];
    else process.env["STUDIO_STATE_DIR"] = previousState;
    if (previousConfig === undefined) delete process.env["STUDIO_CONFIG"];
    else process.env["STUDIO_CONFIG"] = previousConfig;
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  await mkdir(project);
  await mkdir(other);
  process.env["STUDIO_STATE_DIR"] = state;
  const session = SessionManager.inMemory(project);
  const agentDir = join(directory, "agent");
  const authority = randomUUID();
  const target = runtimeProjectSchema.parse({
    root: project,
    source: { url: "http://127.0.0.1:9", projectId: authority },
    profile: StudioProfile.Personal,
    base: "main",
    beadsWorkspace: project,
    beadsDatabase: "fixture",
  });
  const config = join(directory, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      runtime: { enabled: true, projects: [target] },
      integrations: {
        worktrees: {
          enabled: true,
          executable: join(directory, "unavailable"),
        },
      },
    }),
  );
  process.env["STUDIO_CONFIG"] = config;
  let discovery: ReturnType<typeof registerDiscovery> | undefined;
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
        const selected = registerDiscovery(pi, () => StudioProfile.Personal);
        discovery = selected;
        registerProjectPolicy(
          pi,
          (ctx) => selected.runtimeHandoff(ctx)?.target,
        );
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
  runtime.appendEntry = (type, data) => {
    session.appendCustomEntry(type, data);
  };
  runtime.getThinkingLevel = () => "off";
  const ctx = runner.createCommandContext();
  assert.ok(discovery !== undefined);
  const prompt = async () => {
    const result = await runner.emitBeforeAgentStart(
      { messageType: "user", prompt: "Work in this checkout." },
      { forceSystemPrompt: "Native Pi coding tools", cwd: project },
    );
    return result.systemPromptOptions.forceSystemPrompt ?? "";
  };
  const toolContext = runner.createToolContext("draft", undefined);
  const tool = runner.getToolDefinition("draft_implementation_plan");
  assert.ok(tool !== undefined);
  const draft = draftSchema.parse({
    summary: "Prepare the requested change",
    tasks: [
      {
        key: "change",
        title: "Implement the change",
        description: "A bounded change",
        acceptance: "Native acceptance passes",
      },
    ],
  });
  const save = (proposal = draft, context = toolContext) =>
    tool.execute("draft", proposal, undefined, undefined, context);
  const firstTask = draft.tasks[0];
  assert.ok(firstTask !== undefined);

  const approve = runner.getCommand("plan-approve");
  assert.ok(approve !== undefined);
  const review = { openings: 0 };
  const reviewUI = {
    ...ctx.ui,
    get custom() {
      review.openings++;
      return ctx.ui.custom.bind(ctx.ui);
    },
  };

  return {
    state,
    project,
    other,
    authority,
    target,
    discovery,
    store,
    ctx,
    runner,
    session,
    prompt,
    toolContext,
    save,
    firstTask,
    draft,
    approve,
    review,
    reviewUI,
  };
}

await test("a daily lead codes directly and can save and revise a private plan without a runtime handoff", async (t) => {
  const {
    project,
    discovery,
    store,
    ctx,
    session,
    prompt,
    save,
    firstTask,
    draft,
    approve,
  } = await discoveryFixture(t);
  assert.match(await prompt(), /requested code changes directly/u);
  assert.equal(discovery.runtimeHandoff(ctx), undefined);
  const leaf = session.getLeafId();
  await assert.rejects(save({ ...draft, summary: " " }));
  await assert.rejects(
    save({
      ...draft,
      tasks: [{ ...firstTask, blockedBy: ["missing"] }],
    }),
  );
  assert.equal(session.getLeafId(), leaf);
  assert.deepEqual(store.list(project), []);

  const result = await save();
  assert.match(JSON.stringify(result.content), /Draft saved/u);
  const first = store.list(project)[0];
  assert.ok(first !== undefined);
  assert.equal(first.title, draft.summary);
  assert.equal(first.conversation, session.getSessionId());
  assert.deepEqual(first.leadPlan.draft, draft);
  assert.equal(first.specification, undefined);
  assert.equal(first.approved, undefined);
  assert.equal(first.graph, undefined);
  assert.equal(first.handoff, undefined);
  const marker = session.getLeafEntry();
  assert.ok(marker?.type === "custom");
  assert.deepEqual(marker.data, { id: first.id, project: first.project });
  const revised = {
    ...draft,
    summary: "Revised proposal for operator review",
  };
  await save(revised);
  assert.equal(store.list(project).length, 1);
  assert.equal(session.getLeafId(), marker.id);
  assert.deepEqual(store.get(first.id).leadPlan.draft, revised);
  await assert.rejects(approve.handler("", ctx), /socrates.*freeze/iu);
  assert.equal(store.get(first.id).approved, undefined);
  assert.equal(store.get(first.id).handoff, undefined);
  assert.equal(discovery.runtimeHandoff(ctx), undefined);
});

await test("only the current assessed specification and linked plan can reach handoff review", async (t) => {
  const {
    project,
    authority,
    target,
    discovery,
    store,
    ctx,
    runner,
    prompt,
    save,
    firstTask,
    draft,
    approve,
    review,
    reviewUI,
  } = await discoveryFixture(t);
  await save();
  const first = store.list(project)[0];
  assert.ok(first !== undefined);
  store.change(first.id, (row) => {
    row.specification = readySpecification(row.revision);
  });
  assert.match(await prompt(), /Investigate with read-only tools/u);
  const linked = {
    ...draft,
    tasks: [{ ...firstTask, requirements: ["R1"] }],
  };
  await save(linked);
  await assert.rejects(
    save({ ...draft, tasks: [{ ...firstTask, requirements: ["R9"] }] }),
    /current specification/u,
  );
  await assert.rejects(approve.handler("", ctx), /freeze/iu);
  store.change(first.id, (row) => {
    const spec = readySpecification(row.revision);
    spec.draft.requirements[0] = {
      id: "R1",
      outcome: "Recover the transcript",
      acceptance: "Recovered bytes and timestamp match.",
    };
    row.specification = {
      ...spec,
      coverageRevision: coverageToken(spec),
      status: SpecStatus.Frozen,
      approvalAt: "2026-11-24T00:00:00Z",
    };
  });
  await assert.rejects(
    approve.handler("", ctx),
    /current frozen specification/u,
  );
  await save();
  await assert.rejects(
    approve.handler("", ctx),
    /Cover every frozen requirement/u,
  );
  await save(linked);

  // Pi's headless review dismisses the dialog. A missing worktree executable
  // and unreachable Beads service must not prevent that local review.
  await approve.handler("", { ...ctx, ui: reviewUI });
  assert.equal(review.openings, 1);
  assert.equal(store.get(first.id).handoff, undefined);
  assert.equal(discovery.runtimeHandoff(ctx), undefined);

  const handoff = store.beginHandoff(store.get(first.id), {
    ...target,
    id: authority,
  });
  assert.deepEqual(
    discovery.runtimeHandoff(ctx),
    store.get(handoff.id).handoff,
  );
  store.change(
    first.id,
    (row) => {
      assert.ok(row.handoff !== undefined);
      row.handoff.phase = HandoffPhase.Complete;
      row.approved = planDigest(linked);
    },
    true,
  );
  assert.match(await prompt(), /requested code changes directly/u);
  assert.doesNotMatch(await prompt(), /Investigate with read-only tools/u);
  await assert.rejects(save(), /already approved/u);

  const end = runner.getCommand("socrates-end");
  assert.ok(end !== undefined);
  await end.handler("", ctx);
  assert.match(await prompt(), /requested code changes directly/u);
  assert.equal(discovery.runtimeHandoff(ctx), undefined);
  assert.equal(store.get(first.id).approved, planDigest(linked));
});

await test("ending discovery preserves the unfinished specification and leaves no runtime receipt", async (t) => {
  const { project, discovery, store, ctx, runner, prompt, save } =
    await discoveryFixture(t);
  await save();
  const record = store.list(project)[0];
  assert.ok(record !== undefined);
  const open = store.change(record.id, (row) => {
    row.specification = readySpecification(row.revision);
  });
  const end = runner.getCommand("socrates-end");
  assert.ok(end !== undefined);
  await end.handler("", ctx);
  assert.deepEqual(store.get(record.id), open);
  assert.equal(discovery.runtimeHandoff(ctx), undefined);
  assert.match(await prompt(), /requested code changes directly/u);
});

await test("legacy handoffs keep their receipt when switching conversations and projects", async (t) => {
  const {
    project,
    other,
    authority,
    target,
    store,
    ctx,
    session,
    toolContext,
    save,
    draft,
    approve,
    review,
    reviewUI,
  } = await discoveryFixture(t);
  await save();
  const first = store.list(project)[0];
  assert.ok(first !== undefined);
  // A fresh session cannot inherit the previous session's selected discovery.
  session.newSession();
  await save();
  const second = store.list(project)[0];
  assert.ok(second !== undefined);
  assert.notEqual(second.id, first.id);
  assert.equal(second.conversation, session.getSessionId());
  assert.deepEqual(store.get(first.id).leadPlan.draft, draft);
  const pending = store.change(second.id, (row) => {
    // A standalone pre-Socrates handoff from an older release.
    row.handoff = {
      operation: randomUUID(),
      revision: row.revision,
      phase: HandoffPhase.Uncertain,
      digest: planDigest(draft),
      target: { ...target, id: authority },
    };
  });
  await assert.rejects(save(), /handoff is pending or uncertain/u);
  assert.deepEqual(store.get(second.id), pending);
  await approve.handler("", { ...ctx, ui: reviewUI });
  assert.equal(review.openings, 1);
  assert.deepEqual(store.get(second.id), pending);
  // A marker from a different project cannot authorize editing that project.
  await save(draft, { ...toolContext, cwd: other });
  assert.equal(store.list(other).length, 1);
  assert.deepEqual(store.get(second.id).leadPlan.draft, draft);
  assert.equal(store.list(project).length, 2);
  session.appendCustomEntry("studio:discovery", {
    id: "00000000-0000-4000-8000-000000000000",
    project: first.project,
  });
  await assert.rejects(save(), /Unknown discovery/u);
  assert.equal(store.list(project).length, 2);
});

await test("a lead can change merge policy only after a handoff to the configured project authority", async (t) => {
  const {
    state,
    project,
    authority,
    target,
    store,
    runner,
    toolContext,
    save,
    draft,
  } = await discoveryFixture(t);
  const policy = runner.getToolDefinition("studio_project_merge_policy");
  assert.ok(policy !== undefined);
  const update = () =>
    policy.execute(
      "policy",
      { merge: "on", reason: "Use the reviewed merge policy" },
      undefined,
      undefined,
      toolContext,
    );
  await assert.rejects(update(), /Approve a Socrates plan/u);
  await save();
  const record = store.list(project)[0];
  assert.ok(record !== undefined);
  await assert.rejects(update(), /Approve a Socrates plan/u);
  assert.equal(existsSync(join(state, "runtime.sqlite")), false);

  store.change(record.id, (row) => {
    row.approved = planDigest(draft);
    row.handoff = {
      operation: randomUUID(),
      revision: row.revision,
      digest: row.approved,
      phase: HandoffPhase.Complete,
      target: {
        ...target,
        id: authority,
        source: { ...target.source, url: "http://127.0.0.1:8" },
      },
    };
  });
  await assert.rejects(update(), /Configure this runtime project/u);
  assert.equal(existsSync(join(state, "runtime.sqlite")), false);
  store.change(record.id, (row) => {
    assert.ok(row.handoff !== undefined);
    row.handoff.target.source = target.source;
  });
  const result = await update();
  assert.match(JSON.stringify(result.content), /lead override/u);
});
