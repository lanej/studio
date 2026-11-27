import { z } from "zod";
import { runtimeProjectSchema, studioProfileSchema } from "../config.ts";

export const executionProfileFields = {
  profile: studioProfileSchema,
  profileDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
};
const targetSchema = runtimeProjectSchema.extend({ id: z.uuid(), ...executionProfileFields });
export const projectSchema = targetSchema.refine(
  (project) => project.id === project.source.projectId,
  "Runtime project identity differs from its Beads source",
);
export type RuntimeProject = z.infer<typeof projectSchema>;

/**
 * Legacy runtime records may contain claimLabel from earlier releases.
 * Preserve the legacy claim scope so it still differs from any current enrollment.
 */
export const storedProjectSchema = targetSchema
  .extend({ claimLabel: z.string().min(1).optional() })
  .refine(
    (project) => project.id === project.source.projectId,
    "Runtime project identity differs from its Beads source",
  );

export const interactiveTargetSchema = z.object({
  session: z.string().min(1),
  socket: z.string().min(1),
  tab: z.number().int().nonnegative(),
});
export type InteractiveTarget = z.infer<typeof interactiveTargetSchema>;
