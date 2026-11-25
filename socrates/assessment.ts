import { createHash } from "node:crypto";
import { z } from "zod";
import {
  deliveryPolicySchema,
  draftDeliveryPolicy,
} from "./delivery-policy.ts";
import type { LeadSpecification } from "./spec.ts";

export const coverageDomains = ["engineering", "research", "writing"] as const;
export const coverageStatuses = [
  "satisfied",
  "partial",
  "open",
  "not-applicable",
] as const;

const universal = [
  {
    id: "problem-first",
    label: "Problem First",
    gap: "Identify the problem and who experiences it.",
  },
  {
    id: "interpretation",
    label: "Interpretation",
    gap: "State the intended outcome in terms the operator can confirm.",
  },
  {
    id: "clarity",
    label: "Clarity",
    gap: "Define the terms that change the expected outcome.",
  },
  {
    id: "scope",
    label: "Scope",
    gap: "Identify the included work and meaningful exclusions.",
  },
  {
    id: "context",
    label: "Context",
    gap: "Record the background and sources the work depends on.",
  },
  {
    id: "parsimony",
    label: "Parsimony",
    gap: "Explain why each proposed part is necessary.",
  },
  {
    id: "success",
    label: "Success",
    gap: "Define an observable success criterion.",
  },
  {
    id: "verification",
    label: "Verification",
    gap: "Identify how the outcome will be verified.",
  },
  {
    id: "constraints",
    label: "Constraints",
    gap: "Identify applicable limits on the work.",
  },
  {
    id: "stakeholders",
    label: "Stakeholders",
    gap: "Identify affected people and decision makers.",
  },
  {
    id: "risk",
    label: "Risk",
    gap: "Identify consequential assumptions and how to check them.",
  },
  {
    id: "execution-readiness",
    label: "Execution Readiness",
    gap: "Establish the inputs, dependencies, and authority to proceed.",
  },
  {
    id: "harmony",
    label: "Harmony",
    gap: "Check that requirements, decisions, and acceptance criteria agree.",
  },
] as const;
const engineering = [
  {
    id: "modularity",
    label: "Modularity",
    gap: "Identify independently verifiable boundaries in the work.",
  },
  {
    id: "policy-mechanism-separation",
    label: "Separation of policy and mechanism",
    gap: "Identify where decisions are made and where they are enforced.",
  },
  {
    id: "robustness",
    label: "Robustness",
    gap: "Describe how the design handles relevant failures.",
  },
  {
    id: "repair",
    label: "Repair",
    gap: "Establish how failures will be diagnosed and recovered.",
  },
  {
    id: "least-surprise",
    label: "Least Surprise",
    gap: "Check the change against established user expectations.",
  },
  {
    id: "regression-protection",
    label: "Regression Protection",
    gap: "Specify how existing behavior will be preserved and checked.",
  },
] as const;
const research = [
  {
    id: "falsifiability",
    label: "Falsifiability",
    gap: "Identify what observation would overturn the conclusion.",
  },
  {
    id: "reproducibility",
    label: "Reproducibility",
    gap: "Record the inputs and procedure needed to reproduce the result.",
  },
  {
    id: "bias",
    label: "Bias",
    gap: "Identify relevant sources of bias and how they will be addressed.",
  },
  {
    id: "causation",
    label: "Causation",
    gap: "Establish what the evidence supports about cause and effect.",
  },
] as const;
const writing = [
  {
    id: "audience",
    label: "Audience",
    gap: "Identify the intended readers and their needs.",
  },
  {
    id: "argument",
    label: "Argument",
    gap: "State the claim and the reasoning that supports it.",
  },
  {
    id: "evidence",
    label: "Evidence",
    gap: "Identify the sources supporting the claims.",
  },
  {
    id: "action",
    label: "Action",
    gap: "Identify what the reader should be able to do.",
  },
] as const;

/** Names and task sets from the shared Socrates dialogue contract. */
export const coveragePropertyCatalog = [
  ...universal.map((property) => ({
    ...property,
    domain: "universal" as const,
  })),
  ...engineering.map((property) => ({
    ...property,
    domain: "engineering" as const,
  })),
  ...research.map((property) => ({ ...property, domain: "research" as const })),
  ...writing.map((property) => ({ ...property, domain: "writing" as const })),
];
export const coveragePropertyIds = coveragePropertyCatalog.map(({ id }) => id);
export const coveragePropertyIdSchema = z.enum(coveragePropertyIds);
export const coverageDomainSchema = z.enum(coverageDomains);
export const coverageStatusSchema = z.enum(coverageStatuses);

const assessmentSchema = z
  .strictObject({
    propertyId: coveragePropertyIdSchema,
    status: z.enum([...coverageStatuses, "unknown"]),
    reason: z.string().trim().min(1).max(2000).optional(),
  })
  .refine(
    ({ status, reason }) => status === "unknown" || reason !== undefined,
    {
      message: "An assessed property needs its evidence or rationale",
      path: ["reason"],
    },
  );

export const savedCoverageSchema = z
  .strictObject({
    domains: z.array(coverageDomainSchema).max(coverageDomains.length),
    assessments: z.array(assessmentSchema).max(coveragePropertyCatalog.length),
    focus: coveragePropertyIdSchema.optional(),
  })
  .superRefine((coverage, ctx) => {
    if (new Set(coverage.domains).size !== coverage.domains.length)
      ctx.addIssue({
        code: "custom",
        path: ["domains"],
        message: "Use each property domain once",
      });
    const ids = coverage.assessments.map(({ propertyId }) => propertyId);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: "custom",
        path: ["assessments"],
        message: "Assess each property once",
      });
    const selected = new Set(
      coveragePropertyCatalog
        .filter(
          ({ domain }) =>
            domain === "universal" || coverage.domains.includes(domain),
        )
        .map(({ id }) => id),
    );
    if (
      ids.some((id) => !selected.has(id)) ||
      (coverage.focus !== undefined && !selected.has(coverage.focus))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Select the domain before assessing or focusing its properties",
      });
  });

/** Historical records may be sparse. Each new snapshot must account for the entire selected catalog. */
export const coverageSchema = savedCoverageSchema.superRefine(
  (coverage, ctx) => {
    const assessed = new Set(
      coverage.assessments
        .filter(({ status }) => status !== "unknown")
        .map(({ propertyId }) => propertyId),
    );
    const missing = coveragePropertyCatalog
      .filter(
        ({ id, domain }) =>
          (domain === "universal" || coverage.domains.includes(domain)) &&
          !assessed.has(id),
      )
      .map(({ id }) => id);
    if (missing.length > 0)
      ctx.addIssue({
        code: "custom",
        path: ["assessments"],
        message: `Assess every property in the selected domains. Supply a status and rationale for: ${missing.join(", ")}. Use open for missing evidence.`,
      });
  },
);

export type Coverage = z.infer<typeof savedCoverageSchema>;
export type CoveragePropertyId = z.infer<typeof coveragePropertyIdSchema>;
export type CoverageStatus = z.infer<typeof coverageStatusSchema>;
export interface CoverageProperty {
  readonly id: CoveragePropertyId;
  readonly label: string;
  readonly domain: "universal" | (typeof coverageDomains)[number];
  readonly status: CoverageStatus;
  readonly reason: string;
  readonly recorded: boolean;
}

export function draftCoverage(
  draft: LeadSpecification["draft"],
): Coverage | undefined {
  return draft !== null && "coverage" in draft ? draft.coverage : undefined;
}

/** Before the first draft and in older records, absent evidence leaves the property open. */
export function coverageProperties(
  draft: LeadSpecification["draft"],
): CoverageProperty[] {
  const coverage = draftCoverage(draft);
  const domains = coverage?.domains ?? [];
  const assessments = new Map(
    coverage?.assessments.map((assessment) => [
      assessment.propertyId,
      assessment,
    ]),
  );
  return coveragePropertyCatalog
    .filter(({ domain }) => domain === "universal" || domains.includes(domain))
    .map((property) => {
      const assessment = assessments.get(property.id);
      if (assessment === undefined || assessment.status === "unknown")
        return {
          ...property,
          status: "open",
          reason: property.gap,
          recorded: false,
        };
      return {
        ...property,
        status: assessment.status,
        reason: assessment.reason ?? property.gap,
        recorded: true,
      };
    });
}

/** Bind assessments to the brief and full draft, not just a lifecycle version. */
export function coverageToken(
  spec: Pick<LeadSpecification, "acceptedRevision" | "version" | "draft">,
): string {
  const draft = spec.draft;
  const policy = draftDeliveryPolicy(draft);
  // Project the semantic fields in a fixed order. Coverage and approval are observations about them.
  const content =
    draft === null
      ? null
      : {
          objective: draft.objective,
          scope: draft.scope,
          requirements: draft.requirements.map(
            ({ id, outcome, acceptance }) => ({ id, outcome, acceptance }),
          ),
          decisions: draft.decisions.map((entry) => ({
            ...("id" in entry
              ? {
                  id: entry.id,
                  disposition: entry.disposition,
                  uncertainty: entry.uncertainty,
                  supersedes: entry.supersedes,
                }
              : {}),
            decision: entry.decision,
            basis: entry.basis,
            evidence: entry.evidence,
          })),
          blockingQuestions: draft.blockingQuestions,
          deliveryPolicy:
            policy === undefined
              ? undefined
              : deliveryPolicySchema.parse(policy),
        };
  return createHash("sha256")
    .update(
      JSON.stringify({
        acceptedRevision: spec.acceptedRevision,
        version: spec.version,
        draft: content,
      }),
    )
    .digest("hex");
}

export function coverageFresh(
  spec: LeadSpecification,
  currentRevision: string | null,
): boolean {
  return (
    draftCoverage(spec.draft) !== undefined &&
    spec.acceptedRevision === currentRevision &&
    spec.exchange?.answer === undefined &&
    spec.coverageRevision === coverageToken(spec)
  );
}
