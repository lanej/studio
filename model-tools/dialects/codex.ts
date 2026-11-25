import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { z } from "zod";
import { APPLY_PATCH_GRAMMAR } from "../codex-patch-runner.mjs";
import { patchCallView, patchResultView } from "../codex-rendering.ts";
import { applyPatch, runShell } from "../operations.ts";
import { piShellArguments, type ShellRequest } from "../shell.ts";

export function codexShellRequest(
  command: string,
  workdir?: string,
  timeoutMs?: number,
): ShellRequest {
  return { command, workdir, timeoutMs };
}

const shell = defineTool({
  name: "shell_command",
  label: "Shell command",
  description:
    "Run a shell command and return its output when it finishes. Use workdir to select the working directory for this call.",
  promptSnippet: "Run a command in the checkout",
  parameters: Type.Object(
    {
      command: Type.String(),
      workdir: Type.Optional(Type.String({ minLength: 1 })),
      timeout_ms: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 2147483647 }),
      ),
    },
    { additionalProperties: false },
  ),
  execute(_id, args, _signal, onUpdate, ctx) {
    return runShell(
      ctx,
      codexShellRequest(args.command, args.workdir, args.timeout_ms),
      onUpdate,
    );
  },
});

const patch = defineTool({
  name: "apply_patch",
  label: "Apply patch",
  description:
    "Apply a Codex patch to files in the working directory. The patch begins with *** Begin Patch and ends with *** End Patch.",
  promptSnippet: "Add, update, move, or delete files with a patch",
  parameters: Type.Object(
    { patch: Type.String({ description: "The complete Codex patch text" }) },
    { additionalProperties: false },
  ),
  constrainedSampling: {
    type: "grammar",
    variants: { openai_lark: APPLY_PATCH_GRAMMAR },
  },
  annotations: { destructiveHint: true },
  executionMode: "sequential",
  exposure: "model-only",
  defaultActive: false,
  renderCall(args, theme, context) {
    return patchCallView(
      typeof args.patch === "string" ? args.patch : "",
      context.argsComplete,
      context.expanded,
      theme,
    );
  },
  renderResult(result, options, theme, context) {
    return patchResultView(
      result,
      context.isError,
      options.expanded,
      context.keyHint("app.tools.expand", "to expand"),
      theme,
    );
  },
  execute(_id, args, signal, _update, ctx) {
    return applyPatch(ctx, args.patch, signal);
  },
});

const streamedShell = z
  .object({ command: z.string(), workdir: z.string(), timeout_ms: z.number() })
  .partial()
  .catch({});

export const codexTools = [
  {
    operation: "shell",
    tool: shell,
    display: {
      arguments(raw: unknown, cwd: string) {
        const input = streamedShell.parse(raw);
        const args = piShellArguments(
          cwd,
          codexShellRequest(
            input.command ?? "",
            input.workdir,
            input.timeout_ms,
          ),
        );
        return {
          ...args,
          command: input.command === undefined ? undefined : args.command,
        };
      },
    },
  },
  { operation: "patch", tool: patch },
] as const;

export const codexDialect = {
  matches:
    /^(?:(?:[a-z]{2}|global)\.)?(?:openai[./])?(?:gpt-\d|codex(?:-|$)|o[134](?:-|$))/iu,
  tools: codexTools,
};
