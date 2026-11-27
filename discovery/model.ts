import { z } from "zod";
import { projectSchema } from "../execution/target.ts";
import { leadPlanSchema, planWorkersSchema } from "../planning/plan.ts";
import { specRecord } from "../socrates/spec.ts";

export enum HandoffPhase {
  Pending = "pending",
  Complete = "complete",
  Uncertain = "uncertain",
}
export const discoverySchema = z.object({
  id: z.uuid(),
  title: z.string().min(1),
  project: z.string(),
  conversation: z.string(),
  revision: z.string(),
  specification: specRecord.optional(),
  history: z.array(specRecord).default([]),
  leadPlan: leadPlanSchema,
  planSpecificationRevision: z.string().optional(),
  handoff: z
    .object({
      operation: z.uuid(),
      digest: z.string(),
      revision: z.string(),
      phase: z.enum(HandoffPhase),
      workers: planWorkersSchema.optional(),
      owner: z.object({ pid: z.number().int().positive(), started: z.string() }).optional(),
      target: projectSchema,
    })
    .optional(),
  approved: z.string().optional(),
  graph: z.record(z.string(), z.string()).optional(),
});
export type Discovery = z.infer<typeof discoverySchema>;

export type DiscoveryHandoff = NonNullable<Discovery["handoff"]>;
