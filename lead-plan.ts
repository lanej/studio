import { createHash } from "node:crypto";
import { z } from "zod";
import { taskWaves } from "./smart-plan-graph.ts";
import { worktreeRelativePath } from "./worktree-path.ts";

export enum LeadMode {
  Planning = "planning",
  Applying = "applying",
  Implementing = "implementing",
}

export enum TaskDelivery {
  Local = "local",
  PullRequest = "pull-request",
}

export function deliveryOutcome(delivery?: TaskDelivery): string {
  return delivery === TaskDelivery.PullRequest
    ? "Opens a PR"
    : "Local integration only — no PR";
}

export function reviseDelivery(draft: LeadDraft, argument: string): LeadDraft {
  const [key, mode, ...extra] = argument.trim().split(/\s+/u);
  if (
    extra.length > 0 ||
    key === undefined ||
    key.length === 0 ||
    (mode !== TaskDelivery.Local && mode !== TaskDelivery.PullRequest)
  )
    throw new Error("Usage: /plan-delivery <task-key> <local|pull-request>");
  if (!draft.tasks.some((task) => task.key === key))
    throw new Error(`No task named ${key} in the draft`);
  return {
    ...draft,
    tasks: draft.tasks.map((task) =>
      task.key === key ? { ...task, delivery: mode } : task,
    ),
  };
}

export const taskKey = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/u)
  .refine(
    (key) => key !== "root",
    "The root task key is reserved for the graph container",
  );
export const pullRequestMergeSchema = z.enum(["manual", "project-policy"]);
export const draftSchema = z
  .strictObject({
    summary: z.string().trim().min(1).max(8000),
    pullRequestMerge: pullRequestMergeSchema.optional(),
    tasks: z
      .array(
        z.strictObject({
          key: taskKey,
          hold: z.boolean().optional(),
          check: z.array(z.string().min(1)).max(64).optional(),
          delivery: z.enum(TaskDelivery).optional(),
          title: z.string().trim().min(1).max(200),
          description: z.string().trim().min(1).max(2000),
          acceptance: z.string().trim().min(1).max(2000),
          blockedBy: z.array(taskKey).max(12).default([]),
          requirements: z
            .array(z.string().regex(/^R[1-9]\d*$/u))
            .max(20)
            .default([]),
          owns: z.array(worktreeRelativePath).max(20).default([]),
        }),
      )
      .max(12),
  })
  .superRefine((draft, ctx) => {
    try {
      taskWaves(draft.tasks);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: ["tasks"],
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (
      1 +
        2 * draft.tasks.length +
        draft.tasks.reduce((count, task) => count + task.blockedBy.length, 0) >
      100
    )
      ctx.addIssue({
        code: "custom",
        path: ["tasks"],
        message: "The task graph exceeds one atomic Beads batch",
      });
  });

export type LeadDraft = z.infer<typeof draftSchema>;
const childBeads = z.record(taskKey, z.string().min(1));
export const leadPlanSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal(LeadMode.Planning),
    draft: draftSchema.nullable(),
    children: childBeads.optional(),
  }),
  z.strictObject({
    mode: z.literal(LeadMode.Applying),
    draft: draftSchema,
    digest: z.string(),
    specificationVersion: z.number().int().positive().optional(),
    children: childBeads.optional(),
  }),
  z.strictObject({
    mode: z.literal(LeadMode.Implementing),
    draft: draftSchema,
    digest: z.string(),
    specificationVersion: z.number().int().positive().optional(),
    // Beads stamp added by applyPlan after verifying the original brief at both revisions.
    briefRevisionAdvance: z
      .strictObject({ from: z.string().min(1), to: z.string().min(1) })
      .optional(),
    children: childBeads,
  }),
]);

export function planDigest(draft: LeadDraft): string {
  return createHash("sha256").update(JSON.stringify(draft)).digest("hex");
}

// Wave grouping adapts Smart Plan's src/render.ts at 3e51e33acd63a7743391e21598042438746aafa0.
export function orderedTasks(draft: LeadDraft): LeadDraft["tasks"] {
  const waves = taskWaves(draft.tasks);
  return [...draft.tasks].sort(
    (left, right) => (waves.get(left.key) ?? 0) - (waves.get(right.key) ?? 0),
  );
}

export function taskReviewFields(
  task: LeadDraft["tasks"][number],
  intent: "proposal" | "execution" = "execution",
  deliveryLabel?: string,
): { label: string; value: string }[] {
  const delivery =
    task.delivery === undefined && intent === "proposal"
      ? "To be decided"
      : `${deliveryOutcome(task.delivery)}${task.delivery === undefined ? " (default)" : ""}`;
  const verification =
    task.check === undefined || task.check.length === 0
      ? "independent criterion review; no executable agreed"
      : JSON.stringify(task.check);
  return [
    { label: "Acceptance", value: task.acceptance },
    ...(task.requirements.length > 0
      ? [{ label: "Requirements", value: task.requirements.join(", ") }]
      : []),
    {
      label: "Owns",
      value:
        task.owns.length === 0
          ? "the entire isolated checkout"
          : task.owns.join(", "),
    },
    {
      label: "Admission",
      value: task.hold === true ? "on hold" : "when ready",
    },
    { label: "Delivery", value: deliveryLabel ?? delivery },
    { label: "Verification", value: verification },
    ...(task.blockedBy.length > 0
      ? [{ label: "Blocked by", value: task.blockedBy.join(", ") }]
      : []),
  ];
}

/** An already merged prerequisite carries its own ancestors on the target branch. */
export function publicationPrerequisites(
  draft: LeadDraft,
  publisher: LeadDraft["tasks"][number],
): LeadDraft["tasks"] {
  const ordered = orderedTasks(draft);
  const required = new Set(publisher.blockedBy);
  const includedByPullRequest = new Set<string>();
  for (const task of ordered.toReversed()) {
    if (!required.has(task.key)) continue;
    for (const key of task.blockedBy) {
      required.add(key);
      if (
        task.delivery === TaskDelivery.PullRequest ||
        includedByPullRequest.has(task.key)
      )
        includedByPullRequest.add(key);
    }
  }
  return ordered.filter(
    (task) => required.has(task.key) && !includedByPullRequest.has(task.key),
  );
}

export function publicationGroups(draft: LeadDraft) {
  return orderedTasks(draft)
    .filter((task) => task.delivery === TaskDelivery.PullRequest)
    .map((publisher) => ({
      publisher,
      local: publicationPrerequisites(draft, publisher).filter(
        (dependency) => dependency.delivery !== TaskDelivery.PullRequest,
      ),
    }));
}

export function taskReviewLines(
  task: LeadDraft["tasks"][number],
  intent: "proposal" | "execution" = "execution",
): string[] {
  return [
    task.description,
    ...taskReviewFields(task, intent).map(
      ({ label, value }) => `${label} · ${value}`,
    ),
  ];
}

export function describePlan(
  draft: LeadDraft,
  intent: "proposal" | "execution" = "execution",
): string {
  const waves = taskWaves(draft.tasks);
  let displayedWave = 0;
  return [
    draft.summary,
    "Change a proposal before approval: /plan-delivery <task-key> <local|pull-request>",
    ...orderedTasks(draft).flatMap((task) => {
      const wave = waves.get(task.key) ?? 0;
      const heading =
        wave === displayedWave ? [] : ["", `Wave ${String(wave)}`];
      displayedWave = wave;
      return [
        ...heading,
        "",
        `├─ ${task.key} · ${task.title}`,
        ...taskReviewLines(task, intent),
      ];
    }),
  ].join("\n");
}
