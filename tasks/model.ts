import { knownTaskStatus, parentId, TaskStatus, type Task } from "../beads.ts";
import { ExecutionPhase, type Execution } from "../execution/store.ts";

export interface TaskSnapshot {
  tasks: Task[];
  attempts: Execution[];
  observedAt: string;
  evidenceError?: string;
  focusable: Set<string>;
  limitReached: boolean;
}

export function plain(value: string): string {
  return value.replace(/\p{Cc}/gu, " ");
}

export function taskAttempts(task: Task, snapshot: TaskSnapshot): Execution[] {
  return snapshot.attempts.filter((attempt) => attempt.bead?.id === task.id);
}

export function selectedAttempt(
  task: Task,
  snapshot: TaskSnapshot,
): Execution | undefined {
  const attempts = taskAttempts(task, snapshot);
  return (
    attempts.find((attempt) => task.assignee === `pi:${attempt.id}`) ??
    attempts.at(-1)
  );
}

export function taskLinks(
  task: Task,
  tasks: Task[],
): { parent: Task | undefined; uses: string[]; feeds: string[] } {
  return {
    parent: tasks.find((item) => item.id === parentId(task)),
    uses: [
      ...new Set(
        task.dependencies
          ?.filter(
            (edge) =>
              knownRelationship(edge.dependency_type) ===
              TaskRelationship.Blocks,
          )
          .map((edge) => edge.id) ?? [],
      ),
    ],
    feeds: tasks
      .filter(
        (item) =>
          item.dependencies?.some(
            (edge) =>
              knownRelationship(edge.dependency_type) ===
                TaskRelationship.Blocks && edge.id === task.id,
          ) === true,
      )
      .map((item) => item.id),
  };
}

const phaseNarrative = {
  [ExecutionPhase.Queued]: "Studio queued a local attempt.",
  [ExecutionPhase.Claiming]:
    "Studio last recorded an attempt to claim this task.",
  [ExecutionPhase.Allocating]: "Studio last recorded checkout allocation.",
  [ExecutionPhase.Launching]: "Studio last recorded the worker starting.",
  [ExecutionPhase.Running]:
    "Studio last recorded the worker working on this task.",
  [ExecutionPhase.Reviewing]:
    "Studio last recorded a review of the worker's result.",
  [ExecutionPhase.Integrating]:
    "Studio last recorded integration of the reviewed result.",
  [ExecutionPhase.Delivery]:
    "Studio last recorded a wait for delivery confirmation.",
  [ExecutionPhase.Waiting]: "Studio last recorded a wait for a correction.",
  [ExecutionPhase.Complete]: "Studio completed this local attempt.",
  [ExecutionPhase.Parked]: "Studio retained this attempt for review.",
  [ExecutionPhase.Uncertain]: "The outcome of this local attempt is uncertain.",
} satisfies Record<ExecutionPhase, string>;

export function taskNarrative(task: Task, snapshot: TaskSnapshot): string {
  const attempt = selectedAttempt(task, snapshot);
  const parts: string[] = [];
  if (attempt !== undefined) {
    const verification = attempt.verification;
    if (verification !== undefined) {
      parts.push(
        verification.exitCode === null
          ? "The verifier has no confirmed exit code."
          : verification.exitCode === 0
            ? "The verifier exited 0."
            : `The verifier exited ${String(verification.exitCode)}.`,
      );
    }
    parts.push(phaseNarrative[attempt.phase]);
    if (
      task.assignee !== undefined &&
      task.assignee.length > 0 &&
      task.assignee !== `pi:${attempt.id}`
    )
      parts.push(
        "This is an earlier local attempt; Beads names a different owner.",
      );
  } else if (snapshot.evidenceError === undefined) {
    const uses = taskLinks(task, snapshot.tasks).uses;
    const unfinished = uses.filter((id) => {
      const dependency = snapshot.tasks.find((item) => item.id === id);
      return (
        dependency === undefined ||
        knownTaskStatus(dependency.status) !== TaskStatus.Closed
      );
    });
    if (unfinished.length > 0) {
      parts.push(
        "A prerequisite has not been observed closed. No local attempt is recorded.",
      );
    } else {
      const status = knownTaskStatus(task.status);
      parts.push(
        status === TaskStatus.Closed
          ? "Beads records this task as closed. No local attempt is recorded."
          : status === TaskStatus.Deferred
            ? "Beads has held this task for later. No local attempt is recorded."
            : status === undefined
              ? `Beads reports “${plain(task.status)}”. No local attempt is recorded.`
              : "No local attempt is recorded. Beads owns task readiness.",
      );
    }
  }
  if (snapshot.evidenceError !== undefined)
    parts.push(
      `Local evidence is unavailable: ${plain(snapshot.evidenceError)}`,
    );
  return parts.join(" ");
}

export function needsAttention(task: Task, snapshot: TaskSnapshot): boolean {
  const attempt = selectedAttempt(task, snapshot);
  return (
    attempt !== undefined &&
    (attempt.phase === ExecutionPhase.Parked ||
      attempt.phase === ExecutionPhase.Uncertain ||
      (attempt.verification !== undefined &&
        attempt.verification.exitCode !== null &&
        attempt.verification.exitCode !== 0))
  );
}

export function retainedEvidence(task: Task, snapshot: TaskSnapshot): string {
  const attempts = taskAttempts(task, snapshot);
  if (attempts.length === 0)
    return (
      snapshot.evidenceError ??
      "No local execution receipts are recorded for this task."
    );
  return attempts
    .map((attempt) =>
      [
        `Attempt ${attempt.id}`,
        attempt.message,
        attempt.verification === undefined
          ? "No verifier receipt."
          : `Verifier receipt\n${JSON.stringify(attempt.verification, null, 2)}`,
        attempt.review === undefined
          ? "No reviewer receipt."
          : `Reviewer receipt\n${attempt.review}`,
        attempt.summary.length === 0 ? "" : `Worker report\n${attempt.summary}`,
        attempt.resultRef === undefined
          ? ""
          : `Result ref: ${attempt.resultRef}`,
        attempt.integration === undefined
          ? ""
          : `Integrated revision: ${attempt.integration}`,
      ]
        .filter((part) => part.length > 0)
        .join("\n\n"),
    )
    .join("\n\n");
}
