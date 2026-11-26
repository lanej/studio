import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export function registerTaskSubmission(
  pi: ExtensionAPI,
  readStatus: () => { beadId: string; closed: boolean },
  submit: (
    summary: string,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) => Promise<string>,
): void {
  pi.registerCommand("task-submit", {
    description: "Verify a result against this bead's accepted criteria",
    handler: async (summary, ctx) => {
      const { closed } = readStatus();
      const result = await submit(summary, ctx);
      if (closed) ctx.ui.notify(result, "info");
    },
  });
  pi.registerTool({
    name: "task_submit_result",
    label: "Submit task result",
    description:
      "Run the operator's agreed check and submit evidence for the accepted bead.",
    parameters: Type.Object({
      summary: Type.String({ minLength: 1, maxLength: 4000 }),
    }),
    execute: async (_call, params, signal, _onUpdate, ctx) => {
      const text = await submit(params.summary, ctx, signal);
      return {
        content: [{ type: "text", text }],
        details: { bead: readStatus().beadId },
      };
    },
  });
}
