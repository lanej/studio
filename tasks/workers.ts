import { z } from "zod";
import { Phase, type Attempt } from "../attempts.ts";
import { knownTaskStatus, TaskStatus } from "../beads.ts";
import { hasInteractivePane } from "../execution/interactive-target.ts";
import {
  ExecutionPhase,
  pendingDecision,
  VerificationPhase,
  type Execution,
} from "../execution/store.ts";
import { owner, type NativeBead } from "../task-service.ts";
import type { readTaskEvidence } from "./evidence.ts";

interface WorkerState {
  role: "Worker" | "Lead" | "Reviewer" | "Verifier" | "Controller" | "Attempt";
  phase: string;
  activity: "active" | "waiting" | "attention" | "unknown";
  question?: string;
}

export interface WorkerAssignment extends WorkerState {
  beadId: string;
  attemptId: string;
  title: string;
  focusable: boolean;
}

function state(
  role: WorkerState["role"],
  phase: string,
  activity: WorkerState["activity"] = "active",
): WorkerState {
  return { role, phase, activity };
}

function runtimeState(attempt: Execution): WorkerState | undefined {
  switch (attempt.phase) {
    case ExecutionPhase.Complete:
      return undefined;
    case ExecutionPhase.Queued:
      return state("Controller", "Queued", "waiting");
    case ExecutionPhase.Claiming:
      return state("Controller", "Claiming");
    case ExecutionPhase.Allocating:
      return state("Controller", "Preparing checkout");
    case ExecutionPhase.Launching:
      return state("Worker", "Starting");
    case ExecutionPhase.AwaitingDecision: {
      const question = pendingDecision(attempt)?.question;
      return question === undefined
        ? state("Worker", "Inspect decision", "attention")
        : { ...state("Worker", "Needs input", "attention"), question };
    }
    case ExecutionPhase.Parked:
      if (attempt.reviewFinding !== undefined)
        return state("Worker", "Changes requested", "attention");
      if (
        typeof attempt.verification?.exitCode === "number" &&
        attempt.verification.exitCode !== 0
      )
        return state("Verifier", "Check failed", "attention");
      return state("Controller", "Needs inspection", "attention");
    case ExecutionPhase.Uncertain:
      return state("Controller", "Outcome unknown", "attention");
    case ExecutionPhase.Waiting:
      return state("Worker", "Waiting for capacity", "waiting");
    case ExecutionPhase.Delivery:
      return state("Controller", "Awaiting delivery", "waiting");
    case ExecutionPhase.Running:
    case ExecutionPhase.Reviewing:
    case ExecutionPhase.Integrating:
      // Integration also verifies the merged tree. A prior completed receipt
      // must not obscure the actor responsible for the current phase.
      if (
        attempt.verifier !== undefined &&
        attempt.verifier.phase !== VerificationPhase.Complete
      )
        return state("Verifier", "Verifying");
      if (attempt.phase === ExecutionPhase.Reviewing)
        return state("Reviewer", "Reviewing");
      if (attempt.phase === ExecutionPhase.Integrating)
        return state("Controller", "Integrating");
      return state(
        "Worker",
        attempt.reviewFinding === undefined ? "Implementing" : "Revising",
      );
  }
}

function localState(attempt: Attempt): WorkerState | undefined {
  const role = attempt.leadPlan === undefined ? "Worker" : "Lead";
  switch (attempt.phase) {
    case Phase.Admitting:
      return state("Controller", "Claiming");
    case Phase.Allocating:
      return state("Controller", "Preparing checkout");
    case Phase.Launching:
      return state(role, "Starting");
    case Phase.Running:
      return attempt.live
        ? state(role, "Session open")
        : state(role, "Session ended", "attention");
    case Phase.Checking:
      return state("Verifier", "Verifying");
    case Phase.CheckFailed:
      return state("Verifier", "Check failed", "attention");
    case Phase.Verified:
      return state("Controller", "Awaiting delivery", "waiting");
    case Phase.NeedsReview:
      return state(role, "Needs review", "attention");
    case Phase.Reconcile:
      return state("Controller", "Needs inspection", "attention");
    case Phase.Archiving:
    case Phase.Archived:
    case Phase.Closed:
    case Phase.Rejected:
      return undefined;
  }
}

function hasLocalPane(attempt: Attempt): boolean {
  return (
    attempt.live &&
    attempt.session === process.env["ZELLIJ_SESSION_NAME"] &&
    attempt.pane !== null &&
    attempt.pid !== null &&
    attempt.processStarted !== null &&
    attempt.zellijSocket !== undefined &&
    attempt.checkout !== null &&
    attempt.revision !== null
  );
}

type LinkedTask = Pick<NativeBead, "id" | "title" | "status" | "assignee">;

/** The caller supplies observed tasks from the approved graph. Neither a lease
 * heartbeat nor a receipt for a former owner establishes current activity. */
export function workerAssignments(
  projectId: string,
  tasks: readonly LinkedTask[],
  evidence: ReturnType<typeof readTaskEvidence>,
): WorkerAssignment[] {
  type Receipt = { execution: Execution } | { interactive: Attempt };
  // The two stores have independently enforced identities. If they ever both
  // record the same owner, neither record establishes this assignment's phase.
  const receipts = new Map<string, Receipt | null>();
  function index(attemptId: string, receipt: Receipt) {
    const key = owner(attemptId);
    receipts.set(key, receipts.has(key) ? null : receipt);
  }
  for (const execution of evidence.attempts) index(execution.id, { execution });
  for (const interactive of evidence.interactiveAttempts ?? [])
    index(interactive.id, { interactive });

  const rows: WorkerAssignment[] = [];
  for (const task of tasks) {
    if (knownTaskStatus(task.status) !== TaskStatus.InProgress) continue;
    const prefix = owner("");
    if (!task.assignee.startsWith(prefix)) continue;
    const attemptId = task.assignee.slice(prefix.length);
    if (!z.uuid().safeParse(attemptId).success) continue;
    const receipt = receipts.get(task.assignee);
    if (receipt === null) continue;
    let assignment: WorkerState | undefined;
    let focusable = false;
    if (receipt === undefined) {
      assignment = state("Attempt", "Status unavailable", "unknown");
    } else if ("execution" in receipt) {
      const { execution } = receipt;
      if (execution.project !== projectId || execution.bead?.id !== task.id)
        continue;
      assignment = runtimeState(execution);
      focusable =
        assignment?.role === "Worker" &&
        hasInteractivePane(execution) &&
        execution.launchToken !== undefined &&
        execution.pid !== undefined &&
        execution.started !== undefined &&
        execution.revision !== undefined;
    } else {
      const { interactive } = receipt;
      if (
        interactive.source.projectId !== projectId ||
        interactive.bead.id !== task.id
      )
        continue;
      assignment = localState(interactive);
      focusable = hasLocalPane(interactive);
    }
    if (assignment !== undefined)
      rows.push({
        ...assignment,
        beadId: task.id,
        title: task.title,
        attemptId,
        focusable,
      });
  }
  // Retain graph order among peers, even across independent refreshes.
  return rows.sort((a, b) => priority(a) - priority(b));
}

function priority(row: WorkerAssignment): number {
  if (row.question !== undefined) return 0;
  if (row.activity === "attention") return 1;
  if (row.activity === "active") return 2;
  return row.activity === "waiting" ? 3 : 4;
}
