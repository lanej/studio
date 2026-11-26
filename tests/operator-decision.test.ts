import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { StudioProfile } from "../config.ts";
import { processStart } from "../process.ts";
import {
  ExecutionStore,
  ExecutionPhase,
  VerificationPhase,
  executionSchema,
  pendingDecision,
  latestDecision,
} from "../execution/store.ts";
import { projectSchema } from "../execution/target.ts";
import {
  recordDecision,
  answerDecision,
  requireDecisionPublicationReconciled,
} from "../execution/decisions.ts";
import { retryAttempt } from "../execution/cli.ts";
import { reconcileAttempt } from "../execution/recovery.ts";
import { retainedConflicts } from "../execution/admission.ts";
import { maintainAttempt } from "../execution/supervisor.ts";
import {
  parseBackgroundResult,
  resumeReviewedAssignment,
} from "../execution/worker.ts";
import { TaskDelivery } from "../planning/plan.ts";

await test("background question results are disjoint and new answers cannot reuse old approval", async () => {
  assert.deepEqual(
    parseBackgroundResult({
      operatorDecision: { question: "Which accepted marker?" },
    }),
    { operatorDecision: { question: "Which accepted marker?" } },
  );
  for (const value of [
    { operatorDecision: { question: "" } },
    { operatorDecision: { question: "q" }, summary: "done" },
    { operatorDecision: { question: "q", scope: "expanded" } },
  ])
    assert.throws(() => parseBackgroundResult(value));
  assert.deepEqual(parseBackgroundResult({ summary: "done" }), {
    summary: "done",
  });
  assert.throws(() =>
    parseBackgroundResult(
      { summary: "done", title: "" },
      TaskDelivery.PullRequest,
    ),
  );
  const record = executionSchema.parse({
    id: randomUUID(),
    project: randomUUID(),
    profile: StudioProfile.Personal,
    phase: ExecutionPhase.Delivery,
    head: "approved",
    review: "approved",
    message: "retained",
    check: [],
    verifier: { phase: VerificationPhase.Complete },
    verification: {
      summary: "no command",
      check: [],
      exitCode: null,
      gitHead: "precommit",
      gitState: "tree",
      output: "",
    },
  });
  let implemented = 0;
  let resumed = 0;
  const implement = () => {
    implemented++;
    return Promise.resolve();
  };
  await resumeReviewedAssignment(record, implement, () => {
    resumed++;
  });
  record.operatorDecisions = [
    {
      id: randomUUID(),
      question: "q",
      at: "now",
      binding: {
        project: record.project,
        bead: "b",
        revision: "r",
        launchToken: randomUUID(),
        contract: "0".repeat(64),
      },
      answer: { text: "answer", at: "now" },
    },
  ];
  await resumeReviewedAssignment(record, implement, () => {
    resumed++;
  });
  assert.equal(implemented, 1);
  assert.equal(resumed, 1);
});

await test("answering revalidates exact request, writer, admission, authority and whole-record CAS; acknowledgement replay has no queue effect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-decision-"));
  const previousState = process.env["STUDIO_STATE_DIR"],
    previousConfig = process.env["STUDIO_CONFIG"];
  process.env["STUDIO_STATE_DIR"] = directory;
  process.env["STUDIO_CONFIG"] = join(directory, "config.json");
  const store = new ExecutionStore();
  const id = randomUUID(),
    projectId = randomUUID();
  const initial = executionSchema.parse({
    id,
    project: projectId,
    profile: StudioProfile.Personal,
    phase: ExecutionPhase.Running,
    launchToken: randomUUID(),
    launchSettled: true,
    message: "working",
    revision: "r",
    owns: ["source.txt"],
    check: ["verify"],
    bead: {
      id: "native-task",
      title: "Accepted task",
      description: "scope",
      acceptance_criteria: "criterion",
      status: "in_progress",
      assignee: `pi:${id}`,
      revision: "r",
      metadata: { "pi.attempt": id },
    },
  });
  assert.ok(initial.bead !== undefined);
  let remote = initial.bead;
  let race = () => {};
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/v0/beads/context")
      response.end(
        JSON.stringify({
          project_id: projectId,
          backend: "dolt",
          dolt_mode: "server",
          capabilities: [
            "project.enforce",
            "issues.get",
            "issues.create",
            "issues.update",
          ],
        }),
      );
    else {
      race();
      response.end(JSON.stringify(remote));
    }
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const project = projectSchema.parse({
      id: projectId,
      profile: StudioProfile.Personal,
      root: directory,
      base: "HEAD",
      beadsWorkspace: directory,
      beadsDatabase: "fixture",
      source: { url: `http://127.0.0.1:${String(address.port)}`, projectId },
    });
    store.enroll(project);
    await writeFile(
      process.env["STUDIO_CONFIG"],
      JSON.stringify({
        runtime: { enabled: false, projects: [{ ...project, id: undefined }] },
      }),
    );
    store.saveAttempt(initial);
    recordDecision(store, id, "Which accepted marker?");
    const waiting = store.attempt(id);
    const request = pendingDecision(waiting);
    assert.ok(request !== undefined);
    await assert.rejects(retryAttempt(id), /operator decision is pending/u);
    store.saveAttempt({ ...waiting, phase: ExecutionPhase.Uncertain });
    await assert.rejects(retryAttempt(id), /operator decision is pending/u);
    await assert.rejects(
      answerDecision(id, request.id, "answer"),
      /not settled/u,
    );
    store.saveAttempt(waiting);
    await assert.rejects(
      answerDecision(id, randomUUID(), "answer"),
      /stale or superseded/u,
    );
    for (const changed of [
      { ...waiting, bead: undefined },
      { ...waiting, owns: ["expanded"] },
      { ...waiting, revision: "changed" },
    ]) {
      store.saveAttempt(changed);
      await assert.rejects(
        answerDecision(id, request.id, "answer"),
        /binding or scope changed/u,
      );
    }
    store.saveAttempt({
      ...waiting,
      pid: process.pid,
      started: await processStart(process.pid),
    });
    await assert.rejects(
      answerDecision(id, request.id, "answer"),
      /live or uncertain/u,
    );
    store.saveAttempt({
      ...waiting,
      launchSettled: false,
      pid: undefined,
      started: undefined,
    });
    await assert.rejects(
      answerDecision(id, request.id, "answer"),
      /live or uncertain/u,
    );
    store.saveAttempt(waiting);
    remote = { ...initial.bead, assignee: "another-owner" };
    await assert.rejects(
      answerDecision(id, request.id, "answer"),
      /revision or owner changed/u,
    );
    remote = { ...initial.bead, revision: "changed" };
    await assert.rejects(
      answerDecision(id, request.id, "answer"),
      /revision or owner changed/u,
    );
    remote = initial.bead;
    race = () => {
      store.change(id, (row) => {
        row.check = ["changed"];
      });
    };
    await assert.rejects(
      answerDecision(id, request.id, "answer"),
      /attempt or project changed/u,
    );
    race = () => {};
    store.saveAttempt(waiting);
    race = () => {
      store.enroll({ ...project, merge: !project.merge });
    };
    await assert.rejects(
      answerDecision(id, request.id, "answer"),
      /attempt or project changed/u,
    );
    race = () => {};
    store.enroll(project);
    store.saveAttempt(waiting);
    store.saveAttempt({
      ...waiting,
      launchSettled: false,
      pid: 2147483647,
      started: "confirmed absent fixture PID",
    });
    await reconcileAttempt(store, project, id);
    assert.equal(store.attempt(id).phase, ExecutionPhase.AwaitingDecision);
    assert.equal(store.attempt(id).launchSettled, true);
    assert.deepEqual(
      store.attempt(id).operatorDecisions,
      waiting.operatorDecisions,
    );
    assert.equal(store.attempt(id).recoveries, 0);
    store.saveAttempt(waiting);
    let heartbeat = 0;
    await maintainAttempt(store, project, id, {
      reconcile: reconcileAttempt,
      heartbeat: () => {
        heartbeat++;
        return Promise.resolve();
      },
    });
    assert.equal(heartbeat, 1);
    assert.equal(store.attempt(id).phase, ExecutionPhase.AwaitingDecision);
    assert.equal(pendingDecision(store.attempt(id))?.id, request.id);
    const overlap = executionSchema.parse({
      ...initial,
      id: randomUUID(),
      phase: ExecutionPhase.Queued,
      bead: { ...initial.bead, id: "blocked" },
    });
    assert.deepEqual(
      Array.from(
        retainedConflicts(overlap, [store.attempt(id), overlap]),
        ({ blocker }) => blocker.id,
      ),
      [id],
    );
    const simultaneous = await Promise.allSettled([
      answerDecision(id, request.id, "accepted marker"),
      answerDecision(id, request.id, "accepted marker"),
    ]);
    assert.equal(
      simultaneous.filter((entry) => entry.status === "fulfilled").length,
      1,
    );
    const queued = simultaneous.find((entry) => entry.status === "rejected");
    assert.ok(queued?.status === "rejected");
    assert.match(
      String(queued.reason),
      /Answer recorded and queued.*disabled/u,
    );
    const answered = store.attempt(id);
    assert.equal(answered.phase, ExecutionPhase.Queued);
    assert.equal(answered.operatorDecisions?.length, 1);
    assert.equal(latestDecision(answered)?.answer?.text, "accepted marker");
    assert.equal(answered.launchToken, undefined);
    await mkdir(join(directory, "delivery", id), { recursive: true });
    await writeFile(
      join(directory, "delivery", id, "publication.json"),
      JSON.stringify({ head: "retained-approved-head" }),
    );
    assert.throws(() => {
      requireDecisionPublicationReconciled(answered, directory);
    }, /prior publication must be reconciled/u);
    assert.doesNotThrow(() => {
      requireDecisionPublicationReconciled(
        { ...answered, operatorDecisions: undefined },
        directory,
      );
    });
    const replay = await answerDecision(id, request.id, "accepted marker");
    assert.equal(replay.request, request.id);
    assert.deepEqual(store.attempt(id), answered);
    await assert.rejects(
      answerDecision(id, request.id, "different"),
      /different answer/u,
    );
    assert.equal(
      store.attempts().filter((row) => row.bead?.id === initial.bead?.id)
        .length,
      1,
    );
    store.saveAttempt({
      ...answered,
      phase: ExecutionPhase.Running,
      launchToken: randomUUID(),
    });
    recordDecision(store, id, "A new specific question");
    await assert.rejects(
      answerDecision(id, request.id, "accepted marker"),
      /stale or superseded/u,
    );
  } finally {
    store.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    if (previousState === undefined) delete process.env["STUDIO_STATE_DIR"];
    else process.env["STUDIO_STATE_DIR"] = previousState;
    if (previousConfig === undefined) delete process.env["STUDIO_CONFIG"];
    else process.env["STUDIO_CONFIG"] = previousConfig;
    await rm(directory, { recursive: true, force: true });
  }
});
