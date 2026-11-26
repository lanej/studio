import { getLanguageFromPath, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { defaultMinSplitColumns, type StudioConfig } from "../config.ts";
import { diagnosticGlyph, type DiagnosticSnapshot } from "./diagnostics.ts";
import type { DiffScope } from "./scopes.ts";
import type { SyntaxReplacement } from "./syntax-analysis.ts";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  colorToRgb,
  getCapabilities,
  hyperlink,
  mixColors,
  parseColor,
  rgbColor,
  type Color,
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const clean = (text: string) => text.replaceAll("\t", "   ").replace(/\p{Cc}/gu, " ");

export function displayEditReason(reason: string): string {
  return clean(stripTerminalSequences(reason)).trim();
}

type Highlighter = (text: string, language: string) => string[];
type HeadingTheme = Pick<Theme, "fg" | "bold" | "style" | "appearance"> & {
  colors: Pick<Theme["colors"], "toolSuccessBg">;
};
type DiffTheme = HeadingTheme &
  Pick<Theme, "bg" | "name"> & {
    colors: Pick<Theme["colors"], "toolDiffAdded" | "toolDiffRemoved">;
  };

export function editFileHeading(
  theme: HeadingTheme,
  toolName: string,
  pathLabel: string,
  reason = "",
  addedFile = false,
): string {
  const name = toolName === "" ? "" : `${theme.fg("toolTitle", theme.bold(toolName))} `;
  const glyph = addedFile ? `${theme.fg("toolDiffAdded", "+")} ` : "";
  const inlay = displayEditReason(reason);
  return name + glyph + pathLabel + (inlay === "" ? "" : inlayText(theme, `  · ${inlay}`));
}

const white = rgbColor(255, 255, 255);
const studioWordColors = {
  toolDiffRemoved: { ink: parseColor("#bf616a"), tint: parseColor("#47343f") },
  toolDiffAdded: { ink: parseColor("#a3be8c"), tint: parseColor("#304639") },
};

function luminance(color: Color) {
  const { r, g, b } = colorToRgb(color);
  const linear = (channel: number) => {
    const v = channel / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(a: Color, b: Color) {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function readableInk(background: Color, preferred: Color, minimumContrast = 4.5) {
  if (contrast(background, preferred) >= minimumContrast) return preferred;
  return luminance(background) > 0.179 ? rgbColor(0, 0, 0) : white;
}

export function inlayText(theme: HeadingTheme, text: string) {
  const gray = theme.appearance === "dark" ? 177 : 85;
  const fg = readableInk(theme.colors.toolSuccessBg, rgbColor(gray, gray, gray));
  return theme.style(text, { fg });
}

interface DiffLine {
  raw: string;
  prefix: string | undefined;
  number: string;
  beforeNumber: string;
  afterNumber: string;
  code: string;
  rawCode: string;
  before: string | undefined;
  after: string | undefined;
}

export function parseDiffLines(diff: string): DiffLine[] {
  const lines: DiffLine[] = diff.split("\n").map((line) => {
    const match = /^([+\- ])(\s*\d+) (.*)$/u.exec(line);
    return {
      raw: line,
      prefix: match?.[1],
      number: match?.[2]?.trim() ?? "",
      beforeNumber: "",
      afterNumber: "",
      code: clean(match?.[3] ?? ""),
      rawCode: match?.[3] ?? "",
      before: undefined,
      after: undefined,
    };
  });
  let delta = 0;
  for (const line of lines) {
    line.beforeNumber = line.prefix === "+" ? "" : line.number;
    line.afterNumber =
      line.prefix === " " ? String(Number(line.number) + delta) : line.prefix === "+" ? line.number : "";
    if (line.prefix === "+") delta++;
    else if (line.prefix === "-") delta--;
  }
  return lines;
}

interface ChangedToken {
  start: number;
  original: string;
  updated: string;
}

// Match saved Tree-sitter ranges against both file images before painting any token.
function changedTokens(lines: DiffLine[], replacements: readonly SyntaxReplacement[] = []) {
  const tokens = new Map<DiffLine, ChangedToken>();
  if (replacements.length === 0) return tokens;
  const byRow = new Map(replacements.map((change) => [change.row, change]));
  const removed = new Map<string, DiffLine>();
  for (const [index, line] of lines.entries()) {
    if (line.prefix === "-") {
      removed.set(line.number, line);
      continue;
    }
    if (line.prefix !== "+") {
      removed.clear();
      continue;
    }
    const old = removed.get(line.number);
    const change = byRow.get(index);
    if (!old || !change || !line.rawCode.startsWith(change.updated, change.start)) continue;
    const prefix = line.rawCode.slice(0, change.start);
    const suffix = line.rawCode.slice(change.start + change.updated.length);
    if (old.rawCode !== prefix + change.original + suffix) continue;
    const token = {
      start: visibleWidth(clean(prefix)),
      original: clean(change.original),
      updated: clean(change.updated),
    };
    tokens.set(old, token);
    tokens.set(line, token);
    removed.delete(line.number);
  }
  return tokens;
}

export function inlineDiagnosticLines(diff: string): ReadonlySet<number> {
  return new Set(parseDiffLines(diff).flatMap(({ afterNumber }) => (afterNumber === "" ? [] : [Number(afterNumber)])));
}

type Issue = DiagnosticSnapshot["diagnostics"][number];

function undercurl(row: string, line: DiffLine, issues: Issue[], offset: number): string {
  const edges = new Map<number, number>();
  const rowWidth = visibleWidth(row);
  const lineNumber = Number(line.afterNumber);
  for (const issue of issues) {
    if (issue.endColumn === undefined || issue.endLine === undefined) continue;
    const start = issue.line === lineNumber ? visibleWidth(clean(line.rawCode.slice(0, issue.column - 1))) : 0;
    const end =
      issue.endLine === lineNumber
        ? visibleWidth(clean(line.rawCode.slice(0, issue.endColumn - 1)))
        : visibleWidth(line.code);
    const from = Math.max(0, start - offset);
    const to = Math.min(rowWidth, end - offset);
    if (from >= to) continue;
    edges.set(from, (edges.get(from) ?? 0) + 1);
    edges.set(to, (edges.get(to) ?? 0) - 1);
  }
  if (edges.size === 0) return row;
  let position = 0;
  let depth = 0;
  let result = "";
  for (const [edge, change] of [...edges].sort(([a], [b]) => a - b)) {
    const span = sliceByColumn(row, position, edge - position);
    result += depth > 0 ? `\x1b[4:3m${span.replaceAll("\x1b[0m", "\x1b[0m\x1b[4:3m")}\x1b[24m` : span;
    depth += change;
    position = edge;
  }
  return `${result}${sliceByColumn(row, position, rowWidth - position)}\x1b[39m`;
}

export function syntaxDiffRows(
  diff: string,
  path: string,
  theme: DiffTheme,
  width: number,
  cwd: string,
  highlight: Highlighter = highlightCode,
  display: StudioConfig["display"] = {
    min_split_columns: defaultMinSplitColumns,
    inline_diagnostics: true,
  },
  diagnostics: DiagnosticSnapshot["diagnostics"] = [],
  details: {
    reason?: string;
    addedFile?: boolean | undefined;
    displayToolName?: string | undefined;
    scopes?: readonly DiffScope[];
    replacements?: readonly SyntaxReplacement[];
  } = {},
): string[] {
  if (width < 3) return [];
  const lines = parseDiffLines(diff);
  const language = getLanguageFromPath(path);
  const paint = (added: boolean) => {
    const source = lines.filter((line) => line.prefix !== (added ? "-" : "+")).map((line) => line.code);
    return language === undefined || Buffer.byteLength(diff) > 64 * 1024
      ? source
      : highlight(source.join("\n"), language);
  };
  const old = paint(false),
    updated = paint(true);
  let before = 0,
    after = 0;
  for (const line of lines) {
    line.before = line.prefix === "+" ? undefined : old[before++];
    line.after = line.prefix === "-" ? undefined : updated[after++];
  }
  const issuesByLine = new Map<string, Issue[]>();
  const activeIssues = display.inline_diagnostics ? diagnostics : [];
  for (const issue of activeIssues) {
    const number = String(issue.line);
    const issues = issuesByLine.get(number);
    if (!issues) issuesByLine.set(number, [issue]);
    else issues.push(issue);
  }
  const inner = Math.max(1, width - 2);
  const digits = lines.reduce((digits, line) => Math.max(digits, line.beforeNumber.length, line.afterNumber.length), 1);
  const leftWidth = Math.floor((inner - 3) / 2);
  const rightWidth = inner - 3 - leftWidth;
  const gutter = digits + 2;
  const hasAdditions = lines.some((line) => line.prefix === "+");
  const hasDeletions = lines.some((line) => line.prefix === "-");
  const split = hasAdditions && hasDeletions && leftWidth - gutter >= display.min_split_columns;
  const pad = (text: string, columns: number) => text + " ".repeat(Math.max(0, columns - visibleWidth(text)));
  const toolBackground = theme.bg("toolSuccessBg", "").replace("\x1b[49m", "");
  const restoreBackground = toolBackground === "" ? "\x1b[49m" : toolBackground;
  const background = (line: DiffLine, row: string): string => {
    const color =
      line.prefix === "+" ? display.added_background : line.prefix === "-" ? display.removed_background : undefined;
    if (color === undefined) return row.replaceAll("\x1b[49m", restoreBackground);
    const rgb = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
    const start = `\x1b[48;2;${rgb.join(";")}m`;
    return start + row.replaceAll("\x1b[0m", `\x1b[0m${start}`).replaceAll("\x1b[49m", start) + restoreBackground;
  };
  const lineLabel = (mark: string, number: string) => {
    const tone = mark === "+" ? "toolDiffAdded" : mark === "-" ? "toolDiffRemoved" : "warning";
    return (
      (mark === " " ? " " : theme.fg(tone, theme.bold(mark))) +
      theme.fg("toolDiffContext", `${number.padStart(digits)} `)
    );
  };
  const tokens = changedTokens(lines, details.replacements);
  const token = (text: string, tone: "toolDiffAdded" | "toolDiffRemoved") => {
    const { ink: studioInk, tint } = studioWordColors[tone];
    const ink = theme.name === "dotfiles" && theme.appearance === "dark" ? studioInk : theme.colors[tone];
    const surface = theme.colors.toolSuccessBg;
    const override = tone === "toolDiffRemoved" ? display.removed_background : display.added_background;
    const bg =
      override !== undefined
        ? parseColor(override)
        : theme.appearance === "dark"
          ? tint
          : mixColors(surface, ink, 0.12, "srgb");
    // Preserve the original diff ink whenever it is as legible as on the tool surface.
    const minimumContrast = Math.min(4.5, contrast(ink, surface));
    return theme.style(text, { bg, fg: readableInk(bg, ink, minimumContrast) });
  };
  const markedCode = (line: DiffLine, compact: boolean) => {
    const removed = line.prefix === "-";
    const code = (removed ? line.before : line.after) ?? line.code;
    const change = tokens.get(line);
    if (!change) return code;
    const text = removed ? change.original : change.updated;
    const fill = compact
      ? token(change.original, "toolDiffRemoved") + theme.fg("dim", " → ") + token(change.updated, "toolDiffAdded")
      : token(text, removed ? "toolDiffRemoved" : "toolDiffAdded");
    // Restore the file card after the token, or let the configured row tint take over.
    const painted = compact ? fill.replaceAll("\x1b[49m", restoreBackground) : fill;
    return (
      sliceByColumn(code, 0, change.start) +
      painted +
      sliceByColumn(code, change.start + visibleWidth(text), Number.POSITIVE_INFINITY)
    );
  };
  const cell = (line: DiffLine | undefined, side: "before" | "after", columns: number): string[] => {
    if (!line) return [" ".repeat(columns)];
    if (line.prefix === undefined)
      return wrapTextWithAnsi(theme.fg("toolDiffContext", clean(line.raw)), columns).map((row) => pad(row, columns));
    const code = tokens.has(line)
      ? markedCode(line, false)
      : ((side === "before" ? line.before : line.after) ?? line.code);
    const number = side === "before" ? line.beforeNumber : line.afterNumber;
    const issues = side === "after" ? (issuesByLine.get(number) ?? []) : [];
    const ranges =
      side === "after"
        ? activeIssues.filter(
            (issue) => issue.line <= Number(number) && (issue.endLine ?? issue.line) >= Number(number),
          )
        : [];
    const label = lineLabel(details.addedFile === true ? " " : line.prefix, number);
    const indent = columns > gutter ? " ".repeat(gutter) : "";
    let cursor = 0;
    const sourceRows =
      columns <= gutter
        ? wrapTextWithAnsi(label + code, columns)
        : wrapTextWithAnsi(code, columns - gutter).map((row, index) => {
            const plain = stripTerminalSequences(row);
            const start = line.code.indexOf(plain, cursor);
            if (start >= 0) cursor = start + plain.length;
            const marked = start < 0 ? row : undercurl(row, line, ranges, visibleWidth(line.code.slice(0, start)));
            return (index === 0 ? label : indent) + marked;
          });
    const inlayRows: string[] = [];
    for (const issue of issues) {
      const inlay = `${theme.fg(issue.severity, diagnosticGlyph(issue.severity))} ${inlayText(theme, clean(issue.message))}`;
      const last = sourceRows.at(-1);
      if (last !== undefined && inlayRows.length === 0 && visibleWidth(last) + 2 + visibleWidth(inlay) <= columns)
        sourceRows[sourceRows.length - 1] = `${last}  ${inlay}`;
      else inlayRows.push(...wrapTextWithAnsi(inlay, columns - indent.length).map((row) => indent + row));
    }
    return [
      ...sourceRows.map((row) => background(line, pad(row, columns))),
      ...inlayRows.map((row) => pad(row, columns)),
    ];
  };
  const paired = (left: DiffLine | undefined, right: DiffLine | undefined): string[] => {
    const oldRows = cell(left, "before", leftWidth),
      newRows = cell(right, "after", rightWidth);
    return Array.from(
      { length: Math.max(oldRows.length, newRows.length) },
      (_unused, row) =>
        (oldRows[row] ?? " ".repeat(leftWidth)) + theme.fg("dim", " │ ") + (newRows[row] ?? " ".repeat(rightWidth)),
    );
  };
  const compact =
    tokens.size > 0 &&
    lines.every((line) => {
      if (line.prefix !== "+" && line.prefix !== "-") return true;
      const change = tokens.get(line);
      if (!change) return false;
      if (line.prefix === "-") return true;
      const number = Number(line.afterNumber);
      return (
        gutter + visibleWidth(line.code) + visibleWidth(change.original) + 3 <= inner &&
        !activeIssues.some((issue) => issue.line <= number && (issue.endLine ?? issue.line) >= number)
      );
    });
  const body: string[] = [];
  const scopes = new Map(details.scopes?.map(({ row, label }) => [row, label]));
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line) break;
    const scope = scopes.get(index);
    // The scope identifies the upcoming hunk in the row normally used for Pi's omission marker.
    if (line.raw.trim() === "..." && scopes.has(index + 1)) {
      index++;
      continue;
    }
    if (scope !== undefined)
      body.push(truncateToWidth(theme.fg("dim", "╭ ") + theme.fg("accent", clean(scope)), inner));
    if (compact) {
      if (line.prefix === "+") body.push(lineLabel("~", line.number) + markedCode(line, true));
      else if (line.prefix !== "-") body.push(...cell(line, "after", inner));
    } else if (!split) {
      body.push(...cell(line, line.prefix === "-" ? "before" : "after", inner));
    } else if (line.prefix === "-" || line.prefix === "+") {
      const removed: DiffLine[] = [],
        added: DiffLine[] = [];
      while (lines[index]?.prefix === "-") {
        const value = lines[index++];
        if (value) removed.push(value);
      }
      while (lines[index]?.prefix === "+") {
        const value = lines[index++];
        if (value) added.push(value);
      }
      for (let row = 0; row < Math.max(removed.length, added.length); row++)
        body.push(...paired(removed[row], added[row]));
      continue;
    } else {
      body.push(...paired(line, line));
    }
    index++;
  }
  const rawPath = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(cwd, path);
  const label = theme.fg("accent", clean(path));
  const pathLabel = getCapabilities().hyperlinks ? hyperlink(label, pathToFileURL(rawPath).href) : label;
  const header = editFileHeading(
    theme,
    details.displayToolName ?? "edit",
    pathLabel,
    details.reason,
    details.addedFile,
  );
  return [...(details.displayToolName === "" ? [] : [""]), ...wrapTextWithAnsi(header, inner), ...body, ""].map(
    (line) => theme.bg("toolSuccessBg", ` ${line}${" ".repeat(Math.max(0, width - 1 - visibleWidth(line)))}`),
  );
}
