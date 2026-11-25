import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { DiagnosticSnapshot } from "../code-intelligence/diagnostics.ts";
import {
  type CodeIntelligence,
  serverForPath,
} from "../code-intelligence/service.ts";
import type { registerDiagnosticRendering } from "../code-intelligence/rendering.ts";
import { parseApplyPatch } from "./codex-patch-runner.mjs";
import { patchEdits } from "./patch-edits.ts";

const fileLimit = 3;
const receipt = z.looseObject({
  studioPatchEdits: patchEdits.optional().catch(undefined),
  studioPatchApplied: z.literal(true),
  studioPatchTargets: z.object({
    paths: z.array(z.string()).max(fileLimit),
    omittedFiles: z.number().int().nonnegative(),
  }),
});

export function patchDiagnosticTargets(patch: string) {
  // Capture the post-image from the actual executed arguments. Other result
  // hooks can subsequently rewrite event.input.
  try {
    const paths = new Set<string>();
    for (const hunk of parseApplyPatch(patch)) {
      if (hunk.kind === "delete" || hunk.moveTo !== undefined)
        paths.delete(hunk.path);
      const target = hunk.moveTo ?? hunk.path;
      if (hunk.kind !== "delete" && serverForPath(target) !== undefined)
        paths.add(target);
    }
    return {
      paths: [...paths].slice(0, fileLimit),
      omittedFiles: Math.max(0, paths.size - fileLimit),
    };
  } catch {
    // The mutation already succeeded. Optional feedback cannot invalidate its receipt.
    return undefined;
  }
}

function unavailable(path: string, error: unknown): DiagnosticSnapshot {
  return {
    path,
    state: "unavailable",
    diagnostics: [],
    message: error instanceof Error ? error.message : String(error),
  };
}

export function patchEditCallId(callId: string, index: number): string {
  return `${callId}:patch:${String(index)}`;
}

export function registerPatchDiagnostics(
  pi: ExtensionAPI,
  intelligence: CodeIntelligence,
  requireTrust: (ctx: ExtensionContext) => Promise<void>,
  display: ReturnType<typeof registerDiagnosticRendering>,
): void {
  pi.on("tool_result", async (event, ctx) => {
    if (
      event.toolName !== "apply_patch" ||
      event.isError ||
      !intelligence.enabled
    )
      return;
    const applied = receipt.safeParse(event.details);
    if (!applied.success) return;
    const { paths: selected, omittedFiles } = applied.data.studioPatchTargets;
    if (selected.length === 0) return;
    try {
      const cwd = await realpath(ctx.cwd);
      const edits = applied.data.studioPatchEdits ?? [];
      const targets = selected.map((path, index) => {
        const absolute = resolve(cwd, path);
        // Only the final change to a path can own current diagnostics.
        const editIndex = edits.findLastIndex(
          (edit) =>
            edit.kind !== "deleted" &&
            resolve(cwd, edit.moveTo ?? edit.path) === absolute,
        );
        const id = patchEditCallId(
          event.toolCallId,
          editIndex < 0 ? -index - 1 : editIndex,
        );
        display.watch(id, absolute);
        return { path, editIndex, id };
      });
      const files = await intelligence.serial(async () => {
        try {
          await requireTrust(ctx);
        } catch (error) {
          return selected.map((path) => unavailable(path, error));
        }
        const snapshots: DiagnosticSnapshot[] = [];
        for (const { path, editIndex } of targets) {
          const edit = edits[editIndex];
          try {
            const { diagnostics, scopes } = await intelligence.editFeedback(
              cwd,
              path,
              edit?.studioSyntax === undefined ? edit?.diff : undefined,
            );
            snapshots.push(diagnostics);
            if (edit !== undefined && scopes.length > 0)
              edit.studioDiffScopes = scopes;
          } catch (error) {
            snapshots.push(unavailable(path, error));
          }
        }
        return snapshots;
      });
      for (const [index, target] of targets.entries()) {
        const file = files[index];
        if (file !== undefined) display.finish(target.id, file);
      }
      // The full snapshots stay in tool details. Bound the LSP feedback sent to the model.
      const lsp = {
        files: files.map((file) => ({
          ...file,
          diagnostics: file.diagnostics.slice(0, 3),
          ...(file.diagnostics.length > 3 ? { truncated: true } : {}),
        })),
        omittedFiles,
      };
      return {
        content: [
          ...event.content,
          { type: "text", text: JSON.stringify({ lsp }) },
        ],
        details: {
          ...applied.data,
          studioPatchDiagnostics: {
            files,
            toolCallIds: targets.map(({ id }) => id),
            omittedFiles: lsp.omittedFiles,
            contentIndex: event.content.length,
          },
        },
      };
    } catch {
      return {
        content: [
          ...event.content,
          { type: "text", text: "Patch applied. LSP feedback is unavailable." },
        ],
      };
    }
  });
}
