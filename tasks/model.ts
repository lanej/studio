import { verificationSchema } from "../task-service.ts";
import { Phase, type Attempt } from "../attempts.ts";
import { selectorText } from "@lanej/pi-components";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { draftSchema, TaskDelivery } from "../lead-plan.ts";
import { knownRelationship, knownTaskStatus, parentId, TaskRelationship, TaskStatus, type Task } from "../beads.ts";
import {
  ExecutionPhase,
  completedWithoutExecutable,
  latestDecision,
  pendingDecision,
  type Execution,
} from "../execution/store.ts";
import { retainedConflicts } from "../execution/supervisor.ts";

export interface TaskSnapshot {
  tasks: Task[];
  attempts: Execution[];
  interactiveAttempts?: Attempt[];
  interactiveEvidenceError?: string;
  observedAt: string;
  evidenceError?: string;
  focusable: Set<string>;
  limitReached: boolean;
  retryBlocked?: Map<string, string>;
  answerBlocked?: Map<string, string>;
}

export function plain(value: string): string {
  return selectorText(value).replace(/\p{Cc}/gu, " ");
}

export function taskAttempts(task: Task, snapshot: TaskSnapshot): Execution[] {
  return snapshot.attempts.filter((attempt) => attempt.bead?.id === task.id);
}

export function selectedAttempt(task: Task, snapshot: TaskSnapshot): Execution | undefined {
  const attempts = taskAttempts(task, snapshot);
  return attempts.find((attempt) => task.assignee === `pi:${attempt.id}`) ?? attempts.at(-1);
}

/** Only the current Beads owner can authorize actions on a retained attempt. */
export function ownedAttempt(task: Task, snapshot: TaskSnapshot): Execution | undefined {
  return snapshot.attempts.find(
    (attempt) =>
      attempt.bead?.id === task.id &&
      task.assignee === `pi:${attempt.id}` &&
      knownTaskStatus(task.status) === TaskStatus.InProgress,
  );
}

/** Only explicit records describe an operator decision; historical evidence never authorizes an answer. */
export function decisionDetails(task: Task, snapshot: TaskSnapshot): string | undefined {
  const attempt = selectedAttempt(task, snapshot);
  const current = !attempt ? undefined : latestDecision(attempt);
  if (!attempt || !current) return undefined;
  return [
    ownedAttempt(task, snapshot)?.id === attempt.id
      ? "Operator decision evidence"
      : "Historical operator decision evidence; not the current owner",
    ...(attempt.operatorDecisions ?? []).flatMap((entry) => [
      `Question ${entry.id}: ${entry.question}`,
      !entry.answer
        ? "Awaiting an answer; verification and independent review have not been waived."
        : `Answer: ${entry.answer.text}`,
      entry.appliedHead === undefined
        ? "No resulting reviewed revision recorded for this answer."
        : `Applied at independently reviewed revision ${entry.appliedHead}`,
    ]),
    pendingDecision(attempt) === undefined
      ? "No unanswered operator request remains."
      : `Last evidenced step: operator question recorded at ${current.at}.`,
  ].join("\n");
}

export function parkedDetails(task: Task, snapshot: TaskSnapshot): string | undefined {
  const attempt = ownedAttempt(task, snapshot);
  if (!attempt || ![ExecutionPhase.Parked, ExecutionPhase.Uncertain, ExecutionPhase.Waiting].includes(attempt.phase))
    return undefined;
  const verification = attempt.verification;
  const noExecutable = completedWithoutExecutable(attempt);
  const state =
    attempt.phase === ExecutionPhase.Uncertain
      ? "Uncertain execution: inspect the retained writer and receipts before recovery."
      : attempt.reviewFinding !== undefined
        ? `Reviewer requested changes: ${attempt.reviewFinding}. Correct the finding before retrying; independent review remains required.`
        : !noExecutable && verification && verification.exitCode !== 0
          ? `Verification failed or did not complete: ${verification.check.join(" ")} (exit ${String(verification.exitCode)}).`
          : "Parked: decision evidence is unavailable; inspect the retained reason.";
  const completed = verification
    ? noExecutable
      ? "Last evidenced completed step: no executable check was agreed; acceptance relies on independent review."
      : verification.exitCode === null
        ? "Last evidenced step: verification has no confirmed exit."
        : verification.exitCode === 0
          ? "Last evidenced completed step: verification passed."
          : `Last evidenced step: verification exited ${String(verification.exitCode)}.`
    : attempt.summary.length > 0
      ? "Last evidenced step: worker report recorded."
      : "Last completed step: unknown.";
  const waiting = snapshot.attempts.filter(
    (other) =>
      other.id !== attempt.id &&
      other.phase === ExecutionPhase.Queued &&
      retainedConflicts(other, snapshot.attempts).some((blocker) => blocker.id === attempt.id),
  );
  const blocked = waiting.map((other) => {
    const paths =
      attempt.owns.length === 0 || other.owns.length === 0
        ? "ownership unspecified"
        : attempt.owns
            .flatMap((a) =>
              other.owns
                .filter((b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`))
                .map((b) => (a === b ? a : `${a} / ${b}`)),
            )
            .join(", ");
    return `${other.bead?.title ?? other.bead?.id ?? other.id}: ${paths}`;
  });
  return [
    state,
    completed,
    attempt.message,
    !verification
      ? "Verification evidence unavailable."
      : verification.output.length === 0 && verification.reason === undefined
        ? "Verifier output and reason are unavailable."
        : "Open Execution evidence for the verifier output and reason.",
    blocked.length === 0
      ? "No queued path conflicts recorded."
      : `Queued attempts with overlapping ownership: ${blocked.join("; ")}. Other admission fences may also apply.`,
  ].join("\n");
}

const deliveryMetadata = z.union([
  z
    .object({
      "studio.approval": z.string().min(1),
      "studio.task": draftSchema.shape.tasks.element,
      "studio.completed": z.string().optional(),
    })
    .transform((value) => ({
      approval: value["studio.approval"],
      task: value["studio.task"],
      completed: value["studio.completed"],
      parent: undefined,
    })),
  z
    .object({
      "pi.plan": z.string().min(1),
      "pi.plan_task": draftSchema.shape.tasks.element,
      "pi.plan_key": z.string().min(1),
      "pi.plan_parent": z.string().min(1),
    })
    .refine((value) => value["pi.plan_key"] === value["pi.plan_task"].key)
    .transform((value) => ({
      approval: value["pi.plan"],
      task: value["pi.plan_task"],
      completed: undefined,
      parent: value["pi.plan_parent"],
    })),
]);

export interface TaskDeliveryPresentation {
  label: string;
  details: string[];
  url?: string;
}

/** Only admitted task metadata and receipts bound to its current owner describe delivery. */
export function taskDelivery(task: Task, snapshot: TaskSnapshot): TaskDeliveryPresentation {
  const display = (
    state: "Unknown" | "PR not expected" | "PR not yet published" | "PR published" | "Blocked",
    ...details: string[]
  ): TaskDeliveryPresentation => ({ label: `Delivery · ${state}`, details });
  const metadata = z.record(z.string(), z.unknown()).safeParse(task["metadata"]);
  if (metadata.success && Object.hasOwn(metadata.data, "pi.plan_task"))
    return interactiveDelivery(task, snapshot, metadata.data);
  const live = deliveryMetadata.safeParse(task["metadata"]);
  const attempts = taskAttempts(task, snapshot);
  const hasOwner = task.assignee !== undefined && task.assignee.length > 0;
  const completed = live.success ? live.data.completed : undefined;
  const isClosed = knownTaskStatus(task.status) === TaskStatus.Closed;
  const attempt = hasOwner
    ? attempts.find((row) => task.assignee === `pi:${row.id}`)
    : isClosed && completed !== undefined
      ? attempts.find((row) => row.id === completed && row.phase === ExecutionPhase.Complete)
      : undefined;
  const bound = attempt !== undefined;
  const accepted = bound ? deliveryMetadata.safeParse(attempt.bead?.metadata) : undefined;
  if (snapshot.evidenceError !== undefined) return display("Unknown", "Local evidence unavailable");
  if (
    bound &&
    (!live.success ||
      accepted?.success !== true ||
      live.data.approval !== accepted.data.approval ||
      !isDeepStrictEqual(live.data.task, accepted.data.task) ||
      live.data.parent !== accepted.data.parent)
  )
    return display("Unknown", "Accepted task evidence differs or is unavailable");
  const intent = accepted?.success === true ? accepted.data : live.success ? live.data : undefined;
  if (!intent) return display("Unknown", "Approved delivery is not recorded");
  if (intent.parent !== undefined && parentId(task) !== intent.parent)
    return display("Unknown", "Approved parent relationship is unavailable or differs");
  if (hasOwner && !bound) return display("Unknown", "No receipts for the current owner");
  if (!hasOwner && completed !== undefined && (!isClosed || !bound))
    return display("Unknown", "No confirmed completion receipt for this task state");
  const delivery = intent.task.delivery ?? TaskDelivery.Local;
  if (delivery === TaskDelivery.Local) {
    const result = bound
      ? /^[a-f0-9]{40,64}$/u.test(attempt.integration ?? "")
        ? attempt.integration
        : attempt.resultRef
      : undefined;
    return display(
      "PR not expected",
      "Local integration only — no PR",
      result === undefined ? "Local result reference unavailable" : `Local result · ${plain(result)}`,
    );
  }
  let url: string | undefined;
  if (bound && attempt.pr !== undefined && attempt.pr.length > 0 && attempt.url !== undefined) {
    try {
      const parsed = new URL(attempt.url);
      if (parsed.protocol === "https:" && parsed.username.length === 0 && parsed.password.length === 0)
        url = parsed.href;
    } catch {
      /* An invalid retained link cannot establish publication. */
    }
  }
  const blocked = bound && [ExecutionPhase.Parked, ExecutionPhase.Uncertain].includes(attempt.phase);
  if (url !== undefined)
    return {
      ...display("PR published", url, ...(blocked ? [`Delivery blocked · ${plain(attempt.message)}`] : [])),
      url,
    };
  if (blocked) return display("Blocked", plain(attempt.message), "No confirmed PR link recorded");
  return display(
    "PR not yet published",
    ...(bound && attempt.publication !== undefined
      ? [`Publication request · ${plain(attempt.publication)} (awaiting confirmation)`]
      : []),
  );
}

export function taskLinks(task: Task, tasks: Task[]): { parent: Task | undefined; uses: string[]; feeds: string[] } {
  return {
    parent: tasks.find((item) => item.id === parentId(task)),
    uses: [
      ...new Set(
        task.dependencies
          ?.filter((edge) => knownRelationship(edge.dependency_type) === TaskRelationship.Blocks)
          .map((edge) => edge.id) ?? [],
      ),
    ],
    feeds: tasks
      .filter(
        (item) =>
          item.dependencies?.some(
            (edge) => knownRelationship(edge.dependency_type) === TaskRelationship.Blocks && edge.id === task.id,
          ) === true,
      )
      .map((item) => item.id),
  };
}

/** Findings belong only to the current Beads owner; earlier attempts remain in raw evidence. */
export function currentReviewFinding(task: Task, snapshot: TaskSnapshot): string | undefined {
  const attempt = selectedAttempt(task, snapshot);
  if (!attempt || task.assignee !== `pi:${attempt.id}` || knownTaskStatus(task.status) !== TaskStatus.InProgress)
    return undefined;
  return [ExecutionPhase.Reviewing, ExecutionPhase.Running, ExecutionPhase.Parked, ExecutionPhase.Waiting].includes(
    attempt.phase,
  )
    ? attempt.reviewFinding
    : undefined;
}

const phaseNarrative = {
  [ExecutionPhase.Queued]: "Studio queued a local attempt.",
  [ExecutionPhase.Claiming]: "Studio last recorded an attempt to claim this task.",
  [ExecutionPhase.Allocating]: "Studio last recorded checkout allocation.",
  [ExecutionPhase.Launching]: "Studio last recorded the worker starting.",
  [ExecutionPhase.Running]: "Studio last recorded the worker working on this task.",
  [ExecutionPhase.Reviewing]: "Studio last recorded a review of the worker's result.",
  [ExecutionPhase.Integrating]: "Studio last recorded integration of the reviewed result.",
  [ExecutionPhase.Delivery]: "Studio last recorded a wait for delivery confirmation.",
  [ExecutionPhase.AwaitingDecision]:
    "Studio is awaiting an explicit operator decision; its claim and checkout remain retained.",
  [ExecutionPhase.Waiting]: "Studio last recorded a wait for a correction.",
  [ExecutionPhase.Complete]: "Studio completed this local attempt.",
  [ExecutionPhase.Parked]: "Studio retained this attempt for review.",
  [ExecutionPhase.Uncertain]: "The outcome of this local attempt is uncertain.",
} satisfies Record<ExecutionPhase, string>;

export function taskNarrative(task: Task, snapshot: TaskSnapshot): string {
  const metadata = z.record(z.string(), z.unknown()).safeParse(task["metadata"]);
  if (metadata.success && Object.hasOwn(metadata.data, "pi.plan_task"))
    return `Beads reports “${plain(task.status)}”. Interactive delivery evidence is shown in Delivery.`;
  const attempt = selectedAttempt(task, snapshot);
  const parts: string[] = [];
  if (attempt) {
    if (ownedAttempt(task, snapshot)?.id !== attempt.id) {
      parts.push(
        task.assignee === undefined || task.assignee.length === 0
          ? "Historical/unattributed local evidence: Beads records no explicit current owner."
          : task.assignee !== `pi:${attempt.id}`
            ? "Historical local evidence: Beads names a different owner."
            : "Historical local evidence: this task is not currently in progress.",
        `Beads currently reports “${plain(task.status)}”.`,
      );
    }
    const verification = attempt.verification;
    if (verification) {
      parts.push(
        completedWithoutExecutable(attempt)
          ? "No executable check was agreed; acceptance relies on independent review."
          : verification.exitCode === null
            ? "The verifier has no confirmed exit code."
            : verification.exitCode === 0
              ? "The verifier exited 0."
              : `The verifier exited ${String(verification.exitCode)}.`,
      );
    }
    parts.push(phaseNarrative[attempt.phase]);
    if (!attempt.interactive && attempt.phase === ExecutionPhase.Running)
      parts.push("Interactive guidance is unavailable for a background worker.");
  } else if (snapshot.evidenceError === undefined) {
    const uses = taskLinks(task, snapshot.tasks).uses;
    const unfinished = uses.filter((id) => {
      const dependency = snapshot.tasks.find((item) => item.id === id);
      return dependency === undefined || knownTaskStatus(dependency.status) !== TaskStatus.Closed;
    });
    if (unfinished.length > 0) {
      parts.push("A prerequisite has not been observed closed. No local attempt is recorded.");
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
    parts.push(`Local evidence is unavailable: ${plain(snapshot.evidenceError)}`);
  return parts.join(" ");
}

export function needsAttention(task: Task, snapshot: TaskSnapshot): boolean {
  const attempt = ownedAttempt(task, snapshot);
  return (
    currentReviewFinding(task, snapshot) !== undefined ||
    (attempt !== undefined &&
      (attempt.phase === ExecutionPhase.AwaitingDecision ||
        attempt.phase === ExecutionPhase.Parked ||
        attempt.phase === ExecutionPhase.Uncertain ||
        (attempt.verification !== undefined &&
          attempt.verification.exitCode !== null &&
          attempt.verification.exitCode !== 0)))
  );
}

export function retainedEvidence(task: Task, snapshot: TaskSnapshot): string {
  const attempts = taskAttempts(task, snapshot);
  if (attempts.length === 0) return snapshot.evidenceError ?? "No local execution receipts are recorded for this task.";
  return attempts
    .map((attempt) =>
      [
        `Attempt ${attempt.id}`,
        ownedAttempt(task, snapshot)?.id === attempt.id
          ? "Current owner-matched receipt."
          : "Historical/unattributed receipt; this does not establish the current task's readiness or ownership.",
        attempt.message,
        ...(attempt.workerSessionFile === undefined ? [] : [`Worker transcript · ${attempt.workerSessionFile}`]),
        ...(attempt.reviewFinding === undefined ? [] : [`Reviewer finding\n${attempt.reviewFinding}`]),
        !attempt.verification
          ? "No verifier receipt."
          : `Verifier receipt\n${JSON.stringify(attempt.verification, null, 2)}`,
        attempt.review === undefined ? "No reviewer receipt." : `Reviewer receipt\n${attempt.review}`,
        attempt.summary.length === 0 ? "" : `Worker report\n${attempt.summary}`,
        attempt.resultRef === undefined ? "" : `Result ref: ${attempt.resultRef}`,
        attempt.integration === undefined ? "" : `Integrated revision: ${attempt.integration}`,
      ]
        .filter((part) => part.length > 0)
        .join("\n\n"),
    )
    .join("\n\n");
}

/** Bind interactive delivery to the current child approval without granting runtime authority. */
function interactiveDelivery(
  task: Task,
  snapshot: TaskSnapshot,
  metadata: Record<string, unknown>,
): TaskDeliveryPresentation {
  const display = (state: string, ...details: string[]): TaskDeliveryPresentation => ({
    label: `Delivery · ${state}`,
    details,
  });
  const live = deliveryMetadata.safeParse(task["metadata"]);
  if (!live.success || live.data.parent === undefined)
    return display("Unknown", "Approved interactive delivery is malformed or unavailable");
  if (parentId(task) !== live.data.parent)
    return display("Unknown", "Approved parent relationship is unavailable or differs");
  if (snapshot.interactiveEvidenceError !== undefined) return display("Unknown", "Interactive evidence unavailable");
  const rows = (snapshot.interactiveAttempts ?? []).filter((row) => row.bead.id === task.id);
  const hasOwner = task.assignee !== undefined && task.assignee.length > 0;
  const completion = z
    .object({
      "pi.result_attempt": z.string(),
      "pi.result": verificationSchema,
    })
    .safeParse(task["metadata"]);
  const attempt = hasOwner
    ? rows.find((row) => task.assignee === `pi:${row.id}`)
    : knownTaskStatus(task.status) === TaskStatus.Closed && completion.success
      ? rows.find(
          (row) =>
            row.id === completion.data["pi.result_attempt"] &&
            row.verification?.exitCode === 0 &&
            isDeepStrictEqual(row.verification, completion.data["pi.result"]) &&
            [Phase.Closed, Phase.Archived].includes(row.phase),
        )
      : undefined;
  const accepted = !attempt ? undefined : deliveryMetadata.safeParse(attempt.bead.metadata);
  if (
    attempt &&
    (accepted?.success !== true ||
      accepted.data.approval !== live.data.approval ||
      accepted.data.parent !== live.data.parent ||
      !isDeepStrictEqual(accepted.data.task, live.data.task))
  )
    return display("Unknown", "Accepted interactive task evidence differs or is unavailable");
  if (hasOwner && !attempt) return display("Unknown", "No interactive receipts for the current owner");
  if (!hasOwner && Object.hasOwn(metadata, "pi.result_attempt") && !attempt)
    return display("Unknown", "No confirmed interactive completion receipt for this task state");
  if ((live.data.task.delivery ?? TaskDelivery.Local) === TaskDelivery.Local)
    return display("PR not expected", "Local integration only — no PR", "Local result reference unavailable");
  const delivery = attempt?.delivery;
  if (delivery?.pr !== undefined && delivery.url !== undefined)
    return { ...display("PR published", delivery.url), url: delivery.url };
  if (attempt && [Phase.CheckFailed, Phase.Reconcile, Phase.Rejected].includes(attempt.phase))
    return display("Blocked", plain(attempt.message), "No confirmed PR link recorded");
  return display(
    "PR not yet published",
    ...(delivery?.octoSubmission === undefined
      ? []
      : [`Publication request · ${plain(delivery.octoSubmission)} (awaiting confirmation)`]),
  );
}
