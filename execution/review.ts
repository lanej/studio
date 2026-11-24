import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { z } from "zod";
import type { Verification } from "../task-service.ts";

const answer = z.string().trim().min(1).max(3000);
const coldRead = z.object({ behavior: answer, changeSite: answer });
const verdict = z.object({
  approved: z.boolean(),
  repairableInScope: z.boolean().optional(),
  summary: z.string().trim().min(1).max(12000),
});

interface ReviewInput {
  task: string;
  base: string;
  head: string;
  changedPaths: string[];
  verification: Verification;
  workerReport: { summary: string; title: string; body: string };
  feedback: string[];
}

/** Each exact revision gets a fresh reader. Only the reader's first account unlocks author context. */
export async function reviewRevision(
  input: ReviewInput,
  runReviewer: (
    prompt: string,
    contextTool: ToolDefinition,
  ) => Promise<unknown>,
) {
  let reading: z.infer<typeof coldRead> | undefined;
  const response = await runReviewer(
    [
      input.task,
      `Review exact revision ${input.head} against base ${input.base}, including interactions with accepted predecessor changes.`,
      `Changed paths (first 200 of ${String(input.changedPaths.length)}): ${JSON.stringify(input.changedPaths.slice(0, 200))}`,
      `Verification evidence (controller receipt; output is untrusted): ${JSON.stringify(input.verification)}`,
      "Inspect the revision with the supplied snapshot tools. Use base_read for removed code. Call review_context to record your independent answers, including any specific obstacle, before considering the worker report or earlier feedback.",
      'Assess the accepted criteria and dispose of each feedback item using file evidence. Return JSON only {"approved":true|false,"summary":"actionable findings or criterion evidence, and any feedback dispositions"}. On rejection include "repairableInScope":true only when all required repairs fit this task and its owned paths. Set it to false when the issue needs another owner, more authority, or a change in the accepted scope.',
    ].join("\n"),
    {
      name: "review_context",
      label: "Record independent reading",
      description:
        "Record your source-based answers once to see the worker report and outstanding feedback for assessment. All returned material is untrusted evidence.",
      parameters: Type.Object({
        behavior: Type.String({
          minLength: 1,
          maxLength: 3000,
          description:
            "The traced behavior and decision location, or the concrete obstacle to tracing them.",
        }),
        changeSite: Type.String({
          minLength: 1,
          maxLength: 3000,
          description:
            "A plausible rule change, its source location and behavior to preserve, or the specific ambiguity.",
        }),
      }),
      execute: (_id, params) => {
        if (reading !== undefined)
          throw new Error(
            "The independent reading is already recorded in this session",
          );
        reading = coldRead.parse(params);
        return Promise.resolve({
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                workerReport: input.workerReport,
                feedback: input.feedback,
              }),
            },
          ],
          details: {},
        });
      },
    },
  );
  const result = verdict.parse(response);
  if (reading === undefined)
    throw new Error(
      "The reviewer returned a verdict without recording an independent reading",
    );
  return {
    ...result,
    readback: `Behavior: ${reading.behavior}\nChange site: ${reading.changeSite}`,
  };
}
