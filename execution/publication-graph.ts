import { isDeepStrictEqual } from "node:util";
import { sha } from "../delivery-record.ts";
import { HandoffPhase } from "../discovery/model.ts";
import { Discoveries } from "../discovery/store.ts";
import {
  publicationPrerequisites as prerequisiteTasks,
  planDigest,
  TaskDelivery,
  type LeadDraft,
} from "../planning/plan.ts";
import type { NativeBead } from "../task-service.ts";
import type { RetainedHandoffIntent } from "./handoff-model.ts";
import { ExecutionPhase } from "./phase.ts";
import type { Execution, ExecutionStore } from "./store.ts";
import type { RuntimeProject } from "./target.ts";

type PlanTask = LeadDraft["tasks"][number];

function requirePublicationTarget(approved: RuntimeProject, current: RuntimeProject): void {
  if (
    approved.id !== current.id ||
    approved.root !== current.root ||
    approved.base !== current.base ||
    !isDeepStrictEqual(approved.source, current.source)
  )
    throw new Error("The publishing repository, target branch, or Beads authority differs from the approved handoff");
}

function approvedDraft(store: ExecutionStore, project: RuntimeProject, intent: RetainedHandoffIntent): LeadDraft {
  if (intent.draft && intent.project === project.id) {
    if (intent.target) {
      requirePublicationTarget(intent.target, project);
      return intent.draft;
    }
    // Earlier interactive handoffs already pinned their entire local-only plan.
    if (intent.interactive && intent.draft.tasks.every((task) => task.delivery !== TaskDelivery.PullRequest))
      return intent.draft;
  }
  // Older background handoffs kept only IDs and a digest in the execution store.
  const discoveries = new Discoveries(store.directory);
  try {
    const record = discoveries
      .list(project.root)
      .find(
        (item) =>
          item.revision === intent.id &&
          item.approved === intent.digest &&
          item.handoff?.phase === HandoffPhase.Complete &&
          item.handoff.target.id === project.id &&
          item.handoff.digest === intent.digest &&
          item.handoff.revision === intent.id &&
          isDeepStrictEqual(item.graph, intent.ids),
      );
    const draft = record?.leadPlan.draft;
    if (draft == null || !record?.handoff)
      throw new Error("Cannot confirm the approved task graph from its original handoff");
    requirePublicationTarget(record.handoff.target, project);
    return draft;
  } finally {
    discoveries.close();
  }
}

function requireApprovedBead(bead: NativeBead, task: PlanTask, draft: LeadDraft, intent: RetainedHandoffIntent): void {
  if (
    bead.id !== intent.ids[task.key] ||
    bead.metadata["studio.graph"] !== intent.id ||
    bead.metadata["studio.root"] !== intent.ids["root"] ||
    bead.metadata["studio.approval"] !== intent.digest ||
    bead.metadata["studio.pullRequestMerge"] !== draft.pullRequestMerge ||
    !isDeepStrictEqual(bead.metadata["studio.task"], task) ||
    !isDeepStrictEqual(bead.metadata["studio.worker"], intent.workers?.[task.key]) ||
    bead.title !== task.title ||
    bead.description !== task.description ||
    bead.acceptance_criteria !== task.acceptance
  )
    throw new Error(`Task ${bead.id} differs from its approved task graph`);
}

export function approvedHandoffTask(
  store: ExecutionStore,
  project: RuntimeProject,
  bead: NativeBead,
  intent: RetainedHandoffIntent,
): { draft: LeadDraft; task: PlanTask } {
  const draft = approvedDraft(store, project, intent);
  const task = draft.tasks.find((entry) => intent.ids[entry.key] === bead.id);
  if (planDigest(draft) !== intent.digest || !task) throw new Error("The task does not match its approved handoff");
  requireApprovedBead(bead, task, draft, intent);
  return { draft, task };
}

function requireExecutionScope(attempt: Execution, task: PlanTask): void {
  if (!isDeepStrictEqual(attempt.owns, task.owns) || !isDeepStrictEqual(attempt.check, task.check ?? []))
    throw new Error(`Execution scope for ${task.key} differs from the approved handoff`);
}

export function publicationPrerequisites(
  store: ExecutionStore,
  project: RuntimeProject,
  attempt: Execution,
): Execution[] {
  const bead = attempt.bead;
  if (!bead || attempt.project !== project.id)
    throw new Error("Publication requires an admitted bead in the enrolled project");
  const intent = store.taskHandoffIntent(project.id, bead.id);
  if (intent === undefined) {
    if (
      bead.metadata["studio.graph"] !== undefined ||
      bead.metadata["studio.approval"] !== undefined ||
      bead.metadata["studio.root"] !== undefined
    )
      throw new Error("A graph bead requires the original handoff receipt for publication");
    // Independently admitted tasks have no approved local changes to publish.
    return [];
  }
  const { draft, task } = approvedHandoffTask(store, project, bead, intent);
  if (task.delivery !== TaskDelivery.PullRequest)
    throw new Error("The approved handoff does not authorize this publishing bead");
  requireExecutionScope(attempt, task);
  const required = prerequisiteTasks(draft, task);
  if (required.length === 0) return [];
  const complete = store
    .attempts()
    .filter((entry) => entry.project === project.id && entry.phase === ExecutionPhase.Complete);
  return required.map((dependency) => {
    const matches = complete.filter((entry) => entry.bead?.id === intent.ids[dependency.key]);
    const receipt = matches[0];
    if (matches.length !== 1 || !receipt?.bead)
      throw new Error(`Cannot confirm one completed execution for prerequisite ${dependency.key}`);
    requireApprovedBead(receipt.bead, dependency, draft, intent);
    requireExecutionScope(receipt, dependency);
    if (
      (receipt.review?.trim().length ?? 0) === 0 ||
      (receipt.integrationReview?.trim().length ?? 0) === 0 ||
      receipt.reviewFinding !== undefined
    )
      throw new Error(`Prerequisite ${dependency.key} lacks its accepted integration review`);
    sha.parse(receipt.base);
    sha.parse(receipt.head);
    sha.parse(receipt.integration);
    sha.optional().parse(receipt.integrationExpected);
    if (dependency.delivery === TaskDelivery.PullRequest) sha.parse(receipt.merged);
    else if (receipt.merged !== undefined)
      throw new Error(`Local prerequisite ${dependency.key} has a conflicting merge receipt`);
    return receipt;
  });
}
