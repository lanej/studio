import { isDeepStrictEqual } from "node:util";
import { LeadMode, type LeadDraft } from "../planning/plan.ts";
import {
  propertyGaps,
  SpecStatus,
  specDraft,
  specificationGaps,
  type LeadSpecification,
} from "./spec.ts";

interface FreezeState {
  readonly revision: string | null;
  readonly specification?: LeadSpecification | undefined;
  readonly leadPlan?: { mode: LeadMode; draft: LeadDraft | null } | undefined;
}

interface SpecificationFreezeReview {
  readonly kind: "ready";
  readonly specification: LeadSpecification;
  readonly planDraft: LeadDraft | null | undefined;
}

type FreezeReadiness =
  | SpecificationFreezeReview
  | { kind: "gaps"; gaps: string[] }
  | { kind: "blocked" };

export function prepareSpecificationFreeze(
  state: FreezeState,
  scope: "discovery" | "managed",
): FreezeReadiness {
  const { specification, revision } = state;
  if (specification?.status !== SpecStatus.Interrogating)
    return { kind: "blocked" };
  const gaps =
    scope === "discovery"
      ? specificationGaps(specification, revision)
      : propertyGaps(specification, revision);
  if (gaps.length > 0) return { kind: "gaps", gaps };
  if (
    specification.draft === null ||
    specification.draft.blockingQuestions.length > 0 ||
    specification.exchange !== undefined ||
    !specDraft.safeParse(specification.draft).success ||
    revision !== specification.acceptedRevision
  )
    return { kind: "blocked" };
  return { kind: "ready", specification, planDraft: state.leadPlan?.draft };
}

/** Evaluate against the current record inside the owner's write transaction. */
export function freezeReviewedSpecification(
  review: SpecificationFreezeReview,
  current: FreezeState,
  approvalAt: string,
): LeadSpecification {
  if (
    !isDeepStrictEqual(current.specification, review.specification) ||
    !isDeepStrictEqual(current.leadPlan?.draft, review.planDraft) ||
    current.leadPlan?.mode !== LeadMode.Planning ||
    current.revision !== review.specification.acceptedRevision
  )
    throw new Error("The displayed specification changed");
  return { ...review.specification, status: SpecStatus.Frozen, approvalAt };
}
