import { z } from "zod";
import { runtimeProjectSchema } from "../config.ts";

export const projectSchema = runtimeProjectSchema
  .extend({ id: z.uuid() })
  .refine(
    (project) => project.id === project.source.projectId,
    "Runtime project identity differs from its Beads source",
  );
export type RuntimeProject = z.infer<typeof projectSchema>;

export const interactiveTargetSchema = z.object({
  session: z.string().min(1),
  socket: z.string().min(1),
  tab: z.number().int().nonnegative(),
});
export type InteractiveTarget = z.infer<typeof interactiveTargetSchema>;
