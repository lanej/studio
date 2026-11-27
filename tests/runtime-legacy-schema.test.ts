import { afterEach, beforeEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ExecutionStore, ExecutionPhase } from "../execution/store.ts";
import { StudioProfile } from "../config.ts";
import { projectSchema } from "../execution/target.ts";
import type { RuntimeProject } from "../execution/target.ts";

describe("runtime legacy schema compatibility", () => {
  let directory: string;
  let store: ExecutionStore;

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "studio-legacy-schema-")));
    store = new ExecutionStore(directory);
  });

  afterEach(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("reads legacy project record with claimLabel field", () => {
    const projectId = randomUUID();
    const legacyRecord = {
      id: projectId,
      root: "/test/workspace",
      source: {
        url: "http://beads.example/v0",
        projectId,
      },
      profile: StudioProfile.Personal,
      base: "main",
      merge: false,
      beadsWorkspace: "/test/workspace",
      beadsExecutable: "bd",
      beadsDatabase: "fixture",
      verificationReadPaths: [],
      // Legacy field from older release
      claimLabel: "legacy-claim-label",
    };

    // Simulate a legacy enrollment already in the database
    store.transaction(() => {
      store["save"]("project", projectId, legacyRecord);
    });

    // Should read the legacy record without error
    const retrieved = store.project(projectId);
    assert.equal(retrieved.id, projectId);
    assert.equal(retrieved.root, "/test/workspace");
    assert.equal(retrieved.profile, StudioProfile.Personal);

    // Should also work for projects() listing
    const all = store.projects();
    assert.equal(all.length, 1);
    assert.equal(all[0]?.id, projectId);
  });

  it("reads multiple legacy projects with retained attempts", () => {
    const projectId1 = randomUUID();
    const projectId2 = randomUUID();
    const attemptId = randomUUID();

    const legacyProject1 = {
      id: projectId1,
      root: "/test/workspace1",
      source: { url: "http://beads.example/v0", projectId: projectId1 },
      profile: StudioProfile.Personal,
      base: "main",
      merge: false,
      beadsWorkspace: "/test/workspace1",
      beadsExecutable: "bd",
      beadsDatabase: "fixture",
      verificationReadPaths: [],
      claimLabel: "legacy-label-1",
    };

    const legacyProject2 = {
      id: projectId2,
      root: "/test/workspace2",
      source: { url: "http://beads.example/v0", projectId: projectId2 },
      profile: StudioProfile.Work,
      base: "develop",
      merge: true,
      beadsWorkspace: "/test/workspace2",
      beadsExecutable: "bd",
      beadsDatabase: "fixture2",
      verificationReadPaths: [],
      claimLabel: "legacy-label-2",
    };

    const attempt = {
      id: attemptId,
      project: projectId1,
      profile: StudioProfile.Personal,
      phase: ExecutionPhase.Queued,
      message: "Legacy attempt",
      recoveries: 0,
      launchSettled: false,
      sessions: [],
      owns: ["legacy.txt"],
      check: [],
      events: [],
      summary: "",
      heartbeatAt: 0,
    };

    store.transaction(() => {
      store["save"]("project", projectId1, legacyProject1);
      store["save"]("project", projectId2, legacyProject2);
      store["save"]("attempt", attemptId, attempt);
    });

    // Should read all projects
    const projects = store.projects();
    assert.equal(projects.length, 2);
    const project1 = projects.find((p) => p.id === projectId1);
    const project2 = projects.find((p) => p.id === projectId2);
    assert(project1 !== undefined);
    assert(project2 !== undefined);
    assert.equal(project1.profile, StudioProfile.Personal);
    assert.equal(project2.profile, StudioProfile.Work);

    // Should read individual project
    const retrieved = store.project(projectId1);
    assert.equal(retrieved.id, projectId1);

    // Should read attempt
    const attempts = store.attempts();
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.project, projectId1);
  });

  it("reads legacy handoff intent with target containing claimLabel", () => {
    const projectId = randomUUID();
    const revisionId = randomUUID();

    const legacyTarget: RuntimeProject = {
      id: projectId,
      root: "/test/workspace",
      source: { url: "http://beads.example/v0", projectId },
      profile: StudioProfile.Personal,
      base: "main",
      merge: false,
      beadsWorkspace: "/test/workspace",
      beadsExecutable: "bd",
      beadsDatabase: "fixture",
      verificationReadPaths: [],
    };

    const legacyIntent = {
      digest: "test-digest",
      ids: { root: "root-id", task1: "root-id.task1" },
      project: projectId,
      target: {
        ...legacyTarget,
        // Legacy field embedded in target
        claimLabel: "legacy-claim-in-target",
      },
      draft: {
        summary: "Legacy draft",
        tasks: [
          {
            key: "task1",
            title: "Legacy task",
            description: "Legacy task description",
            acceptance: "Task completes successfully",
            owns: ["legacy.txt"],
          },
        ],
      },
    };

    store.transaction(() => {
      store["save"]("handoff", revisionId, legacyIntent);
    });

    // Should read the legacy handoff intent without error
    const retrieved = store.intent(revisionId);
    assert(retrieved !== undefined);
    assert.equal(retrieved.digest, "test-digest");
    assert.equal(retrieved.project, projectId);
    assert(retrieved.target !== undefined);
    assert.equal(retrieved.target.id, projectId);

    // Should also work for taskHandoffIntent
    const byTask = store.taskHandoffIntent(projectId, "root-id.task1");
    assert(byTask !== undefined);
    assert.equal(byTask.id, revisionId);
    assert.equal(byTask.digest, "test-digest");
  });

  it("rejects new enrollment with claimLabel using strict schema", () => {
    const projectId = randomUUID();
    const invalidProject = {
      id: projectId,
      root: directory,
      source: { url: "http://beads.example/v0", projectId },
      profile: StudioProfile.Personal,
      base: "main",
      merge: false,
      beadsWorkspace: directory,
      beadsExecutable: "bd",
      beadsDatabase: "fixture",
      verificationReadPaths: [],
      // This should be rejected by strict validation
      claimLabel: "new-invalid-label",
    };

    // The strict projectSchema should reject this
    assert.throws(
      () => {
        projectSchema.parse(invalidProject);
      },
      (error: unknown) => {
        const message = String(error);
        return message.includes("Unrecognized key") || message.includes("claimLabel");
      },
    );
  });

  it("preserves the historical claim restriction even without active attempts", () => {
    const projectId = randomUUID();
    // Use absolute path that actually exists for realpathSync
    const workspaceRoot = process.cwd();

    const legacyRecord = {
      id: projectId,
      root: workspaceRoot,
      source: { url: "http://beads.example/v0", projectId },
      profile: StudioProfile.Personal,
      base: "main",
      merge: false,
      beadsWorkspace: workspaceRoot,
      beadsExecutable: "bd",
      beadsDatabase: "fixture",
      verificationReadPaths: [],
      claimLabel: "legacy-preserved",
    };

    // Store legacy record
    store.transaction(() => {
      store["save"]("project", projectId, legacyRecord);
    });

    const retrieved = store.project(projectId);
    assert.equal(retrieved.id, projectId);
    assert.equal(Reflect.get(retrieved, "claimLabel"), "legacy-preserved");

    // Create a clean project for re-enrollment (without claimLabel)
    const cleanProject: RuntimeProject = {
      id: projectId,
      root: workspaceRoot,
      source: { url: "http://beads.example/v0", projectId },
      profile: StudioProfile.Personal,
      base: "main",
      merge: true, // Changed setting
      beadsWorkspace: workspaceRoot,
      beadsExecutable: "bd",
      beadsDatabase: "fixture",
      verificationReadPaths: [],
    };

    assert.throws(() => {
      store.enroll(cleanProject);
    }, /reconcile its claim scope/);
    assert.deepEqual(store.project(projectId), retrieved);
  });

  it("allows status read with legacy enrollment", () => {
    const projectId = randomUUID();
    const attemptId = randomUUID();

    const legacyProject = {
      id: projectId,
      root: "/test/workspace",
      source: { url: "http://beads.example/v0", projectId },
      profile: StudioProfile.Personal,
      base: "main",
      merge: false,
      beadsWorkspace: "/test/workspace",
      beadsExecutable: "bd",
      beadsDatabase: "fixture",
      verificationReadPaths: [],
      claimLabel: "legacy-status-test",
    };

    const attempt = {
      id: attemptId,
      project: projectId,
      profile: StudioProfile.Personal,
      phase: ExecutionPhase.Running,
      message: "Running attempt",
      recoveries: 0,
      launchSettled: false,
      sessions: [],
      owns: ["running.txt"],
      check: [],
      events: [],
      summary: "Test summary",
      heartbeatAt: Date.now(),
    };

    store.transaction(() => {
      store["save"]("project", projectId, legacyProject);
      store["save"]("attempt", attemptId, attempt);
    });

    // Status read should work: list all projects and their attempts
    const projects = store.projects();
    assert.equal(projects.length, 1);
    assert.equal(projects[0]?.id, projectId);

    const attempts = store.attempts();
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.id, attemptId);
    assert.equal(attempts[0].project, projectId);
    assert.equal(attempts[0].phase, ExecutionPhase.Running);
  });

  it("allows safe unrelated handoff preflight with legacy project", () => {
    const projectId1 = randomUUID();
    const projectId2 = randomUUID();
    const attemptId = randomUUID();
    const revisionId = randomUUID();

    // Legacy project with retained attempt
    const legacyProject = {
      id: projectId1,
      root: "/test/workspace1",
      source: { url: "http://beads.example/v0", projectId: projectId1 },
      profile: StudioProfile.Personal,
      base: "main",
      merge: false,
      beadsWorkspace: "/test/workspace1",
      beadsExecutable: "bd",
      beadsDatabase: "fixture",
      verificationReadPaths: [],
      claimLabel: "legacy-with-attempt",
    };

    // Current project without legacy field
    const currentProject = {
      id: projectId2,
      root: directory,
      source: { url: "http://beads.example/v0", projectId: projectId2 },
      profile: StudioProfile.Personal,
      base: "main",
      merge: false,
      beadsWorkspace: "/test/workspace2",
      beadsExecutable: "bd",
      beadsDatabase: "fixture",
      verificationReadPaths: [],
    };

    // Retained attempt for legacy project
    const retainedAttempt = {
      id: attemptId,
      project: projectId1,
      profile: StudioProfile.Personal,
      phase: ExecutionPhase.Running,
      message: "Retained legacy attempt",
      recoveries: 0,
      launchSettled: true,
      sessions: [],
      owns: ["legacy-owned.txt"],
      check: [],
      events: [],
      summary: "",
      heartbeatAt: Date.now(),
    };

    // Handoff intent for unrelated project
    const unrelatedIntent = {
      digest: "unrelated-digest",
      ids: { root: "root-id", unrelated: "root-id.unrelated" },
      project: projectId2,
      target: currentProject,
      draft: {
        summary: "Unrelated work",
        tasks: [
          {
            key: "unrelated",
            title: "Unrelated task",
            description: "Work not affected by legacy project",
            acceptance: "Task completes",
            owns: ["unrelated.txt"],
          },
        ],
      },
    };

    store.transaction(() => {
      store["save"]("project", projectId1, legacyProject);
      store["save"]("project", projectId2, currentProject);
      store["save"]("attempt", attemptId, retainedAttempt);
      store["save"]("handoff", revisionId, unrelatedIntent);
    });

    // Should be able to read legacy project with attempt
    const legacy = store.project(projectId1);
    assert.equal(legacy.id, projectId1);

    const attempts = store.attempts().filter((a) => a.project === projectId1);
    assert.equal(attempts.length, 1);

    // Should be able to read unrelated handoff intent
    const intent = store.intent(revisionId);
    assert(intent !== undefined);
    assert.equal(intent.project, projectId2);
    assert(intent.target !== undefined);
    assert.equal(intent.target.id, projectId2);

    assert.equal(store.validateEnrollment(store.project(projectId2)).id, projectId2);
  });
});
