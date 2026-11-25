import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  renderStatusCounts,
  renderStatusMark,
  selectorText,
  type StatusColumn,
  type StatusGroup,
  type StatusItem,
  type StatusTheme,
} from "@lanej/pi-components";
import { planGraph, renderGraphPrefix } from "../plan-graph.ts";
import { taskMarks } from "./columns.ts";
import {
  ImplementationState,
  type ImplementationPresentation,
} from "./implementation.ts";

type GraphTheme = StatusTheme & {
  lane: (lane: number, text: string) => string;
};

interface SidebarGraph {
  lines: string[];
  nodeLines: number[];
}

/** The graph and the inspector use the same rails; live status belongs to its node. */
export function renderSidebarGraph(
  implementation: ImplementationPresentation,
  theme: GraphTheme,
  width: number,
): SidebarGraph {
  const lines: string[] = [];
  const nodeLines: number[] = [];
  const tasks = implementation.rows.map((task) => ({ ...task, key: task.id }));
  for (const row of planGraph(tasks)) {
    const mark = taskMarks[row.task.state];
    const prefix = renderGraphPrefix(
      row.prefix,
      theme.lane,
      theme[mark.tone](mark.glyph),
    );
    const title = inline(row.task.label);
    const subject = `${prefix}  ${title}`;
    const state = theme[mark.tone](mark.label);
    // In a dense graph keep enough of the title to recognize the task.
    const titleSpace = width - visibleWidth(prefix) - visibleWidth(state) - 3;
    const showState =
      row.task.state !== ImplementationState.Proposed &&
      titleSpace >= Math.min(8, visibleWidth(title));
    nodeLines.push(lines.length);
    lines.push(
      showState
        ? align(subject, state, width)
        : truncateToWidth(subject, width, "…"),
    );
    for (const connector of row.connectors)
      lines.push(renderGraphPrefix(connector, theme.lane));
  }
  return { lines, nodeLines };
}

/** End a clipped preview on a task; a dangling join could imply a different dependency. */
export function fitSidebarGraph(
  graph: SidebarGraph,
  height: number,
  theme: StatusTheme,
): string[] {
  if (height < 1) return [];
  if (graph.lines.length <= height) return graph.lines;
  if (height === 1) return graph.lines.slice(0, 1);
  const shown = graph.nodeLines.filter((line) => line < height - 1);
  const end = shown.at(-1);
  return [
    ...graph.lines.slice(0, end === undefined ? 0 : end + 1),
    theme.muted(
      `+${String(graph.nodeLines.length - shown.length)} more · /plan`,
    ),
  ];
}

function inline(text: string): string {
  return selectorText(text).replace(/\s+/gu, " ").trim();
}

/** Keep a lifecycle or row state readable even when the subject is long. */
function align(left: string, right: string, width: number): string {
  const subject = truncateToWidth(
    left,
    Math.max(1, width - visibleWidth(right) - 1),
    "…",
  );
  return (
    subject +
    " ".repeat(
      Math.max(1, width - visibleWidth(subject) - visibleWidth(right)),
    ) +
    right
  );
}

function excerpt(text: string, width: number): string[] {
  const lines = wrapTextWithAnsi(inline(text), width);
  const first = lines[0];
  if (first === undefined || first.length === 0) return [];
  return [
    first,
    ...(lines.length < 2
      ? []
      : [truncateToWidth(lines.slice(1).join(" "), width, "…")]),
  ];
}

function itemLines(
  item: StatusItem,
  group: StatusGroup,
  column: StatusColumn,
  theme: StatusTheme,
  width: number,
): string[] {
  const { status } = item;
  const glyph = theme[status.tone](inline(status.glyph));
  const subject = `${glyph} ${inline(item.label)}`;
  const state =
    group.showStatusLabels === false
      ? ""
      : theme[status.tone](inline(status.label));
  const suffix =
    item.id === column.focusId ? `${theme.accent("◆")} ${state}` : state;
  if (suffix.length === 0) return [truncateToWidth(subject, width, "…")];
  if (visibleWidth(subject) + visibleWidth(suffix) + 1 <= width)
    return [align(subject, suffix, width)];
  const reference = inline(item.summary ?? "");
  const detail =
    reference.length > 0 ? `${suffix} · ${theme.muted(reference)}` : suffix;
  return [truncateToWidth(subject, width, "…"), `  ${detail}`];
}

interface RailSection {
  heading: string[];
  summary: string[];
  rows: string[];
  counts: string[];
  evidence: { after: number; lines: string[] } | undefined;
  graph?: SidebarGraph;
}

function section(
  column: StatusColumn,
  theme: GraphTheme,
  width: number,
  implementation: ImplementationPresentation,
): RailSection {
  const title = theme.bold(inline(column.title));
  const phase =
    column.status === undefined ? "" : renderStatusMark(column.status, theme);
  const heading =
    phase.length === 0
      ? [title]
      : visibleWidth(title) + visibleWidth(phase) + 2 <= width
        ? [align(title, phase, width)]
        : [title, phase];
  const summary = excerpt(column.summary ?? "", width).map(theme.muted);
  const counts = wrapTextWithAnsi(
    renderStatusCounts(column.counts ?? [], theme),
    width,
  ).filter((line) => line.length > 0);
  if (column.id === "implementation" && implementation.rows.length > 0) {
    const graph = renderSidebarGraph(implementation, theme, width);
    return {
      heading,
      summary,
      counts,
      rows: graph.lines,
      evidence: undefined,
      graph,
    };
  }
  const rows: string[] = [];
  let evidence: RailSection["evidence"];
  for (const group of column.groups) {
    const first = group.items[0];
    if (first === undefined) continue;
    if (group.collapsed === true) {
      rows.push(
        theme[group.tone ?? "muted"](
          `▸ ${inline(first.status.glyph)} ${inline(group.label)} ${String(group.items.length)}`,
        ),
      );
      continue;
    }
    const focus = group.items.find((item) => item.id === column.focusId);
    const ordered =
      focus === undefined
        ? group.items
        : [focus, ...group.items.filter((item) => item !== focus)];
    for (const item of ordered) {
      rows.push(...itemLines(item, group, column, theme, width));
      if (
        column.id === "specification" &&
        item.details !== undefined &&
        (evidence === undefined || column.focusId === item.id)
      ) {
        evidence = {
          after: rows.length,
          lines: excerpt(item.details, width - 2).map((line) =>
            theme.muted(`  ${line}`),
          ),
        };
      }
    }
  }
  if (rows.length === 0 && column.emptyMessage !== undefined) {
    rows.push(...excerpt(column.emptyMessage, width).map(theme.muted));
  }
  return { heading, summary, counts, rows, evidence };
}

function draw(
  section: RailSection,
  height: number,
  theme: StatusTheme,
): string[] {
  const { heading, summary, rows, evidence } = section;
  const remaining = height - heading.length;
  if (remaining <= 0) return heading.slice(0, height);
  // Keep the first actionable entry visible on a short terminal.
  const context = summary.slice(
    0,
    Math.max(0, remaining - Math.min(rows.length, 2)),
  );
  const bodyHeight = remaining - context.length;
  if (section.graph !== undefined)
    return [
      ...heading,
      ...context,
      ...fitSidebarGraph(section.graph, bodyHeight, theme),
    ];
  if (rows.length > bodyHeight) {
    const counts = section.counts.slice(0, Math.max(0, bodyHeight - 2));
    return [
      ...heading,
      ...context,
      ...counts,
      ...rows.slice(0, bodyHeight - counts.length),
    ];
  }
  const body = [...rows];
  if (evidence !== undefined)
    body.splice(
      evidence.after,
      0,
      ...evidence.lines.slice(0, bodyHeight - rows.length),
    );
  return [...heading, ...context, ...body];
}

/** Passive companion to the lead. Mount at the right edge with the editor retaining keyboard focus. */
export function renderStatusSidebar(
  snapshot: {
    dockColumns: readonly StatusColumn[];
    implementation: ImplementationPresentation;
  },
  theme: GraphTheme,
  width: number,
  height: number,
): string[] {
  const columns = snapshot.dockColumns;
  if (width < 4 || height < 1 || columns.length === 0) return [];
  const inner = width - 3; // Divider and one inset cell on each side of the content.
  const sections = columns
    .slice(0, 2)
    .map((column) => section(column, theme, inner, snapshot.implementation));
  const natural = sections.map(
    ({ heading, summary, rows, evidence }) =>
      heading.length +
      summary.length +
      rows.length +
      (evidence?.lines.length ?? 0),
  );
  const gap = sections.length === 2 && height >= 6 ? 1 : 0;
  const available = height - gap;
  const firstBudget = Math.min(
    natural[0] ?? 0,
    Math.max(
      Math.ceil(available / sections.length),
      available - (natural[1] ?? 0),
    ),
  );
  const lines = sections.flatMap((part, index) =>
    index === 0
      ? draw(part, firstBudget, theme)
      : [
          ...(gap === 0 ? [] : [theme.muted("─".repeat(inner))]),
          ...draw(part, available - firstBudget, theme),
        ],
  );
  const divider = theme.muted("│");
  return Array.from(
    { length: height },
    (_, index) =>
      `${divider} ${truncateToWidth(lines[index] ?? "", inner, "…", true)} `,
  );
}
