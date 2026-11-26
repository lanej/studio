import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { z } from "zod";
import { APPLY_PATCH_GRAMMAR } from "../codex-patch-runner.mjs";
import { patchEditRenderers } from "../codex-rendering.ts";
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
    "Apply a Codex patch, from *** Begin Patch to *** End Patch. Immediately after each Add File, Update File, or Delete File header, include '*** Reason: ' followed by one short sentence explaining why that file changes. For moves, put the reason before *** Move to:.",
  promptSnippet: "Add, update, move, or delete files with a patch",
  parameters: Type.Object(
    {
      patch: Type.String({
        description:
          "The complete patch, including a *** Reason: line for each file.",
      }),
    },
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
          // Result styling needs the source command before Pi's workdir preamble.
          ...(input.workdir === undefined
            ? {}
            : { sourceCommand: input.command }),
        };
      },
    },
  },
  { operation: "patch", tool: patch, display: { compose: patchEditRenderers } },
] as const;

export const codexDialect = {
  matches:
    /^(?:(?:[a-z]{2}|global)\.)?(?:openai[./])?(?:gpt-\d|codex(?:-|$)|o[134](?:-|$))/iu,
  tools: codexTools,
};
