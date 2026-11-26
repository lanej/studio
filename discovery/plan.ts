import { isDeepStrictEqual } from "node:util";
import {
  LeadMode,
  planDigest,
  TaskDelivery,
  type LeadDraft,
} from "../planning/plan.ts";
import {
  pendingCoverageReview,
  specificationToken,
} from "../socrates/assessment.ts";
import {
  draftDeliveryPolicy,
  specificationGaps,
  SpecStatus,
  type DeliveryPolicy,
} from "../socrates/spec.ts";
import {
  HandoffPhase,
  type Discovery,
  type DiscoveryHandoff,
} from "./model.ts";

/** Resolve each proposed bead against the same publication decision shown at freeze. */
export function applyDeliveryPolicy(
  draft: LeadDraft,
  policy: DeliveryPolicy,
): LeadDraft {
  const tasks = draft.tasks.map((task) => {
    const publishes =
      policy.pullRequests === "per-bead" ||
      (policy.pullRequests === "selected" && policy.publish.includes(task.key));
    const delivery = publishes ? TaskDelivery.PullRequest : TaskDelivery.Local;
    if (task.delivery !== undefined && task.delivery !== delivery)
      throw new Error(
        `Delivery for ${task.key} conflicts with decision ${policy.decisionId}. Revise the proposal or revisit the Socrates delivery decision.`,
      );
    return { ...task, delivery };
  });
  const { pullRequestMerge: previousMerge, ...proposal } = draft;
  if (
    previousMerge !== undefined &&
    (policy.pullRequests === "none" || previousMerge !== policy.merge)
  )
    throw new Error(
      "The proposed merge rule conflicts with the Socrates delivery decision",
    );
  return policy.pullRequests === "none"
    ? { ...proposal, tasks }
    : { ...proposal, tasks, pullRequestMerge: policy.merge };
}

/** Persist a proposal against its current specification without certifying the old assessment. */
export function saveDiscoveryPlan(
  row: Pick<
    Discovery,
    "specification" | "leadPlan" | "planSpecificationRevision"
  >,
  proposal: LeadDraft,
  linkSpecification = true,
): void {
  const existing = new Map(
    row.leadPlan.draft?.tasks.map((task) => [task.key, task]),
  );
  const unassigned = proposal.tasks.find((task) => {
    const previous = existing.get(task.key);
    return (
      task.assignment === undefined &&
      (previous === undefined || previous.assignment !== undefined)
    );
  });
  if (unassigned !== undefined)
    throw new Error(
      `Specify worker capability and reasoning for task ${unassigned.key}`,
    );

  const spec = row.specification;
  if (spec !== undefined) {
    const requirements = spec.draft?.requirements.map(({ id }) => id) ?? [];
    if (
      proposal.tasks.some((task) =>
        task.requirements.some((id) => !requirements.includes(id)),
      )
    )
      throw new Error(
        "Link proposed tasks only to requirements in the current specification",
      );
    if (linkSpecification)
      row.planSpecificationRevision = specificationToken(spec);
  }
  const policy = draftDeliveryPolicy(spec?.draft ?? null);
  const draft =
    policy === undefined ? proposal : applyDeliveryPolicy(proposal, policy);
  if (
    spec?.coverageRevision !== undefined &&
    !isDeepStrictEqual(draft, row.leadPlan.draft)
  )
    spec.pendingReview = pendingCoverageReview(spec, "plan");
  row.leadPlan = { ...row.leadPlan, mode: LeadMode.Planning, draft };
}

/** A proposal is editable throughout discovery. Only this reviewed form may reach the runtime. */
export function handoffDraft(record: Discovery): LeadDraft {
  const draft = record.leadPlan.draft;
  if (draft === null || draft.tasks.length === 0)
    throw new Error("Draft at least one executable task first");
  const retained = record.handoff;
  if (retained !== undefined) {
    if (
      retained.digest !== planDigest(draft) ||
      retained.revision !== record.revision
    )
      throw new Error(
        "Reconcile the original handoff with its recorded draft and revision",
      );
    return draft;
  }
  const spec = record.specification;
  if (
    spec?.status !== SpecStatus.Frozen ||
    spec.approvalAt === undefined ||
    spec.draft === null
  )
    throw new Error(
      "Start /socrates and freeze the reviewed specification with /spec-freeze before handing work to the runtime",
    );
  const gaps = specificationGaps(spec, record.revision);
  if (gaps.length > 0) throw new Error(gaps.join("\n"));
  if (record.planSpecificationRevision !== specificationToken(spec))
    throw new Error(
      "Update the work breakdown against the current frozen specification before approval",
    );
  const policy = draftDeliveryPolicy(spec.draft);
  if (
    policy === undefined ||
    !isDeepStrictEqual(draft, applyDeliveryPolicy(draft, policy))
  )
    throw new Error(
      "Update the proposed beads to match the settled delivery policy",
    );
  if (policy.pullRequests === "selected") {
    const missing = policy.publish.filter(
      (key) => !draft.tasks.some((task) => task.key === key),
    );
    if (missing.length > 0)
      throw new Error(
        `The delivery decision names missing publishing beads: ${missing.join(", ")}`,
      );
  }
  const requirements = spec.draft.requirements.map(({ id }) => id);
  if (
    draft.tasks.some(
      (task) =>
        task.requirements.length === 0 ||
        task.requirements.some((id) => !requirements.includes(id)),
    ) ||
    requirements.some(
      (id) => !draft.tasks.some((task) => task.requirements.includes(id)),
    )
  )
    throw new Error(
      "Cover every frozen requirement and link each task to known requirement IDs",
    );
  return draft;
}

type HandoffApproval = Pick<
  Discovery,
  "id" | "project" | "revision" | "specification" | "handoff"
> & { digest: string };

interface HandoffOptions {
  target: DiscoveryHandoff["target"];
  owner: DiscoveryHandoff["owner"];
  recoverPending: boolean;
  workers: DiscoveryHandoff["workers"];
}

export function bindHandoffApproval(expected: Discovery): HandoffApproval {
  if (expected.leadPlan.draft === null)
    throw new Error("No displayed draft to approve");
  return {
    id: expected.id,
    project: expected.project,
    revision: expected.revision,
    specification: expected.specification,
    handoff: expected.handoff,
    digest: planDigest(expected.leadPlan.draft),
  };
}

/** Compare the actual record inside the owner's transaction before reserving a handoff. */
export function prepareHandoff(
  record: Discovery,
  approval: HandoffApproval,
  { target, owner, recoverPending, workers }: HandoffOptions,
): Omit<DiscoveryHandoff, "operation"> & { operation: string | undefined } {
  const { digest, revision } = approval;
  if (
    record.id !== approval.id ||
    record.revision !== revision ||
    record.project !== approval.project ||
    !isDeepStrictEqual(record.specification, approval.specification) ||
    record.leadPlan.draft === null ||
    planDigest(record.leadPlan.draft) !== digest
  )
    throw new Error(
      "The displayed draft changed before approval; review it again",
    );
  handoffDraft(record);

  const retained = record.handoff;
  if (
    retained !== undefined &&
    (!isDeepStrictEqual(retained.target, target) ||
      !isDeepStrictEqual(retained.workers, workers) ||
      retained.digest !== digest ||
      retained.revision !== revision)
  )
    throw new Error(
      "The handoff retains its original project authority and draft, including worker selections; restore the approved configuration to reconcile it",
    );
  if (
    retained?.phase === HandoffPhase.Pending &&
    (!recoverPending ||
      owner === undefined ||
      !isDeepStrictEqual(retained, approval.handoff))
  )
    throw new Error(
      "This exact handoff is already in progress; inspect its outcome before retrying",
    );
  return {
    operation:
      retained?.phase === HandoffPhase.Complete
        ? undefined
        : retained?.operation,
    digest,
    revision,
    target,
    workers,
    phase: HandoffPhase.Pending,
    owner,
  };
}
