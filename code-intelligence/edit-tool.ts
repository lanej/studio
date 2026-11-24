import {
  createEditToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { z } from "zod";

export const editReason = Type.String({
  description:
    "In one sentence, explain the problem this edit fixes or the outcome it enables.",
  minLength: 1,
  pattern: "\\S",
});

const reasonInput = z.looseObject({ reason: z.string().trim().min(1) });

// Preserve the rest of the call while validating the reason before Pi coerces scalars.
export function requireEditReason(input: unknown) {
  const parsed = reasonInput.safeParse(input);
  if (!parsed.success)
    throw new Error("Explain why this edit is needed in the reason field.");
  return parsed.data;
}

export function registerReasonedEdit(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    const edit = pi.getAllTools().find((tool) => tool.name === "edit");
    // SDK base-tool overrides do not carry the native prompt guidelines.
    // Keep custom executors (e.g. remote filesystems) and tool allowlists intact.
    if (
      edit?.sourceInfo.path !== "builtin:edit" ||
      edit.promptGuidelines === undefined
    )
      return;
    const { prepareArguments, ...native } = createEditToolDefinition(ctx.cwd);
    pi.registerTool({
      ...native,
      defaultActive: false,
      parameters: Type.Object({
        ...native.parameters.properties,
        reason: editReason,
      }),
      ...(prepareArguments === undefined
        ? {}
        : {
            prepareArguments(raw: unknown) {
              const args = requireEditReason(raw);
              return { ...prepareArguments(args), reason: args.reason };
            },
          }),
      execute(id, args, signal, update, context) {
        requireEditReason(args);
        return native.execute(id, args, signal, update, context);
      },
    });
  });
}
