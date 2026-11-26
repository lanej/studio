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
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { registerProjectPolicy } from "../execution/policy.ts";
import { registerDiscovery } from "../discovery/extension.ts";
import { Discoveries, handoffDraft, HandoffPhase } from "../discovery/store.ts";
import {
  exampleConfig,
  ModelCapability,
  ReasoningLevel,
  runtimeProjectSchema,
  StudioProfile,
} from "../config.ts";
import { randomUUID } from "node:crypto";
import {
  registerPlanningDocuments,
  getPlanningDocuments,
} from "../planning/documents.ts";
import { DocumentKind } from "../planning/model.ts";
import { SpecStatus } from "../socrates/spec.ts";
import { draftSchema, planDigest } from "../lead-plan.ts";
import { readySpecification } from "./fixtures/socrates.ts";
import {
  coverageFresh,
  coverageProperties,
  coverageToken,
  specificationToken,
} from "../socrates/assessment.ts";

async function discoveryFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "studio-conversation-plan-"));
  const state = join(directory, "state");
  const project = join(directory, "project");
  const other = join(directory, "other");
  const previousState = process.env["STUDIO_STATE_DIR"];
  const previousConfig = process.env["STUDIO_CONFIG"];
  const store = new Discoveries(state);
  const authorities: ReturnType<typeof registerPlanningDocuments>[] = [];
  t.after(async () => {
    for (const authority of authorities) authority.dispose();
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
      profiles: exampleConfig.profiles,
      integrations: {
        worktrees: {
          enabled: true,
          executable: join(directory, "unavailable"),
        },
      },
    }),
  );
  process.env["STUDIO_CONFIG"] = config;
  const openLead = () =>
    discoveryLead(project, agentDir, (authority) =>
      authorities.push(authority),
    );
  return {
    state,
    project,
    other,
    authority,
    target,
    store,
    openLead,
    ...(await openLead()),
  };
}

async function discoveryLead(
  project: string,
  agentDir: string,
  ownAuthority: (
    authority: ReturnType<typeof registerPlanningDocuments>,
  ) => void,
) {
  let api: ExtensionAPI | undefined;
  const session = SessionManager.inMemory(project);
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
        ownAuthority(registerPlanningDocuments(pi));
        api = pi;
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
  const send = async (text: string) => {
    const message = {
      role: "user" as const,
      content: [{ type: "text" as const, text }],
      timestamp: Date.now(),
    };
    await runner.emit({ type: "message_start", message });
    return message;
  };
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
        assignment: {
          capability: ModelCapability.Standard,
          reasoning: ReasoningLevel.Off,
        },
      },
    ],
  });
  const expectedRevision = (kind: DocumentKind, context = toolContext) => {
    assert.ok(api !== undefined);
    const document = getPlanningDocuments(api)
      ?.capture(context)
      .find((item) => item.ref.kind === kind);
    return document === undefined
      ? {}
      : { expectedRevision: document.revision };
  };
  const save = async (proposal = draft, context = toolContext) => {
    await runner.emitContext([]);
    return tool.execute(
      "draft",
      { ...proposal, ...expectedRevision(DocumentKind.Plan, context) },
      undefined,
      undefined,
      context,
    );
  };
  const specTool = runner.getToolDefinition("draft_socrates_specification");
  assert.ok(specTool !== undefined);
  const assess = async (specificationDraft: unknown) => {
    await runner.emitContext([]);
    return specTool.execute(
      "spec",
      typeof specificationDraft === "object" && specificationDraft !== null
        ? {
            ...specificationDraft,
            ...expectedRevision(DocumentKind.Specification),
          }
        : specificationDraft,
      undefined,
      undefined,
      toolContext,
    );
  };
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
    discovery,
    ctx,
    runner,
    session,
    prompt,
    toolContext,
    send,
    save,
    firstTask,
    draft,
    approve,
    review,
    assess,
    expectedRevision,
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
    save({ ...draft, tasks: [{ ...firstTask, assignment: undefined }] }),
    /Specify worker capability and reasoning/u,
  );
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
  assert.deepEqual(marker.data, {
    id: first.id,
    project: first.project,
    session: session.getSessionId(),
  });
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

await test("Socrates requires a complete baseline and merges affected assessments after a plan change", async (t) => {
  const {
    project,
    store,
    runner,
    toolContext,
    save,
    assess,
    draft,
    firstTask,
    ctx,
  } = await discoveryFixture(t);
  await save();
  const record = store.list(project)[0];
  assert.ok(record !== undefined);
  const first = readySpecification(record.revision);
  const initial = first.draft.coverage;
  assert.ok(initial !== undefined);
  store.change(record.id, (row) => {
    row.specification = { ...first, draft: null, coverageRevision: undefined };
  });
  const snapshot = () => {
    const spec = store.get(record.id).specification;
    assert.ok(spec !== undefined);
    return spec;
  };
  const ask = runner.getToolDefinition("ask_user_question");
  const freeze = runner.getCommand("spec-freeze");
  assert.ok(ask !== undefined && freeze !== undefined);
  await assert.rejects(assess({ ...first.draft, coverage: undefined }));
  await assert.rejects(
    assess({
      ...first.draft,
      coverage: { ...initial, assessments: initial.assessments.slice(1) },
    }),
    /problem-first/u,
  );
  assert.equal(snapshot().draft, null);
  await assess(first.draft);
  const before = snapshot();
  const linked = { ...draft, tasks: [{ ...firstTask, requirements: ["R1"] }] };
  await save(linked);
  const pending = snapshot();
  assert.equal(pending.pendingReview?.cause, "plan");
  assert.deepEqual(pending.draft, before.draft);
  assert.ok(!coverageFresh(pending, record.revision));
  await assert.rejects(freeze.handler("", ctx), /review|assess/iu);
  await assert.rejects(
    ask.execute(
      "ask",
      { decisionId: "D1", question: "Apply where?", options: [] },
      undefined,
      undefined,
      { ...toolContext, hasUI: true },
    ),
    /review|assessment/iu,
  );
  const verification = {
    propertyId: "verification",
    status: "partial",
    reason:
      "The linked task checks R1 in CI. A restored-session check is still missing.",
  };
  const coverage = { domains: initial.domains, assessments: [verification] };
  await assert.rejects(
    assess({ coverage: { ...coverage, domains: ["engineering", "writing"] } }),
    /audience/u,
  );
  await assert.rejects(
    assess({
      coverage: { ...coverage, assessments: [verification, verification] },
    }),
  );
  assert.deepEqual(snapshot(), pending);
  await assess({ coverage });
  const revised = snapshot();
  assert.ok(coverageFresh(revised, record.revision));
  const expected = initial.assessments.map((property) =>
    property.propertyId === verification.propertyId ? verification : property,
  );
  assert.deepEqual(revised.draft, {
    ...first.draft,
    coverage: { ...initial, assessments: expected },
  });
  assert.equal(revised.pendingReview, undefined);
  await save(linked);
  assert.deepEqual(snapshot(), revised);
});

await test("delivered operator input keeps property evidence and requires a disposition before freeze", async (t) => {
  const { project, store, runner, send, save, assess, ctx } =
    await discoveryFixture(t);
  await save();
  const record = store.list(project)[0];
  assert.ok(record !== undefined);
  const spec = readySpecification(record.revision);
  assert.ok(spec.draft.coverage !== undefined);
  spec.draft.coverage.focus = "verification";
  store.change(record.id, (row) => {
    row.specification = spec;
  });
  const snapshot = () => store.get(record.id).specification;
  await runner.emitInput("Possible change", undefined, "interactive", "steer");
  assert.deepEqual(snapshot(), spec);
  await runner.emitInput("Review the proposed beads", undefined, "extension");
  await send("Review the proposed beads");
  assert.deepEqual(snapshot(), spec);
  for (const kind of ["interactive", "rpc"] as const) {
    const question = "Which properties remain open?";
    await runner.emitInput(question, undefined, kind, "steer");
    await send(question);
    const pending = snapshot();
    assert.equal(pending?.pendingReview?.cause, "input");
    assert.deepEqual(pending.draft, spec.draft);
    await send(question);
    assert.notEqual(snapshot()?.pendingReview?.id, pending.pendingReview.id);
    assert.equal(pending.coverageRevision, spec.coverageRevision);
    const freeze = runner.getCommand("spec-freeze");
    assert.ok(freeze !== undefined);
    await assert.rejects(
      freeze.handler("", ctx),
      /review|incorporate|assess/iu,
    );
    await assert.rejects(
      assess({ coverage: { domains: [], assessments: [] } }),
      /removing a property domain/u,
    );
    await assess({ coverage: { assessments: [] } });
    assert.deepEqual(snapshot(), spec);
  }
});

await test("a lead can acknowledge only the input and plan visible to its model request", async (t) => {
  const lead = await discoveryFixture(t);
  await lead.save();
  const [record] = lead.store.list(lead.project);
  assert.ok(record !== undefined);
  const initial = readySpecification(record.revision);
  lead.store.change(record.id, (row) => {
    row.specification = initial;
  });
  const other = await lead.openLead();
  const select = other.runner.getCommand("discoveries");
  assert.ok(select !== undefined);
  await select.handler("", {
    ...other.ctx,
    hasUI: true,
    ui: {
      ...other.ctx.ui,
      select: (_title, options) => Promise.resolve(options[0]),
    },
  });
  const draftTool = lead.runner.getToolDefinition(
    "draft_socrates_specification",
  );
  const planTool = lead.runner.getToolDefinition("draft_implementation_plan");
  assert.ok(draftTool !== undefined && planTool !== undefined);
  const acknowledge = (revision: ReturnType<typeof lead.expectedRevision>) =>
    draftTool.execute(
      "assess",
      { coverage: { assessments: [] }, ...revision },
      undefined,
      undefined,
      lead.toolContext,
    );

  const question = "Which properties are open?";
  const correction = "Limit transcript recovery to the local checkout.";
  const visible = await lead.send(question);
  const transcript = await lead.runner.emitContext([visible]);
  assert.deepEqual(
    transcript.filter(({ role }) => role === "user"),
    [visible],
  );
  const beforeCorrection = lead.expectedRevision(DocumentKind.Specification);
  await other.send(correction);
  const pending = lead.store.get(record.id);
  const staleRequest = /discovery changed since the model's last request/iu;
  await assert.rejects(acknowledge(beforeCorrection), staleRequest);
  assert.deepEqual(lead.store.get(record.id), pending);

  // Either lead can recover both messages even when its transcript has been compacted.
  const context = JSON.stringify(await lead.runner.emitContext([]));
  assert.ok(context.includes(question) && context.includes(correction));
  assert.ok(context.indexOf(question) < context.indexOf(correction));
  await draftTool.execute(
    "incorporate",
    {
      ...initial.draft,
      scope: [correction],
      ...lead.expectedRevision(DocumentKind.Specification),
      coverage: {
        domains: ["engineering"],
        assessments: [
          {
            propertyId: "scope",
            status: "satisfied",
            reason: correction,
          },
        ],
      },
    },
    undefined,
    undefined,
    lead.toolContext,
  );
  const revised = lead.store.get(record.id).specification;
  assert.deepEqual(revised?.draft?.scope, [correction]);
  assert.equal(revised.pendingReview, undefined);

  await lead.runner.emitContext([]);
  const beforePlan = lead.expectedRevision(DocumentKind.Plan);
  const beforePlanSpec = lead.expectedRevision(DocumentKind.Specification);
  const next = {
    ...other.draft,
    summary: "Verify restore from the local transcript only",
  };
  await other.save(next);
  const changedPlan = lead.store.get(record.id);
  await assert.rejects(acknowledge(beforePlanSpec), staleRequest);
  await assert.rejects(
    planTool.execute(
      "old-plan",
      { ...lead.draft, ...beforePlan },
      undefined,
      undefined,
      lead.toolContext,
    ),
    staleRequest,
  );
  assert.deepEqual(lead.store.get(record.id), changedPlan);
  assert.ok(
    JSON.stringify(await lead.runner.emitContext([])).includes(next.summary),
  );
  await acknowledge(lead.expectedRevision(DocumentKind.Specification));
  assert.equal(
    lead.store.get(record.id).specification?.pendingReview,
    undefined,
  );
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
    send,
    save,
    assess,
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
  await send("Check how the revised plan verifies R1.");
  assert.equal(
    store.get(first.id).specification?.pendingReview?.cause,
    "input-and-plan",
  );
  await assert.rejects(approve.handler("", ctx), /review|assess/iu);
  const frozen = store.get(first.id).specification;
  assert.ok(frozen?.draft !== null && frozen?.draft !== undefined);
  await assert.rejects(
    assess({ ...frozen.draft, objective: "Changed" }),
    /spec-reopen/u,
  );
  await assert.rejects(
    assess({
      ...frozen.draft,
      coverage: {
        domains: [],
        assessments: coverageProperties(frozen.draft)
          .filter(({ domain }) => domain === "universal")
          .map(({ id, status, reason }) => ({
            propertyId: id,
            status,
            reason,
          })),
      },
    }),
    /spec-reopen/u,
  );
  await assess(frozen.draft);
  assert.equal(
    store.get(first.id).specification?.approvalAt,
    frozen.approvalAt,
  );
  await assert.rejects(
    approve.handler("", ctx),
    /Cover every frozen requirement/u,
  );
  await save(linked);
  await assess(frozen.draft);

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
  const handedOff = store.change(
    first.id,
    (row) => {
      assert.ok(row.handoff !== undefined);
      row.handoff.phase = HandoffPhase.Complete;
      row.approved = planDigest(linked);
      row.graph = { root: "studio-1", [firstTask.key]: "studio-1.1" };
    },
    true,
  );
  assert.match(await prompt(), /requested code changes directly/u);
  assert.doesNotMatch(await prompt(), /Investigate with read-only tools/u);
  await assert.rejects(save(), /already approved/u);
  await assert.rejects(assess(frozen.draft), /Start or refresh/u);
  const reopen = runner.getCommand("spec-reopen");
  assert.ok(reopen !== undefined);
  await assert.rejects(reopen.handler("", ctx), /\/socrates TITLE/u);
  assert.deepEqual(store.get(first.id), handedOff);
  assert.deepEqual(discovery.runtimeHandoff(ctx), handedOff.handoff);

  const end = runner.getCommand("socrates-end");
  assert.ok(end !== undefined);
  await end.handler("", ctx);
  assert.match(await prompt(), /requested code changes directly/u);
  assert.equal(discovery.runtimeHandoff(ctx), undefined);
  assert.equal(store.get(first.id).approved, planDigest(linked));
});

await test("a legacy assessment cannot authorize a plan revised after freeze before the upgrade", async (t) => {
  const {
    project,
    store,
    save,
    assess,
    draft,
    firstTask,
    reviewUI,
    ctx,
    approve,
    review,
    authority,
    target,
  } = await discoveryFixture(t);
  await save();
  const record = store.list(project)[0];
  assert.ok(record !== undefined);
  const frozen = readySpecification(record.revision);
  const legacyStamp = specificationToken(frozen);
  const changedPlan = draftSchema.parse({
    ...draft,
    tasks: [
      {
        ...firstTask,
        requirements: ["R1"],
        delivery: "local",
        acceptance: "Verify the revised result",
      },
    ],
  });
  const saved = store.change(record.id, (row) => {
    row.specification = {
      ...frozen,
      status: SpecStatus.Frozen,
      approvalAt: "2026-11-24T00:00:00Z",
      coverageRevision: legacyStamp,
    };
    row.planSpecificationRevision = legacyStamp;
    row.leadPlan.draft = changedPlan;
  });

  await save(changedPlan);
  await assert.rejects(approve.handler("", ctx), /Reassess properties/u);
  assert.equal(review.openings, 0);
  // Previously submitted operations reconcile the exact original graph, even with older evidence.
  assert.deepEqual(
    handoffDraft({
      ...saved,
      handoff: {
        operation: randomUUID(),
        phase: HandoffPhase.Uncertain,
        revision: saved.revision,
        digest: planDigest(changedPlan),
        target: { ...target, id: authority },
      },
    }),
    changedPlan,
  );

  await assert.rejects(
    assess({ coverage: { domains: ["engineering"], assessments: [] } }),
  );
  assert.deepEqual(store.get(record.id), saved);
  await assess(frozen.draft);
  const refreshed = store.get(record.id);
  assert.equal(refreshed.planSpecificationRevision, legacyStamp);
  assert.equal(
    refreshed.specification?.coverageRevision,
    coverageToken(frozen),
  );
  await approve.handler("", { ...ctx, ui: reviewUI });
  assert.equal(review.openings, 1);
});

await test("the frozen publication decision assigns PRs to the intended beads and survives final review", async (t) => {
  const {
    project,
    store,
    save,
    assess,
    firstTask,
    draft,
    approve,
    ctx,
    reviewUI,
    review,
    runner,
  } = await discoveryFixture(t);
  await save();
  const record = store.list(project)[0];
  assert.ok(record !== undefined);
  store.change(record.id, (row) => {
    const spec = readySpecification(row.revision);
    const decision = spec.draft.decisions[0];
    assert.ok(decision !== undefined);
    decision.decision = "Publish the CLI bead for manual merge.";
    decision.evidence = "The operator selected the CLI as the publishing bead.";
    spec.draft.deliveryPolicy = {
      decisionId: "D20",
      pullRequests: "selected",
      publish: ["cli"],
      merge: "manual",
    };
    row.specification = {
      ...spec,
      coverageRevision: coverageToken(spec),
      status: SpecStatus.Frozen,
      approvalAt: "2026-11-24T00:00:00Z",
    };
  });
  const prep = { ...firstTask, requirements: ["R1"], owns: ["lib"] };
  const cli = {
    ...prep,
    key: "cli",
    title: "Ship the CLI",
    owns: ["cli"],
    blockedBy: [prep.key],
  };
  const frozen = store.get(record.id).specification;
  assert.ok(frozen?.draft !== undefined);
  await save({ ...draft, tasks: [prep] });
  await assess(frozen.draft);
  await assert.rejects(
    approve.handler("", ctx),
    /missing publishing beads: cli/u,
  );
  await save({ ...draft, tasks: [prep, cli] });
  await assess(frozen.draft);
  const approvedDraft = store.get(record.id).leadPlan.draft;
  assert.ok(approvedDraft != null);
  assert.deepEqual(
    approvedDraft.tasks.map((task) => [task.key, task.delivery]),
    [
      [prep.key, "local"],
      ["cli", "pull-request"],
    ],
  );
  assert.equal(approvedDraft.pullRequestMerge, "manual");
  const revise = runner.getCommand("plan-delivery");
  assert.ok(revise !== undefined);
  await assert.rejects(
    revise.handler("cli local", ctx),
    /conflicts with decision D20/u,
  );
  assert.deepEqual(store.get(record.id).leadPlan.draft, approvedDraft);
  await approve.handler("", { ...ctx, ui: reviewUI });
  assert.equal(review.openings, 1);
  assert.equal(store.get(record.id).handoff, undefined);
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

await test("a fork requires an explicit selection to reuse a parent discovery", async (t) => {
  const { project, store, runner, session, save, draft } =
    await discoveryFixture(t);
  await save();
  const first = store.list(project)[0];
  assert.ok(first !== undefined);
  store.change(first.id, (row) => {
    row.approved = planDigest(draft);
  });
  // A fork can navigate before its tombstone without reviving parent authority.
  const parentRecord = store.get(first.id);
  session.newSession({ parentSession: "fixture-parent.jsonl" });
  const inherited = session.appendCustomEntry("studio:discovery", {
    id: first.id,
    project: first.project,
  });
  await runner.emit({
    type: "session_start",
    reason: "fork",
    previousSessionFile: "fixture-parent.jsonl",
  });
  const tombstone = session.getLeafEntry();
  assert.ok(tombstone?.type === "custom");
  assert.deepEqual(tombstone.data, {
    id: null,
    project: first.project,
    session: session.getSessionId(),
  });
  session.branch(inherited);
  await save();
  const child = store.list(project)[0];
  assert.ok(child !== undefined);
  assert.notEqual(child.id, first.id);
  assert.equal(child.conversation, session.getSessionId());
  assert.deepEqual(store.get(first.id), parentRecord);
  // An explicit child-session selection follows normal approval rules.
  session.appendCustomEntry("studio:discovery", {
    id: first.id,
    project: first.project,
    session: session.getSessionId(),
  });
  await assert.rejects(save(), /already approved/u);
  assert.deepEqual(store.get(first.id), parentRecord);
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

await test("a recorded answer survives draft replays until its decision changes", async (t) => {
  const { project, store, runner, toolContext, save, assess } =
    await discoveryFixture(t);
  await save();
  const record = store.list(project)[0];
  assert.ok(record !== undefined);
  const spec = readySpecification(record.revision);
  store.change(record.id, (row) => {
    row.specification = spec;
  });
  const question = "How long should we retain each transcript?";
  const decision = {
    id: "D21",
    decision: "Set transcript retention",
    disposition: "open",
    basis: "observed",
    evidence: "The brief requests retention.",
    uncertainty: question,
  };
  const draft = {
    ...spec.draft,
    decisions: [...spec.draft.decisions, decision],
    blockingQuestions: [question],
  };
  await assess(draft);
  const ask = runner.getToolDefinition("ask_user_question");
  assert.ok(ask !== undefined);
  const answer =
    "Keep production transcripts for seven days. Decide sandbox retention separately.";
  await runner.emitContext([]);
  await ask.execute(
    "retention",
    { decisionId: decision.id, question, options: [] },
    undefined,
    undefined,
    {
      ...toolContext,
      hasUI: true,
      ui: { ...toolContext.ui, input: () => Promise.resolve(answer) },
    },
  );
  const answered = store.get(record.id).specification;
  assert.equal(answered?.exchange?.answer?.text, answer);
  const replay = {
    ...draft,
    coverage: { domains: ["engineering"], assessments: [] },
  };
  await assert.rejects(assess(replay), /recorded answer.*D21/u);
  await assert.rejects(
    assess({ ...replay, objective: "Retain transcripts for debugging" }),
    /recorded answer.*D21/u,
  );
  assert.deepEqual(store.get(record.id).specification, answered);

  const remaining = "How long should sandbox transcripts be retained?";
  const partial = { ...decision, evidence: answer, uncertainty: remaining };
  await assess({
    ...draft,
    decisions: [...spec.draft.decisions, partial],
    blockingQuestions: [remaining],
  });
  const saved = store.get(record.id).specification;
  assert.equal(saved?.exchange, undefined);
  assert.deepEqual(saved?.draft?.decisions.at(-1), partial);
  assert.deepEqual(saved.draft.blockingQuestions, [remaining]);
});
