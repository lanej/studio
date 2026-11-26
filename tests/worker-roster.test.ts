import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Attempts, Phase, attemptSchema } from "../attempts.ts";
import {
  ExecutionPhase,
  ExecutionStore,
  VerificationPhase,
  executionSchema,
} from "../execution/store.ts";
import { owner } from "../task-service.ts";
import { readTaskEvidence } from "../tasks/evidence.ts";
import { workerAssignments } from "../tasks/workers.ts";

const project = randomUUID();
function assignment(beadId: string, phase = ExecutionPhase.Running) {
  const id = randomUUID();
  const task = {
    id: beadId,
    title: beadId,
    assignee: owner(id),
    status: "in_progress",
  };
  const attempt = executionSchema.parse({
    id,
    project,
    phase,
    revision: "1",
    bead: { ...task, revision: "1" },
    launchToken: randomUUID(),
    profile: "personal",
    message: "",
  });
  return { task, attempt };
}

await test("worker rows require an in-progress linked task, the exact Beads owner, project and matching receipt", () => {
  const a = assignment("graph-a");
  const b = assignment("graph-b", ExecutionPhase.Reviewing);
  const c = assignment("another-plan");
  const past = assignment("graph-a", ExecutionPhase.Parked);
  const evidence = {
    attempts: [c.attempt, past.attempt, b.attempt, a.attempt],
  };
  const rows = workerAssignments(project, [a.task, b.task], evidence);
  assert.deepEqual(
    rows.map(({ attemptId, title, role, phase }) => ({
      attemptId,
      title,
      role,
      phase,
    })),
    [
      {
        attemptId: a.attempt.id,
        title: "graph-a",
        role: "Worker",
        phase: "Implementing",
      },
      {
        attemptId: b.attempt.id,
        title: "graph-b",
        role: "Reviewer",
        phase: "Reviewing",
      },
    ],
  );
  for (const task of [
    { ...a.task, id: "another-task" },
    { ...a.task, assignee: "" },
    { ...a.task, assignee: "someone-else" },
    { ...a.task, status: "closed" },
    { ...a.task, status: "blocked" },
  ])
    assert.deepEqual(workerAssignments(project, [task], evidence), []);
  assert.deepEqual(workerAssignments(randomUUID(), [a.task], evidence), []);
  assert.deepEqual(
    workerAssignments(project, [a.task], { attempts: [a.attempt, a.attempt] }),
    [],
  );
  const elsewhere = assignment("graph-a");
  assert.deepEqual(workerAssignments(project, [elsewhere.task], evidence), [
    {
      beadId: "graph-a",
      title: elsewhere.task.title,
      attemptId: elsewhere.attempt.id,
      role: "Attempt",
      phase: "Status unavailable",
      activity: "unknown",
      focusable: false,
    },
  ]);
  assert.deepEqual(
    workerAssignments(project, [{ ...a.task, assignee: "pi:invalid" }], {
      attempts: [],
    }),
    [],
  );
  assert.deepEqual(
    workerAssignments(project, [a.task], {
      attempts: [{ ...a.attempt, phase: ExecutionPhase.Complete }],
    }),
    [],
  );
});

await test("a retained operator question comes first; reviewing, waiting for capacity and an active verifier report distinct actors", () => {
  const waiting = assignment("slot", ExecutionPhase.Waiting);
  const review = assignment("review", ExecutionPhase.Reviewing);
  const verifying = assignment("checks");
  const parked = assignment("parked", ExecutionPhase.Parked);
  const decision = assignment("input", ExecutionPhase.AwaitingDecision);
  const question = {
    id: randomUUID(),
    at: "",
    question: "Where should focus return?",
    binding: {
      project,
      bead: decision.task.id,
      revision: "1",
      launchToken: randomUUID(),
      contract: "b".repeat(64),
    },
  };
  const tasks = [
    waiting.task,
    review.task,
    verifying.task,
    parked.task,
    decision.task,
  ];
  const evidence = {
    attempts: [
      {
        ...decision.attempt,
        launchToken: question.binding.launchToken,
        operatorDecisions: [question],
      },
      { ...verifying.attempt, verifier: { phase: VerificationPhase.Running } },
      { ...review.attempt, verifier: { phase: VerificationPhase.Complete } },
      {
        ...parked.attempt,
        message: "Worker asked something",
        reviewFinding: "Restore focus",
      },
      waiting.attempt,
    ],
  };
  const rows = workerAssignments(project, tasks, evidence);
  assert.deepEqual(
    rows.map((row) => [row.beadId, row.phase, row.activity]),
    [
      ["input", "Needs input", "attention"],
      ["parked", "Changes requested", "attention"],
      ["review", "Reviewing", "active"],
      ["checks", "Verifying", "active"],
      ["slot", "Waiting for capacity", "waiting"],
    ],
  );
  assert.equal(rows[0]?.question, question.question);
  assert.equal(rows[1]?.question, undefined);
  const answered = { ...question, answer: { text: "Parent", at: "" } };
  const [resumed] = workerAssignments(project, [decision.task], {
    attempts: [
      {
        ...decision.attempt,
        phase: ExecutionPhase.Running,
        operatorDecisions: [answered],
      },
    ],
  });
  assert.equal(resumed?.activity, "active");
  assert.equal(resumed.question, undefined);
});

await test("a registered pane is attached to its attempt and worker phase; interactive lead children retain their role", () => {
  const old = process.env["ZELLIJ_SESSION_NAME"];
  const session = "roster-test";
  try {
    process.env["ZELLIJ_SESSION_NAME"] = session;
    const { task, attempt } = assignment("child");
    const interactive = {
      ...attempt,
      interactive: { session, socket: "socket", tab: 0 },
      pane: 3,
      workerSessionFile: "/session",
      started: "start",
      pid: 1,
    };
    const rows = workerAssignments(project, [task], {
      attempts: [interactive],
    });
    assert.equal(rows[0]?.focusable, true);
    for (const stale of [
      {
        ...interactive,
        interactive: { ...interactive.interactive, session: "different" },
      },
      { ...interactive, phase: ExecutionPhase.Reviewing },
      { ...interactive, launchSettled: true },
      { ...interactive, verifier: { phase: VerificationPhase.Running } },
    ])
      assert.equal(
        workerAssignments(project, [task], { attempts: [stale] })[0]?.focusable,
        false,
      );

    const local = attemptSchema.parse({
      id: attempt.id,
      source: { url: "http://localhost", projectId: project },
      bead: { ...task, revision: "1" },
      revision: "1",
      check: [],
      profile: "personal",
      model: { provider: "openai-codex", model: "model", reasoning: "off" },
      live: true,
      processStarted: "start",
      pid: 1,
      pane: 0,
      session,
      zellijSocket: "socket",
      reservation: {
        primary: "/project",
        root: "/worktrees",
        holder: attempt.id,
        agent: "pi",
        branch: "child",
        baseRef: "main",
        baseCommit: "a".repeat(40),
        attempted: true,
      },
      checkout: {
        primary: "/project",
        root: "/worktrees",
        path: "/worktrees/child",
        task_id: task.id,
        owner_id: attempt.id,
        agent: "pi",
        branch: "child",
        created_at: "date",
        base_ref: "main",
      },
      transcript: null,
      phase: Phase.Running,
      verification: null,
      message: "",
    });
    const managed = (row: typeof local) =>
      workerAssignments(project, [task], {
        attempts: [],
        interactiveAttempts: [row],
      })[0];
    assert.equal(managed(local)?.role, "Worker");
    assert.equal(managed(local)?.focusable, true);
    assert.equal(managed({ ...local, live: false })?.activity, "attention");
    assert.equal(managed({ ...local, session: "another" })?.focusable, false);
    assert.equal(
      managed(
        attemptSchema.parse({
          ...local,
          leadPlan: { mode: "planning", draft: null },
        }),
      )?.role,
      "Lead",
    );
    assert.equal(managed({ ...local, phase: Phase.Closed }), undefined);
  } finally {
    if (old === undefined) delete process.env["ZELLIJ_SESSION_NAME"];
    else process.env["ZELLIJ_SESSION_NAME"] = old;
  }
});

await test("reading current owner IDs skips unrelated malformed receipts and leaves missing stores absent", () => {
  const directory = mkdtempSync(join(tmpdir(), "studio-worker-evidence-"));
  const current = assignment("current");
  const previous = assignment("current");
  const owners = [current.attempt.id];
  try {
    assert.deepEqual(readTaskEvidence(project, directory, owners), {
      attempts: [],
    });
    assert.deepEqual(readdirSync(directory), []);

    const store = new ExecutionStore(directory);
    try {
      store.saveAttempt(current.attempt);
      store.saveAttempt(previous.attempt);
    } finally {
      store.close();
    }
    const staleId = randomUUID();
    const malformed = JSON.stringify({ project, phase: "no-longer-supported" });
    const runtimeDb = new Database(join(directory, "runtime.sqlite"));
    try {
      runtimeDb
        .query("INSERT INTO records (kind,id,record) VALUES ('attempt',?,?)")
        .run(staleId, malformed);
    } finally {
      runtimeDb.close();
    }

    new Attempts(directory).close();
    const localDb = new Database(join(directory, "attempts.sqlite"));
    try {
      localDb
        .query(
          "INSERT INTO attempts (id,project,bead,active,record) VALUES (?,?,?,0,?)",
        )
        .run(staleId, project, previous.task.id, malformed);
    } finally {
      localDb.close();
    }

    const filtered = readTaskEvidence(project, directory, owners);
    assert.deepEqual(filtered, {
      attempts: [current.attempt],
      interactiveAttempts: [],
    });
    assert.deepEqual(readTaskEvidence(project, directory, []), {
      attempts: [],
      interactiveAttempts: [],
    });
    const malformedEvidence = readTaskEvidence(project, directory, [staleId]);
    assert.notEqual(malformedEvidence.evidenceError, undefined);
    assert.notEqual(malformedEvidence.interactiveEvidenceError, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
