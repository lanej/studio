import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { draftSchema, planWorkersSchema, type LeadDraft } from "../planning/plan.ts";
import { interactiveTargetSchema, projectSchema, storedProjectSchema } from "./target.ts";

export const handoffIntentSchema = z.object({
  digest: z.string(),
  ids: z.record(z.string(), z.string()),
  interactive: interactiveTargetSchema.optional(),
  project: z.uuid().optional(),
  target: projectSchema.optional(),
  draft: draftSchema.optional(),
  workers: planWorkersSchema.optional(),
});
export type HandoffIntent = z.infer<typeof handoffIntentSchema>;
export type RetainedHandoffIntent = HandoffIntent & { id: string };

/**
 * Legacy handoff intents may embed project targets with claimLabel.
 * Use this schema when reading persisted intents to preserve legacy fields
 * and allow safe handoff preflight for unrelated plans.
 */
export const storedHandoffIntentSchema = z.object({
  digest: z.string(),
  ids: z.record(z.string(), z.string()),
  interactive: interactiveTargetSchema.optional(),
  project: z.uuid().optional(),
  target: storedProjectSchema.optional(),
  draft: draftSchema.optional(),
  workers: planWorkersSchema.optional(),
});

/** Reconciliation uses the graph IDs already recorded before the Beads request. */
export function handoffTaskIds(prefix: string, revision: string, draft: LeadDraft): HandoffIntent["ids"] {
  const root = `${prefix}-${revision.replaceAll("-", "")}`;
  const entries: [string, string][] = [["root", root]];
  for (const task of draft.tasks) entries.push([task.key, `${root}.${task.key}`]);
  return Object.fromEntries(entries);
}

export function checkHandoffRetry(
  retained: HandoffIntent,
  approved: Pick<HandoffIntent, "digest" | "interactive" | "workers">,
): void {
  if (
    retained.digest !== approved.digest ||
    !isDeepStrictEqual(retained.interactive, approved.interactive) ||
    !isDeepStrictEqual(retained.workers, approved.workers)
  )
    throw new Error(
      "A different graph creation attempt is already retained; reconcile it before changing the proposal",
    );
}
