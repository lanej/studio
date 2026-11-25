import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { registerDiscovery } from "../discovery/extension.ts";
import { Discoveries } from "../discovery/store.ts";
import { runtimeProjectSchema, StudioProfile } from "../config.ts";
import { randomUUID } from "node:crypto";
import { SpecStatus } from "../socrates/spec.ts";
import { draftSchema } from "../lead-plan.ts";

await test("registered draft tool starts only valid fresh proposals and preserves discovery authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-conversation-plan-"));
  const state = join(directory, "state");
  const project = join(directory, "project");
  const other = join(directory, "other");
  const previousState = process.env["STUDIO_STATE_DIR"];
  const store = new Discoveries(state);
  try {
    await mkdir(project);
    await mkdir(other);
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
    runtime.appendEntry = (type, data) => {
      session.appendCustomEntry(type, data);
    };
    runtime.getThinkingLevel = () => "off";
    const ctx = runner.createCommandContext();
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
    const approve = runner.getCommand("plan-approve");
    assert.ok(approve !== undefined);
    await assert.rejects(approve.handler("", ctx), /Select \/studio-profile/u);
    assert.equal(store.get(first.id).approved, undefined);
    assert.equal(store.get(first.id).handoff, undefined);

    // A bound Socrates discovery must still freeze and cover its requirements.
    store.change(first.id, (row) => {
      row.specification = {
        status: SpecStatus.Interrogating,
        version: 1,
        draft: null,
        acceptedRevision: row.revision,
      };
    });
    await assert.rejects(save(), /Freeze the specification/u);
    assert.equal(store.list(project).length, 1);
    store.change(first.id, (row) => {
      assert.ok(row.specification !== undefined);
      row.specification.status = SpecStatus.Frozen;
    });
    await assert.rejects(save(), /Cover every frozen requirement/u);
    store.change(first.id, (row) => {
      row.specification = undefined;
      row.approved = "approved";
    });
    await assert.rejects(save(), /already approved/u);
    assert.equal(session.getLeafId(), marker.id);

    // A fresh session cannot inherit the previous session's selected discovery.
    session.newSession();
    await save();
    const second = store.list(project)[0];
    assert.ok(second !== undefined);
    assert.notEqual(second.id, first.id);
    assert.equal(second.conversation, session.getSessionId());
    assert.equal(store.get(first.id).approved, "approved");
    const authority = randomUUID();
    store.beginHandoff(second, {
      ...runtimeProjectSchema.parse({
        root: project,
        source: { url: "http://127.0.0.1:9", projectId: authority },
        profile: StudioProfile.Personal,
        base: "main",
        beadsWorkspace: project,
        beadsDatabase: "fixture",
      }),
      id: authority,
    });
    const pending = store.get(second.id);
    await assert.rejects(save(revised), /handoff is pending or uncertain/u);
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
    await save(revised);
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
  } finally {
    if (previousState === undefined) delete process.env["STUDIO_STATE_DIR"];
    else process.env["STUDIO_STATE_DIR"] = previousState;
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
