import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  decisionId,
  deliveryPolicySchema,
  deliveryPolicyText,
  draftDeliveryPolicy,
} from "./delivery-policy.ts";
export {
  deliveryPolicySchema,
  draftDeliveryPolicy,
  type DeliveryPolicy,
} from "./delivery-policy.ts";
import { questionEvidence } from "./evidence.ts";
import {
  coverageBasisCurrent,
  coverageProperties,
  savedCoverageSchema,
  coverageSchema,
  draftCoverage,
  mergeCoverage,
} from "./assessment.ts";

export enum SpecStatus {
  Interrogating = "interrogating",
  Frozen = "frozen",
}

export enum DecisionDisposition {
  Open = "open",
  Resolved = "resolved",
  AcceptedUncertainty = "accepted-uncertainty",
  Superseded = "superseded",
}

const text = z.string().trim().min(1).max(2000);
const requirementId = z.string().regex(/^R[1-9]\d*$/u);
const legacyDecision = z.strictObject({
  decision: text,
  basis: z.enum(["observed", "decided", "assumed"]),
  evidence: text,
});
const decision = legacyDecision.extend({
  id: decisionId,
  disposition: z.enum(DecisionDisposition),
  uncertainty: text,
  supersedes: decisionId.optional(),
});

const draftFields = {
  objective: text,
  scope: z.array(text).min(1).max(20),
  requirements: z
    .array(
      z.strictObject({
        id: requirementId,
        outcome: text,
        acceptance: text,
      }),
    )
    .min(1)
    .max(20)
    .refine(
      (entries) => new Set(entries.map(({ id }) => id)).size === entries.length,
      "Requirement IDs must be unique",
    ),
  blockingQuestions: z.array(text).max(12),
};
const legacyDraft = z.strictObject({
  ...draftFields,
  decisions: z.array(legacyDecision).max(20),
});
export const specDraft = z
  .strictObject({
    ...draftFields,
    decisions: z.array(decision),
    coverage: savedCoverageSchema.optional(),
    deliveryPolicy: deliveryPolicySchema.optional(),
  })
  .superRefine((value, ctx) => {
    const decisions = new Map(
      value.decisions.map((entry) => [entry.id, entry]),
    );
    const replacements = value.decisions.flatMap((entry) =>
      entry.supersedes === undefined ? [] : [entry.supersedes],
    );
    if (
      decisions.size !== value.decisions.length ||
      new Set(replacements).size !== replacements.length ||
      value.decisions.some(
        (entry) =>
          (entry.disposition === DecisionDisposition.Superseded &&
            !replacements.includes(entry.id)) ||
          (entry.supersedes !== undefined &&
            (Number(entry.id.slice(1)) <= Number(entry.supersedes.slice(1)) ||
              decisions.get(entry.supersedes)?.disposition !==
                DecisionDisposition.Superseded)),
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Use unique decision IDs and link superseded decisions to their successors",
      });
    }
  });

/** Every writable draft includes a complete assessment; specRecord also reads historical formats. */
export const assessedSpecDraft = specDraft.safeExtend({
  coverage: coverageSchema,
});

const draftUpdate = specDraft.safeExtend({ coverage: savedCoverageSchema });
const coverageOnly = z.strictObject({
  coverage: z.strictObject({
    ...savedCoverageSchema.shape,
    domains: savedCoverageSchema.shape.domains.optional(),
  }),
});

/** The tool accepts a delta. Storage, freeze and handoff always see the complete draft. */
export function applyDraftUpdate(
  spec: LeadSpecification,
  revision: string,
  input: unknown,
): z.infer<typeof assessedSpecDraft> {
  const review = coverageOnly.safeParse(input);
  if (review.success && spec.exchange?.answer !== undefined)
    throw new Error(
      "Incorporate the recorded answer in the specification before saving its assessments",
    );
  const saved = draftCoverage(spec.draft);
  if (review.success && review.data.coverage.domains !== undefined) {
    const domains = review.data.coverage.domains;
    if (saved?.domains.some((domain) => !domains.includes(domain)) === true)
      throw new Error(
        "Supply the revised specification when removing a property domain",
      );
  }
  const draft = draftUpdate.parse(
    review.success
      ? {
          ...spec.draft,
          coverage: {
            ...review.data.coverage,
            domains: review.data.coverage.domains ?? saved?.domains,
          },
        }
      : input,
  );
  const previous = coverageBasisCurrent(spec, revision) ? saved : undefined;
  const coverage = mergeCoverage(previous, draft.coverage);
  if (
    review.success &&
    coverage.focus === undefined &&
    previous?.focus !== undefined &&
    coverage.assessments.some(({ propertyId }) => propertyId === previous.focus)
  )
    coverage.focus = previous.focus;
  return { ...draft, coverage };
}

export const specQuestion = z
  .strictObject({
    decisionId,
    question: text,
    context: text.optional(),
    evidence: questionEvidence,
    options: z
      .array(
        z.strictObject({
          label: text,
          description: text,
          details: text.optional(),
          evidence: questionEvidence,
        }),
      )
      .max(4),
  })
  .superRefine(({ options }, ctx) => {
    const labels = options.map(({ label }) => label);
    if (labels.length === 1 || new Set(labels).size !== labels.length) {
      ctx.addIssue({
        code: "custom",
        message: "Use zero options for text or two to four distinct choices",
      });
    }
  });
export type SpecQuestion = z.infer<typeof specQuestion>;

export const specRecord = z.strictObject({
  status: z.enum(SpecStatus),
  version: z.number().int().positive(),
  draft: z.union([specDraft, legacyDraft]).nullable(),
  exchange: z
    .strictObject({
      prompt: specQuestion,
      answer: z
        .strictObject({
          text,
          kind: z.enum(["option", "custom"]),
        })
        .optional(),
    })
    .optional(),
  acceptedRevision: z.string(),
  approvalAt: z.string().optional(),
  pendingReview: z
    .strictObject({
      id: z.uuid(),
      cause: z.enum(["input", "plan", "input-and-plan"]),
    })
    .optional(),
  coverageRevision: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
});
export type LeadSpecification = z.infer<typeof specRecord>;

function deliveryDecision(
  draft: LeadSpecification["draft"],
): z.infer<typeof decision> | undefined {
  const policy = draftDeliveryPolicy(draft);
  for (const entry of draft?.decisions ?? []) {
    if (isTrackedDecision(entry) && entry.id === policy?.decisionId)
      return entry;
  }
  return undefined;
}

function resolvedDeliveryDecision(
  entry: z.infer<typeof decision> | undefined,
): boolean {
  return (
    entry?.disposition === DecisionDisposition.Resolved &&
    entry.basis !== "assumed"
  );
}

/** A PR rule is settled only when its recorded decision has an evidenced outcome. */
export function hasSettledDeliveryPolicy(
  draft: LeadSpecification["draft"],
): boolean {
  return resolvedDeliveryDecision(deliveryDecision(draft));
}

/** Remaining decisions and evidence that prevent freezing a daily-driver specification. */
export function specificationGaps(
  spec: LeadSpecification,
  currentRevision: string | null,
): string[] {
  const draft = spec.draft;
  if (draft === null) return ["Draft the specification"];
  const gaps: string[] = [];
  if (spec.acceptedRevision !== currentRevision)
    gaps.push("Refresh the specification against the current brief");
  if (!specDraft.safeParse(draft).success)
    gaps.push("Review the saved decisions in the current specification format");
  if (spec.exchange !== undefined)
    gaps.push(
      spec.exchange.answer === undefined
        ? "Answer the pending question"
        : "Incorporate the recorded answer",
    );
  const policy = draftDeliveryPolicy(draft);
  if (policy === undefined) {
    gaps.push(
      "Settle which beads produce pull requests and who may merge them",
    );
  } else if (!hasSettledDeliveryPolicy(draft)) {
    gaps.push(
      `Record the PR production rules in resolved decision ${policy.decisionId} with repository evidence or an operator decision`,
    );
  }
  gaps.push(...draft.blockingQuestions);
  for (const decision of draft.decisions) {
    if (
      isTrackedDecision(decision) &&
      decision.disposition === DecisionDisposition.Open
    )
      gaps.push(`Resolve decision ${decision.id}`);
  }
  return [...gaps, ...propertyGaps(spec, currentRevision)];
}

export function propertyGaps(
  spec: LeadSpecification,
  currentRevision: string | null,
): string[] {
  const gaps: string[] = [];
  if (
    draftCoverage(spec.draft) !== undefined &&
    !coverageBasisCurrent(spec, currentRevision)
  )
    gaps.push(
      "Reassess properties against the current specification and plan with /socrates",
    );
  if (spec.pendingReview !== undefined)
    gaps.push(
      "Review recent changes with /socrates and update any affected property assessments",
    );
  for (const property of coverageProperties(spec.draft)) {
    if (property.status !== "satisfied" && property.status !== "not-applicable")
      gaps.push(`${property.label} · ${property.status}`);
  }
  return gaps;
}

export function specText(spec: LeadSpecification): string {
  const draft = spec.draft;
  if (draft === null)
    return [
      "No specification drafted yet.",
      "",
      "Open properties",
      ...coverageProperties(null).map(
        ({ label, reason }) => `${label} · open · ${reason}`,
      ),
    ].join("\n");
  const coverage = draftCoverage(draft);
  const policy = draftDeliveryPolicy(draft);
  const properties = coverageProperties(draft);

  return [
    `Socrates v${String(spec.version)} · ${spec.status}`,
    "",
    draft.objective,
    "",
    "Scope",
    ...draft.scope,
    "",
    "Requirements",
    ...draft.requirements.map(
      (requirement) =>
        `${requirement.id} · ${requirement.outcome}\nAcceptance · ${requirement.acceptance}`,
    ),
    "",
    "Decisions",
    ...draft.decisions.map((entry) => {
      const basis = `${entry.decision} · ${entry.basis}: ${entry.evidence}`;
      if (!isTrackedDecision(entry)) return basis;
      const history =
        entry.supersedes === undefined
          ? ""
          : ` · Supersedes ${entry.supersedes}`;
      return `${entry.id} · ${entry.disposition} · ${basis}\nUncertainty · ${entry.uncertainty}${history}`;
    }),
    "",
    ...(policy === undefined
      ? []
      : ["Pull request policy", deliveryPolicyText(policy), ""]),
    "Property assessments",
    ...(properties.some(({ recorded }) => recorded) &&
    !coverageBasisCurrent(spec, spec.acceptedRevision)
      ? [
          "Needs review · Reassess the saved evidence against the current brief, specification, plan, and answers.",
        ]
      : []),
    ...(spec.pendingReview === undefined
      ? []
      : ["Recent changes are pending review."]),
    ...properties.map(
      ({ label, status, reason }) => `${label} · ${status} · ${reason}`,
    ),
    ...(coverage?.focus === undefined
      ? []
      : [
          `Saved focus · ${properties.find(({ id }) => id === coverage.focus)?.label ?? coverage.focus}`,
        ]),
    "",
    ...(spec.exchange === undefined
      ? []
      : [
          `Question · ${spec.exchange.prompt.decisionId} · ${spec.exchange.prompt.question}`,
          ...(spec.exchange.answer === undefined
            ? []
            : [`Operator answer · ${spec.exchange.answer.text}`]),
          "",
        ]),
    ...(draft.blockingQuestions.length > 0
      ? ["Open questions", ...draft.blockingQuestions]
      : []),
  ].join("\n");
}

export function isTrackedDecision(
  entry: z.infer<typeof legacyDecision>,
): entry is z.infer<typeof decision> {
  return "id" in entry;
}
export function preserveDecisions(
  previous: LeadSpecification["draft"],
  next: z.infer<typeof specDraft>,
): void {
  const priorPolicy = draftDeliveryPolicy(previous);
  if (
    priorPolicy !== undefined &&
    !isDeepStrictEqual(priorPolicy, next.deliveryPolicy)
  ) {
    const prior = deliveryDecision(previous);
    if (
      resolvedDeliveryDecision(prior) ||
      prior?.disposition === DecisionDisposition.Superseded
    ) {
      const successor = deliveryDecision(next);
      let ancestor = successor?.supersedes;
      while (ancestor !== undefined && ancestor !== priorPolicy.decisionId)
        ancestor = next.decisions.find(
          (item) => item.id === ancestor,
        )?.supersedes;
      if (
        ancestor !== priorPolicy.decisionId ||
        !resolvedDeliveryDecision(successor)
      )
        throw new Error(
          `Supersede delivery decision ${priorPolicy.decisionId} with an evidenced, resolved decision before changing its PR production rules`,
        );
    }
  }
  for (const entry of previous?.decisions ?? []) {
    if (!isTrackedDecision(entry)) continue;
    const updated = next.decisions.find(({ id }) => id === entry.id);
    if (updated === undefined)
      throw new Error(`Retain decision ${entry.id} in the record`);
    if (entry.disposition === DecisionDisposition.Open) continue;
    const allowed =
      entry.disposition === DecisionDisposition.Superseded
        ? [entry.disposition]
        : [entry.disposition, DecisionDisposition.Superseded];
    if (
      !allowed.includes(updated.disposition) ||
      updated.decision !== entry.decision ||
      updated.basis !== entry.basis ||
      updated.evidence !== entry.evidence ||
      updated.uncertainty !== entry.uncertainty ||
      updated.supersedes !== entry.supersedes
    )
      throw new Error(
        `Preserve settled decision ${entry.id} and link a successor if it changed`,
      );
  }
}
