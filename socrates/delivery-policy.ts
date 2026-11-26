import { Type } from "typebox";
import { z } from "zod";
import { pullRequestMergeSchema, taskKey } from "../lead-plan.ts";
import type { LeadSpecification } from "./spec.ts";

export const decisionId = z.string().regex(/^D[1-9]\d*$/u);
export const deliveryPolicySchema = z.discriminatedUnion("pullRequests", [
  z.strictObject({ decisionId, pullRequests: z.literal("none") }),
  z.strictObject({
    decisionId,
    pullRequests: z.literal("per-bead"),
    merge: pullRequestMergeSchema,
  }),
  z.strictObject({
    decisionId,
    pullRequests: z.literal("selected"),
    publish: z
      .array(taskKey)
      .min(1)
      .max(12)
      .refine((keys) => new Set(keys).size === keys.length, "List each publishing bead once")
      .transform((keys) => keys.sort()),
    merge: pullRequestMergeSchema,
  }),
]);
export type DeliveryPolicy = z.infer<typeof deliveryPolicySchema>;

export const deliveryPolicyParameter = Type.Optional(
  Type.Object(
    {
      decisionId: Type.String({
        description: "The decision recording the source of the PR and merge rules",
      }),
      pullRequests: Type.Union([Type.Literal("none"), Type.Literal("per-bead"), Type.Literal("selected")]),
      publish: Type.Optional(
        Type.Array(Type.String(), {
          description: "For selected only, the exact keys of the beads that produce PRs",
          minItems: 1,
          maxItems: 12,
          uniqueItems: true,
        }),
      ),
      merge: Type.Optional(
        Type.Union(
          pullRequestMergeSchema.options.map((rule) => Type.Literal(rule)),
          {
            description:
              "Required when producing PRs. Manual reserves merge for a person. Project policy delegates eligibility to the configured runtime policy.",
          },
        ),
      ),
    },
    {
      description: "Record the evidenced publication arrangement. Omit while the delivery decision is open.",
    },
  ),
);

export function draftDeliveryPolicy(draft: LeadSpecification["draft"]): DeliveryPolicy | undefined {
  return draft !== null && "deliveryPolicy" in draft ? draft.deliveryPolicy : undefined;
}

export function deliveryPolicyText(policy: DeliveryPolicy): string {
  if (policy.pullRequests === "none") return `Local integration for every bead · ${policy.decisionId}`;
  const publish =
    policy.pullRequests === "per-bead"
      ? "Open one PR per bead"
      : `Open PRs for ${policy.publish.join(", ")}. Integrate other beads locally.`;
  const merge = policy.merge === "manual" ? "Manual merge" : "Merge follows project policy";
  return `${publish}\n${merge} · ${policy.decisionId}`;
}
