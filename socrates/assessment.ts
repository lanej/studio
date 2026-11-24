import { createHash } from "node:crypto";
import { z } from "zod";
import type { LeadSpecification } from "./spec.ts";

export const coverageDomains = ["engineering", "research", "writing"] as const;
export const coverageStatuses = [
  "unknown",
  "satisfied",
  "partial",
  "open",
  "not-applicable",
] as const;

const universal = [
  { id: "problem-first", label: "Problem First" },
  { id: "interpretation", label: "Interpretation" },
  { id: "clarity", label: "Clarity" },
  { id: "scope", label: "Scope" },
  { id: "context", label: "Context" },
  { id: "parsimony", label: "Parsimony" },
  { id: "success", label: "Success" },
  { id: "verification", label: "Verification" },
  { id: "constraints", label: "Constraints" },
  { id: "stakeholders", label: "Stakeholders" },
  { id: "risk", label: "Risk" },
  { id: "execution-readiness", label: "Execution Readiness" },
  { id: "harmony", label: "Harmony" },
] as const;
const engineering = [
  { id: "modularity", label: "Modularity" },
  {
    id: "policy-mechanism-separation",
    label: "Separation of policy and mechanism",
  },
  { id: "robustness", label: "Robustness" },
  { id: "repair", label: "Repair" },
  { id: "least-surprise", label: "Least Surprise" },
  { id: "regression-protection", label: "Regression Protection" },
] as const;
const research = [
  { id: "falsifiability", label: "Falsifiability" },
  { id: "reproducibility", label: "Reproducibility" },
  { id: "bias", label: "Bias" },
  { id: "causation", label: "Causation" },
] as const;
const writing = [
  { id: "audience", label: "Audience" },
  { id: "argument", label: "Argument" },
  { id: "evidence", label: "Evidence" },
  { id: "action", label: "Action" },
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
    status: coverageStatusSchema,
    reason: z.string().trim().min(1).max(2000).optional(),
  })
  .refine(
    ({ status, reason }) => status === "unknown" || reason !== undefined,
    {
      message: "An assessed property needs its evidence or rationale",
      path: ["reason"],
    },
  );

export const coverageSchema = z
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

export type Coverage = z.infer<typeof coverageSchema>;
export type CoveragePropertyId = z.infer<typeof coveragePropertyIdSchema>;
export type CoverageStatus = z.infer<typeof coverageStatusSchema>;
export interface CoverageProperty {
  readonly id: CoveragePropertyId;
  readonly label: string;
  readonly domain: "universal" | (typeof coverageDomains)[number];
  readonly status: CoverageStatus;
  readonly reason?: string | undefined;
}

export function draftCoverage(
  draft: LeadSpecification["draft"],
): Coverage | undefined {
  return draft !== null && "coverage" in draft ? draft.coverage : undefined;
}

/** Missing assessments stay unknown; an empty replacement never inherits old results. */
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
      return {
        ...property,
        status: assessment?.status ?? "unknown",
        reason: assessment?.reason,
      };
    });
}

/** Bind assessments to the brief and full draft, not just a lifecycle version. */
export function coverageToken(
  spec: Pick<LeadSpecification, "acceptedRevision" | "version" | "draft">,
): string {
  const draft = spec.draft;
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
