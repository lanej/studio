import { defineTool } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { packageRoot } from "../package-resources.ts";
import {
  APPLY_PATCH_GRAMMAR,
  MAX_PATCH_BYTES,
  patchSuccess,
} from "./codex-patch-runner.mjs";
import { patchCallView, patchResultView } from "./codex-rendering.ts";
import { patchDiagnosticTargets } from "./patch-diagnostics.ts";
import { quoteShellArgument } from "./shell.ts";

export function codexPatchTool() {
  return defineTool({
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
    async execute(_id, { patch }, signal, _update, ctx) {
      signal?.throwIfAborted();
      if (Buffer.byteLength(patch) > MAX_PATCH_BYTES)
        throw new Error(
          `Patch exceeds the ${String(MAX_PATCH_BYTES)}-byte limit.`,
        );
      // A private input file keeps source text out of shell syntax and argv limits.
      const directory = await mkdtemp(join(tmpdir(), "studio-codex-patch-"));
      try {
        const input = join(directory, "patch");
        await writeFile(input, patch, { flag: "wx", mode: 0o600, signal });
        const command = [
          process.execPath,
          "--no-env-file",
          `--cwd=${packageRoot}`,
          `--config=${join(packageRoot, "resources/bunfig.toml")}`,
          join(packageRoot, "model-tools/codex-patch-runner.mjs"),
          input,
        ]
          .map(quoteShellArgument)
          .join(" ");
        // Bun starts in Studio's installation. The admitted shell supplies the actual target cwd.
        const outcome = await ctx.executeTool("bash", {
          command: `${command} "$PWD"`,
        });
        const applied =
          !outcome.isError &&
          outcome.result.content.some(
            (item) =>
              item.type === "text" && item.text.startsWith(`${patchSuccess}\n`),
          );
        return {
          content: outcome.result.content,
          details: applied
            ? {
                studioPatchApplied: true,
                studioPatchTargets: patchDiagnosticTargets(patch),
              }
            : undefined,
          isError: outcome.isError,
        };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  });
}
