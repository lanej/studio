import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { DiagnosticSnapshot } from "../code-intelligence/diagnostics.ts";
import {
  type CodeIntelligence,
  serverForPath,
} from "../code-intelligence/service.ts";
import { parseApplyPatch } from "./codex-patch-runner.mjs";

const fileLimit = 3;
const receipt = z.looseObject({
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

export function registerPatchDiagnostics(
  pi: ExtensionAPI,
  intelligence: CodeIntelligence,
  requireTrust: (ctx: ExtensionContext) => Promise<void>,
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
      const files = await intelligence.serial(async () => {
        try {
          await requireTrust(ctx);
        } catch (error) {
          return selected.map((path) => unavailable(path, error));
        }
        const snapshots: DiagnosticSnapshot[] = [];
        for (const path of selected) {
          try {
            snapshots.push(await intelligence.diagnostics(ctx.cwd, path));
          } catch (error) {
            snapshots.push(unavailable(path, error));
          }
        }
        return snapshots;
      });
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
