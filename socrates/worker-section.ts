import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { selectorText, type StatusTheme } from "@lanej/pi-components";
import type { WorkerAssignment } from "../tasks/workers.ts";

export interface WorkerSidebarView {
  rows: readonly WorkerAssignment[];
  collapsed: boolean;
  evidenceError?: string | undefined;
  focused?: boolean | undefined;
  selectedAttemptId?: string | undefined;
}

function inline(value: string): string {
  return selectorText(value).replace(/\s+/gu, " ").trim();
}

function workerHeading(
  view: WorkerSidebarView,
  theme: StatusTheme,
  width: number,
  expanded: boolean,
): string {
  const counts = { active: 0, waiting: 0, attention: 0, unknown: 0 };
  for (const row of view.rows) counts[row.activity]++;
  const parts = [];
  const attention = `${String(counts.attention)} ${counts.attention === 1 ? "needs" : "need"} you`;
  if (counts.active > 0) parts.push(`${String(counts.active)} active`);
  if (counts.unknown > 0) parts.push(`${String(counts.unknown)} unknown`);
  if (counts.waiting > 0) parts.push(`${String(counts.waiting)} waiting`);
  if (counts.attention > 0) parts.push(theme.warning(attention));
  const title = theme.bold(`${expanded ? "▾" : "▸"} Workers`);
  const tally = parts.join(theme.muted(" · "));
  const gap = width - visibleWidth(title) - visibleWidth(tally);
  if (gap < 1 && counts.attention > 0)
    return truncateToWidth(`${title} ${theme.warning(attention)}`, width, "…");
  const hint = view.focused === true ? "" : " Alt+W";
  const key = gap > hint.length ? theme.muted(hint) : "";
  return truncateToWidth(
    title + key + " ".repeat(Math.max(1, gap - visibleWidth(key))) + tally,
    width,
    "…",
  );
}

function assignmentLines(
  row: WorkerAssignment,
  theme: StatusTheme,
  width: number,
  selected: boolean,
): string[] {
  const attention = row.activity === "attention";
  const color = attention
    ? theme.warning
    : row.activity === "waiting" || row.activity === "unknown"
      ? theme.muted
      : theme.accent;
  const mark = attention
    ? "◆"
    : row.activity === "unknown"
      ? "?"
      : row.role === "Reviewer"
        ? "◈"
        : "●";
  const title = truncateToWidth(
    `${color(mark)} ${inline(row.title)}`,
    width,
    "…",
    selected,
  );
  const identity = `${row.role} · ${inline(row.attemptId).slice(0, 6)}`;
  const lines = [
    selected ? theme.selected(theme.bold(title)) : title,
    truncateToWidth(
      `  ${color(inline(row.phase))}  ${theme.muted(identity)}`,
      width,
      "…",
    ),
  ];
  if (row.question !== undefined) {
    const question = inline(row.question);
    if (question.length > 0) {
      const wrapped = wrapTextWithAnsi(question, Math.max(1, width - 2));
      lines.push(...wrapped.map((line) => `  ${line}`));
    }
  }
  return lines;
}

/** Keep the current assignment visible when a short viewport cannot hold the entire roster. */
export function renderWorkerCompact(
  view: WorkerSidebarView,
  theme: StatusTheme,
  width: number,
  height: number,
  expanded = false,
): string[] {
  if (width <= 0 || height <= 0) return [];
  const unavailable = view.evidenceError !== undefined;
  const warning = theme.warning("! Worker status unavailable");
  if (view.rows.length === 0 || (height === 1 && unavailable))
    return unavailable ? [truncateToWidth(warning, width, "…")] : [];
  const open = expanded && !view.collapsed;
  const lines = [workerHeading(view, theme, width, open)];
  if (unavailable) lines.push(truncateToWidth(warning, width, "…"));
  if (lines.length >= height) return lines;
  if (!open) {
    const question = view.rows.find(
      (row) => row.question !== undefined,
    )?.question;
    if (!expanded && question !== undefined)
      lines.push(truncateToWidth(inline(question), width, "…"));
    return lines;
  }
  const selected = view.rows.findIndex(
    (row) => row.attemptId === view.selectedAttemptId,
  );
  const cards = view.rows.map((row) =>
    assignmentLines(
      row,
      theme,
      width,
      row.attemptId === view.selectedAttemptId,
    ),
  );
  // A question gets its first line before a long question gets its second.
  const minimum = cards.map((card) => Math.min(card.length, 3));
  const room = height - lines.length;
  const clipped = minimum.reduce((sum, size) => sum + size, 0) > room;
  const overflowLine = clipped && room >= 4 ? 1 : 0;
  let first = Math.max(0, selected);
  let end = first + 1;
  let spare = Math.max(0, room - overflowLine - (minimum[first] ?? 0));
  while (first > 0 && (minimum[first - 1] ?? 0) <= spare) {
    first--;
    spare -= minimum[first] ?? 0;
  }
  while (end < cards.length && (minimum[end] ?? 0) <= spare) {
    spare -= minimum[end] ?? 0;
    end++;
  }
  for (let index = first; index < end; index++) {
    const card = cards[index];
    if (card === undefined) continue;
    const base = minimum[index] ?? 0;
    const extra = Math.min(spare, card.length - base);
    spare -= extra;
    const count = Math.min(room - overflowLine, base + extra);
    lines.push(...card.slice(0, count));
    if (card.length > count && count >= 3)
      lines[lines.length - 1] = truncateToWidth(
        card.slice(count - 1).join(" "),
        width,
        "…",
      );
  }
  if (lines.length < height) {
    const hidden = cards.length - end + first;
    if (hidden > 0)
      lines.push(
        truncateToWidth(
          theme.muted(
            `+${String(hidden)} more · ${view.focused === true ? "↑↓ select" : "Alt+W"}`,
          ),
          width,
          "…",
        ),
      );
    else if (view.focused === true) {
      const hint =
        view.rows[selected]?.focusable === true
          ? "Enter inspect · → pane · Esc back"
          : "Enter inspect · Space fold · Esc back";
      lines.push(truncateToWidth(theme.muted(hint), width, "…"));
    }
  }
  return lines;
}
