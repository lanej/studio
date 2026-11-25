import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { selectorText } from "@lanej/pi-components";
import { z } from "zod";
import {
  diagnosticSnapshot,
  type DiagnosticSnapshot,
} from "../code-intelligence/diagnostics.ts";
import { MAX_PATCH_BYTES, parseApplyPatch } from "./codex-patch-runner.mjs";

export function patchCallView(
  patch: string,
  complete: boolean,
  expanded: boolean,
  theme: Theme,
) {
  // Parse settled calls with the executor's grammar. Bound work on each streaming delta.
  let source = patch.slice(0, 4096);
  let paths: string[];
  try {
    if (complete && patch.length <= MAX_PATCH_BYTES) {
      const hunks = parseApplyPatch(patch);
      paths = hunks.map(({ path, moveTo }) =>
        moveTo === undefined ? path : `${path} → ${moveTo}`,
      );
      source = patch;
    } else {
      paths = [];
    }
  } catch {
    paths = [];
  }
  if (paths.length === 0) {
    paths = Array.from(
      source.matchAll(/^\*\*\* (?:Add|Update|Delete) File: ([^\r\n]+)/gmu),
      (match) => match[1] ?? "",
    );
  }
  const files = [...new Set(paths)];
  const first = files
    .slice(0, 3)
    .map((path) => truncateToWidth(selectorText(path), 64));
  if (files.length > first.length)
    first.push(`+${String(files.length - first.length)} more`);
  const title = theme.fg("toolTitle", theme.bold("apply_patch"));
  const header = [title, ...first.map((path) => theme.fg("accent", path))].join(
    "  ",
  );
  if (!expanded) return new Text(header, 0, 0);

  const body = selectorText(source.replaceAll("\r\n", "\n"))
    .split("\n")
    .map((line) => {
      if (line.startsWith("+")) return theme.fg("toolDiffAdded", line);
      if (line.startsWith("-")) return theme.fg("toolDiffRemoved", line);
      if (line.startsWith("***") || line.startsWith("@@"))
        return theme.fg("muted", line);
      return theme.fg("toolDiffContext", line);
    });
  if (source.length < patch.length) body.push(theme.fg("muted", "…"));
  return new Text([header, ...body].join("\n"), 0, 0);
}

const patchFeedback = z.object({
  studioPatchDiagnostics: z.object({
    contentIndex: z.number().int().nonnegative(),
    files: z.array(diagnosticSnapshot),
    omittedFiles: z.number().int().nonnegative(),
  }),
});

function diagnosticStatus(file: DiagnosticSnapshot): string {
  if (file.state === "pending") return "pending";
  if (file.state === "unavailable") {
    if (file.message?.includes("requires explicit project trust") === true)
      return "project trust required (/lsp-trust)";
    return file.message === undefined
      ? "unavailable"
      : `unavailable · ${selectorText(file.message)}`;
  }
  const count = file.total ?? file.diagnostics.length;
  return `${String(count)} diagnostic${count === 1 ? "" : "s"} reported${file.freshness === "unversioned" ? " (unversioned)" : ""}`;
}

export function patchResultView(
  result: AgentToolResult<unknown>,
  isError: boolean,
  expanded: boolean,
  hint: string,
  theme: Theme,
) {
  const receipt = patchFeedback.safeParse(result.details);
  const lsp =
    !isError && receipt.success
      ? receipt.data.studioPatchDiagnostics
      : undefined;
  const lines = result.content.flatMap((item, i) => {
    if (item.type !== "text") return [];
    // Leave the model's feedback untouched. Replace only the block the diagnostics hook owns in this view.
    if (
      lsp !== undefined &&
      i === lsp.contentIndex &&
      item.text.startsWith('{"lsp":')
    ) {
      const rows = lsp.files.flatMap((file) => [
        `${theme.fg("muted", "LSP")}  ${theme.fg("accent", selectorText(file.path))}  ${diagnosticStatus(file)}`,
        ...(expanded
          ? file.diagnostics.map((issue) =>
              theme.fg(
                issue.severity === "error" ? "error" : "warning",
                `  ${String(issue.line)}:${String(issue.column)}  ${selectorText(issue.message)}`,
              ),
            )
          : []),
      ]);
      if (lsp.omittedFiles > 0)
        rows.push(
          theme.fg(
            "muted",
            `${String(lsp.omittedFiles)} more files without feedback`,
          ),
        );
      return rows;
    }
    return selectorText(item.text)
      .split("\n")
      .map((line) => theme.fg(isError ? "error" : "toolOutput", line));
  });
  if (!expanded && lines.length > 10)
    lines.splice(
      10,
      Infinity,
      theme.fg("muted", `… ${String(lines.length - 10)} more lines · ${hint}`),
    );
  return new Text(lines.join("\n"), 0, 0);
}
