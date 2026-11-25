import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { selectorText } from "@lanej/pi-components";
import { resolve } from "node:path";
import { z } from "zod";
import {
  diagnosticRows,
  diagnosticSnapshot,
  type DiagnosticSnapshot,
} from "../code-intelligence/diagnostics.ts";
import { editFileHeading } from "../code-intelligence/diff.ts";
import { patchSuccess } from "./codex-patch-runner.mjs";
import { patchEditCallId } from "./patch-diagnostics.ts";
import { patchEdits } from "./patch-edits.ts";

type RenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];

const patchArgs = z.object({ patch: z.string() });
type AppliedFile = z.infer<typeof patchEdits>[number];

const applied = z.object({
  studioPatchApplied: z.literal(true),
  studioPatchEdits: patchEdits,
});
const feedback = z.object({
  studioPatchDiagnostics: z.object({
    contentIndex: z.number().int().nonnegative(),
    files: z.array(diagnosticSnapshot),
    toolCallIds: z.array(z.string()).optional(),
    omittedFiles: z.number().int().nonnegative(),
  }),
});

// While arguments are arriving, only show context supplied in the call. Absolute
// line numbers and enclosing scopes come from the executor's saved file images.
function preview(
  raw: unknown,
  theme: Theme,
  context: RenderContext,
  toolName: string,
) {
  const args = patchArgs.safeParse(raw);
  const patch = args.success ? args.data.patch : "";
  const limit = context.argsComplete && context.expanded ? 65536 : 4096;
  const source = selectorText(patch.slice(0, limit).replaceAll("\r\n", "\n"));
  const sourceLines = source.split("\n");
  const lines: string[] = [];
  let fileCount = 0;
  let addedFile = false;
  for (const [i, line] of sourceLines.entries()) {
    const file = /^\*\*\* (Add|Delete|Update) File: (.+)/u.exec(line);
    if (file !== null) {
      fileCount++;
      addedFile = file[1] === "Add";
      const intent = /^\*\*\* Reason: (.*)$/u.exec(
        sourceLines[i + 1] ?? "",
      )?.[1];
      const note = [intent, file[1] === "Delete" ? "Delete file" : ""]
        .filter(Boolean)
        .join(" · ");
      lines.push(
        editFileHeading(
          theme,
          "",
          theme.fg("accent", file[2] ?? ""),
          note,
          addedFile,
        ),
      );
    } else if (fileCount > 0 && line.startsWith("*** Move to: ")) {
      lines.push(
        theme.fg("muted", `Move to ${line.slice("*** Move to: ".length)}`),
      );
    } else if (fileCount > 0 && !context.isError) {
      if (line.startsWith("@@ "))
        lines.push(theme.fg("accent", `╭ ${line.slice(3)}`));
      if (line.startsWith("+"))
        lines.push(addedFile ? line.slice(1) : theme.fg("toolDiffAdded", line));
      if (line.startsWith("-")) lines.push(theme.fg("toolDiffRemoved", line));
      if (line.startsWith(" ")) lines.push(theme.fg("toolDiffContext", line));
    }
  }
  const title = theme.fg("toolTitle", theme.bold(toolName));
  if (fileCount === 1) lines[0] = `${title} ${lines[0] ?? ""}`;
  else lines.unshift(title);
  const folded = !context.expanded && lines.length > 10;
  if (folded) lines.splice(10);
  if (patch.length > limit || folded) lines.push(theme.fg("muted", "…"));
  const bg = context.isError
    ? "toolErrorBg"
    : context.isPartial
      ? "toolPendingBg"
      : "toolSuccessBg";
  const box = new Box(context.outputPad, 1, (row) => theme.bg(bg, row));
  box.addChild(new Text(lines.join("\n"), 0, 0));
  return box;
}

function fileStatus(file: AppliedFile) {
  if (file.moveTo !== undefined) {
    const moved = `Moved from ${selectorText(file.path)}`;
    return file.overwrote === true
      ? `${moved} · replaced existing destination`
      : moved;
  }
  if (file.kind === "added" && file.overwrote === true) return "Replaced file";
  if (file.kind === "deleted") return "Deleted file";
  return "";
}

// Consume just the executor's ordinary success text. A hook can replace or
// append output; the operator should still see that output.
function appliedSummary(files: AppliedFile[]) {
  const markers = { added: "A", updated: "M", deleted: "D" };
  return [
    patchSuccess,
    ...files.map(
      (file) =>
        markers[file.kind] +
        " " +
        file.path +
        (file.moveTo === undefined ? "" : ` -> ${file.moveTo}`),
    ),
  ].join("\n");
}

function diagnosticComponent(
  file: DiagnosticSnapshot,
  theme: Theme,
  expanded: boolean,
) {
  return {
    invalidate() {},
    render(width: number) {
      return diagnosticRows(file, theme, width, expanded);
    },
  };
}

// Keep one invocation heading while each file owns its diff and diagnostic state.
export function patchEditRenderers(
  edit: ToolRenderers,
  toolName: string,
): ToolRenderers {
  const call = edit.renderCall;
  const result = edit.renderResult;
  if (call === undefined || result === undefined)
    throw new Error("Patch display requires the edit tool renderer.");
  return {
    renderShell: "self",
    renderCall(args, theme, context) {
      return context.isPartial
        ? preview(args, theme, context, toolName)
        : new Container();
    },
    renderResult(outcome, options, theme, context) {
      const body = new Container();
      const receipt = applied.safeParse(outcome.details);
      const files =
        receipt.success && !context.isError && !options.isPartial
          ? receipt.data.studioPatchEdits
          : [];
      const parsed = feedback.safeParse(outcome.details);
      const diagnostics =
        !context.isError && parsed.success
          ? parsed.data.studioPatchDiagnostics
          : undefined;
      const lastEdit = new Map(
        files.map((file, i) => [
          resolve(context.cwd, file.moveTo ?? file.path),
          i,
        ]),
      );
      const remaining = new Map(
        diagnostics?.files.map((snapshot, i) => {
          const toolCallId = diagnostics.toolCallIds?.[i];
          const editIndex = lastEdit.get(resolve(context.cwd, snapshot.path));
          const id =
            toolCallId ??
            (editIndex === undefined
              ? snapshot.path
              : patchEditCallId(context.toolCallId, editIndex));
          return [id, { snapshot, toolCallId: id }];
        }),
      );
      const visible = options.expanded ? files : files.slice(0, 3);
      if (files.length === 0 && !options.isPartial)
        body.addChild(preview(context.args, theme, context, toolName));
      const batch = files.length > 1;
      if (batch) {
        const count = lastEdit.size;
        const header = new Box(context.outputPad, 1, (row) =>
          theme.bg("toolSuccessBg", row),
        );
        const title = theme.fg("toolTitle", theme.bold(toolName));
        const countLabel = theme.fg(
          "muted",
          `${String(count)} ${count === 1 ? "file" : "files"}`,
        );
        header.addChild(new Text(`${title}  ${countLabel}`, 0, 0));
        body.addChild(header);
      }
      for (const [i, file] of visible.entries()) {
        const path = file.moveTo ?? file.path;
        const addedFile = file.kind === "added" && file.overwrote !== true;
        const reason = [file.reason, fileStatus(file)]
          .filter(Boolean)
          .join(" · ");
        const args = { path: selectorText(path), reason, addedFile };
        const id = patchEditCallId(context.toolCallId, i);
        const annotation = remaining.get(id);
        remaining.delete(id);
        const child = {
          ...context,
          args,
          toolCallId: id,
          displayToolName: batch ? "" : toolName,
          lastComponent: undefined,
          state: {},
        };
        const hasDiff = file.diff !== undefined && file.diff !== "";
        if (hasDiff) {
          body.addChild(call(args, theme, child));
        } else {
          const box = new Box(context.outputPad, 0, (row) =>
            theme.bg("toolSuccessBg", row),
          );
          if (!batch) box.addChild(new Spacer());
          box.addChild(
            new Text(
              editFileHeading(
                theme,
                child.displayToolName,
                theme.fg("accent", args.path),
                reason,
                addedFile,
              ),
              0,
              0,
            ),
          );
          if (file.diff === undefined)
            box.addChild(new Text(theme.fg("muted", "Diff unavailable"), 0, 0));
          box.addChild(new Spacer());
          body.addChild(box);
        }
        body.addChild(
          result(
            {
              content: [],
              details: {
                ...(hasDiff ? file : {}),
                ...(annotation === undefined
                  ? {}
                  : {
                      studioDiagnostics: { ...annotation, contentIndex: 0 },
                    }),
              },
            },
            options,
            theme,
            child,
          ),
        );
      }
      const hidden = files.length - visible.length;
      if (hidden > 0)
        body.addChild(
          new Text(
            theme.fg(
              "muted",
              `… ${String(hidden)} more ${hidden === 1 ? "file" : "files"} · ${context.keyHint("app.tools.expand", "to expand")}`,
            ),
            context.outputPad,
            0,
          ),
        );
      const summary = files.length > 0 ? appliedSummary(files) : undefined;
      for (const [i, item] of outcome.content.entries()) {
        if (item.type !== "text") continue;
        if (diagnostics?.contentIndex === i && item.text.startsWith('{"lsp":'))
          continue;
        const text = selectorText(item.text).trimEnd();
        if (text === "" || text === summary) continue;
        body.addChild(
          new Text(
            theme.fg(context.isError ? "error" : "toolOutput", text),
            context.outputPad,
            0,
          ),
        );
      }
      for (const { snapshot } of remaining.values()) {
        body.addChild(
          new Text(
            theme.fg("accent", selectorText(snapshot.path)),
            context.outputPad,
            0,
          ),
        );
        body.addChild(diagnosticComponent(snapshot, theme, options.expanded));
      }
      if (diagnostics !== undefined && diagnostics.omittedFiles > 0)
        body.addChild(
          new Text(
            theme.fg(
              "muted",
              `${String(diagnostics.omittedFiles)} more files without feedback`,
            ),
            context.outputPad,
            0,
          ),
        );
      return body;
    },
  };
}
