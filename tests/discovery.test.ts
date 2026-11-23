import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { Discoveries, HandoffPhase } from "../discovery/store.ts";
import { draftSchema } from "../lead-plan.ts";
import { runtimeProjectSchema, StudioProfile } from "../config.ts";
import {
  ExecutionStore,
  executionSchema,
  ExecutionPhase,
} from "../execution/store.ts";
import { writerFence } from "../execution/recovery.ts";
import { ExecutionBeads } from "../execution/beads.ts";
import { beadSchema } from "../task-service.ts";

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
          acceptance: "Verified result",
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
      record.leadPlan.draft = { ...draft, summary: "Changed by another lead" };
    });
    assert.throws(
      () => store.beginHandoff(displayed, authority),
      /changed before approval/u,
    );
    const current = peer.get(discovery.id);
    const frozen = store.beginHandoff(current, authority, {
      pid: process.pid,
      started: "fixture-start",
    });
    assert.equal(frozen.handoff?.phase, HandoffPhase.Pending);
    assert.throws(
      () =>
        peer.change(discovery.id, (record) => {
          record.revision = randomUUID();
        }),
      /handoff is pending/u,
    );
    assert.throws(
      () => peer.beginHandoff(current, authority),
      /already in progress/u,
    );
    assert.equal(peer.get(other.id).title, "Separate discovery");
    const retry = peer.beginHandoff(
      peer.get(discovery.id),
      authority,
      { pid: process.pid, started: "recovered-owner" },
      true,
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
        ),
      /original project authority/u,
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
