import {
  createEditToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { analyzeEditSyntax } from "./syntax-analysis.ts";
import { maxSyntaxSourceBytes, supportsSyntax } from "./tree-sitter.ts";
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

// Pi computes its numbered diff after stripping the BOM and normalizing line endings.
function diffSource(text: string): string {
  return text.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
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
      async execute(id, args, signal, update, context) {
        requireEditReason(args);
        if (!supportsSyntax(args.path))
          return native.execute(id, args, signal, update, context);
        // Capture this edit's actual read and successful write inside Pi's mutation queue.
        // Reading the path again after execute could observe a subsequent edit.
        let before: Buffer | undefined;
        let after: string | undefined;
        const tool = createEditToolDefinition(ctx.cwd, {
          operations: {
            access: (path) => access(path, constants.R_OK | constants.W_OK),
            async readFile(path) {
              const buffer = await readFile(path);
              if (buffer.length <= maxSyntaxSourceBytes) before = buffer;
              return buffer;
            },
            async writeFile(path, content) {
              await writeFile(path, content, "utf8");
              if (
                before !== undefined &&
                Buffer.byteLength(content) <= maxSyntaxSourceBytes
              )
                after = content;
            },
          },
        });
        const result = await tool.execute(id, args, signal, update, context);
        if (
          before === undefined ||
          after === undefined ||
          result.details === undefined ||
          result.details.diff.length > 65536
        )
          return result;
        try {
          const syntax = await analyzeEditSyntax(
            args.path,
            diffSource(before.toString("utf8")),
            diffSource(after),
            result.details.diff,
          );
          return syntax === undefined
            ? result
            : {
                ...result,
                details: { ...result.details, studioSyntax: syntax },
              };
        } catch {
          // The file was already updated. A parser failure must not invite a second edit.
          return result;
        }
      },
    });
  });
}
