import { registerCodingRenderer } from "../model-tools/rendering.ts";
import type { StudioConfig } from "../config.ts";
import {
  displayEditReason,
  inlineDiagnosticLines,
  syntaxDiffRows,
} from "./diff.ts";
import { diffScope, type DiffScope } from "./scopes.ts";
import {
  syntaxReplacement,
  type SyntaxReplacement,
} from "./syntax-analysis.ts";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import {
  diagnosticRows,
  diagnosticSnapshot,
  type DiagnosticSnapshot,
} from "./diagnostics.ts";
import type { CodeIntelligence } from "./service.ts";

const detailsSchema = z.object({
  studioDiagnostics: z.object({
    contentIndex: z.number().int().nonnegative(),
    toolCallId: z.string().optional(),
    snapshot: diagnosticSnapshot,
  }),
});
// Older stored edits can carry only the language server's scope labels.
const editDetails = z.object({
  diff: z.string(),
  studioSyntax: z
    .object({
      scopes: z.array(diffScope).max(32),
      replacements: z.array(syntaxReplacement).max(2048),
    })
    .optional()
    .catch(undefined),
  studioDiffScopes: z.array(diffScope).max(32).optional().catch(undefined),
});
interface View {
  snapshot: DiagnosticSnapshot;
  settled: boolean;
  invalidate?: () => void;
}
export function registerDiagnosticRendering(
  pi: ExtensionAPI,
  intelligence: CodeIntelligence,
  diffDisplay: () => StudioConfig["display"],
) {
  const views = new Map<string, View>();
  const latest = new Map<string, string>();
  const diffs = new Map<
    string,
    {
      path: string;
      diff: string;
      scopes: DiffScope[];
      replacements: SyntaxReplacement[];
    }
  >();
  const clear = () => {
    views.clear();
    latest.clear();
    diffs.clear();
  };
  const restore = (_event: unknown, ctx: ExtensionContext) => {
    clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      const parsed = z
        .object({
          type: z.literal("custom_message"),
          customType: z.literal("studio:diagnostics"),
          details: z.object({
            toolCallId: z.string(),
            snapshot: diagnosticSnapshot,
          }),
        })
        .safeParse(entry);
      if (parsed.success)
        views.set(parsed.data.details.toolCallId, {
          snapshot: parsed.data.details.snapshot,
          settled: true,
        });
    }
  };
  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.on("session_shutdown", clear);
  intelligence.onDiagnostics((snapshot) => {
    const id = latest.get(snapshot.path);
    if (id === undefined) return;
    const view = views.get(id);
    if (
      view === undefined ||
      JSON.stringify(view.snapshot) === JSON.stringify(snapshot)
    )
      return;
    view.snapshot = snapshot;
    view.invalidate?.();
    if (view.settled)
      pi.sendMessage(
        {
          customType: "studio:diagnostics",
          content: JSON.stringify({ lsp: snapshot }),
          display: false,
          details: { toolCallId: id, snapshot },
        },
        { triggerTurn: false },
      );
  });
  registerCodingRenderer(pi, (name, next) => {
    const base = next();
    const render = base?.renderResult;
    if ((name !== "edit" && name !== "write") || render === undefined)
      return base;
    const renderCall = base?.renderCall;
    return {
      ...base,
      ...(name === "edit" && renderCall !== undefined
        ? {
            renderCall(args, theme, context) {
              const native = renderCall(args, theme, context);
              const edit = z.object({ reason: z.string() }).safeParse(args);
              const reason = edit.success
                ? displayEditReason(edit.data.reason)
                : "";
              return {
                invalidate() {
                  native.invalidate();
                },
                render(width) {
                  const value = diffs.get(context.toolCallId);
                  if (value === undefined) {
                    const nativeRows = native.render(width);
                    return reason.length > 0 && width > 0
                      ? [
                          ...nativeRows,
                          ...wrapTextWithAnsi(theme.fg("muted", reason), width),
                        ]
                      : nativeRows;
                  }
                  return syntaxDiffRows(
                    value.diff,
                    value.path,
                    theme,
                    width,
                    context.cwd,
                    undefined,
                    diffDisplay(),
                    views.get(context.toolCallId)?.snapshot.diagnostics,
                    {
                      scopes: value.scopes,
                      replacements: value.replacements,
                      reason,
                    },
                  );
                },
              };
            },
          }
        : {}),
      renderResult(result, options, theme, context) {
        const diff = editDetails.safeParse(result.details);
        const args = z.object({ path: z.string() }).safeParse(context.args);
        if (
          name === "edit" &&
          !context.isError &&
          !options.isPartial &&
          diff.success &&
          args.success
        ) {
          diffs.set(context.toolCallId, {
            path: args.data.path,
            diff: diff.data.diff,
            scopes:
              diff.data.studioSyntax?.scopes ??
              diff.data.studioDiffScopes ??
              [],
            replacements: diff.data.studioSyntax?.replacements ?? [],
          });
        }
        const parsed = detailsSchema.safeParse(result.details);
        if (!parsed.success || options.isPartial)
          return render(result, options, theme, context);
        const annotation = parsed.data.studioDiagnostics;
        let view = views.get(annotation.toolCallId ?? context.toolCallId);
        if (view === undefined) {
          view = { snapshot: annotation.snapshot, settled: true };
        }
        views.set(context.toolCallId, view);
        view.invalidate = context.invalidate;
        const current = view;
        const original = render(
          {
            ...result,
            content: result.content.filter(
              (_item, index) => index !== annotation.contentIndex,
            ),
          },
          options,
          theme,
          { ...context, lastComponent: undefined },
        );
        return {
          invalidate() {
            original.invalidate();
          },
          render(width) {
            const edit = diffs.get(context.toolCallId);
            const inlineLines =
              renderCall !== undefined &&
              edit !== undefined &&
              width >= 3 &&
              diffDisplay().inline_diagnostics
                ? inlineDiagnosticLines(edit.diff)
                : undefined;
            const diagnostics = diagnosticRows(
              current.snapshot,
              theme,
              width,
              options.expanded,
              inlineLines,
            );
            return [
              ...original.render(width),
              ...(diagnostics.length === 0 ? [] : ["", ...diagnostics]),
            ];
          },
        };
      },
    };
  });
  return {
    watch(id: string, path: string) {
      latest.set(path, id);
      views.set(id, {
        snapshot: { path, state: "pending", diagnostics: [] },
        settled: false,
      });
    },
    finish(id: string, snapshot: DiagnosticSnapshot) {
      const view = views.get(id);
      if (view !== undefined) {
        view.snapshot = snapshot;
        view.settled = true;
      }
    },
  };
}
