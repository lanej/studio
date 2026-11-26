import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  renderStatusMark,
  renderStatusDock,
  renderStatusCounts,
  selectorText,
  statusPaint,
  type StatusColumn,
  type StatusItem,
  type StatusTheme,
} from "@lanej/pi-components";
import { planGraph, renderGraphPrefix } from "../plan-graph.ts";
import { withTaskAssignment } from "../tasks/presentation.ts";
import { renderBeadProgress } from "./bead-progress.ts";
import { taskMarks } from "./columns.ts";
import {
  renderWorkerCompact,
  type WorkerSidebarView,
} from "./worker-section.ts";

export {
  renderWorkerCompact,
  type WorkerSidebarView,
} from "./worker-section.ts";
import type { ImplementationPresentation } from "./implementation.ts";

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
    const paint = statusPaint(theme, mark.tone);
    const prefix = renderGraphPrefix(row.prefix, theme.lane, paint(mark.glyph));
    const title = inline(row.task.label);
    const subject = `${prefix}  ${title}`;
    nodeLines.push(lines.length);
    lines.push(
      truncateToWidth(
        withTaskAssignment(subject, row.task.assignment, width, theme.muted),
        width,
        "…",
      ),
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

/** Place the lifecycle at the right edge of the section heading. */
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

interface SidebarSnapshot {
  dockColumns: readonly StatusColumn[];
  implementation: ImplementationPresentation;
  prioritizeSpecification: boolean;
}

function sectionHeading(
  column: StatusColumn,
  theme: StatusTheme,
  width: number,
): string {
  const title = theme.bold(inline(column.title));
  if (column.status === undefined) return title;
  const phase = renderStatusMark(column.status, theme);
  const phaseWidth = Math.max(0, width - visibleWidth(title) - 1);
  if (visibleWidth(phase) <= phaseWidth) return align(title, phase, width);
  // A tracked plan's spec version also appears in the inspector.
  const short = renderStatusMark(
    {
      ...column.status,
      label: column.status.label
        .replace(/ · spec v\d+$/u, "")
        .replace(/^Awaiting approval$/u, "For approval"),
    },
    theme,
  );
  return `${title} ${truncateToWidth(short, phaseWidth, "…")}`;
}

function wrapped(text: string | undefined, width: number): string[] {
  if (text === undefined || text.length === 0 || width <= 0) return [];
  return wrapTextWithAnsi(inline(text), width);
}

/** Ellipsize only the last visible line when the viewport really runs out. */
function excerpt(lines: string[], height: number, width: number): string[] {
  if (height <= 0) return [];
  if (lines.length <= height) return lines;
  return [
    ...lines.slice(0, height - 1),
    truncateToWidth(lines.slice(height - 1).join(" "), width, "…"),
  ];
}

function propertyTitle(
  item: StatusItem,
  focusId: string | undefined,
  theme: StatusTheme,
  width: number,
): string[] {
  const mark = statusPaint(theme, item.status.tone);
  const label = inline(item.label);
  const glyph = mark(inline(item.status.glyph));
  const focus = item.id === focusId ? ` ${theme.accent("◆")}` : "";
  return wrapTextWithAnsi(label + focus, Math.max(1, width - 2)).map(
    (line, index) => (index === 0 ? `${glyph} ` : "  ") + line,
  );
}

function specificationRows(
  column: StatusColumn,
  theme: StatusTheme,
  width: number,
  height: number,
  prioritize: boolean,
): string[] {
  if (height <= 0) return [];
  const rows = [sectionHeading(column, theme, width)];
  const attention =
    column.groups.find(({ id }) => id === "attention")?.items ?? [];
  const ordered = [...attention].sort(
    (a, b) => Number(b.id === column.focusId) - Number(a.id === column.focusId),
  );
  const groups = column.groups.filter((group) => group.collapsed === true);
  const reserve = ordered.length === 0 ? Math.min(2, groups.length) : 3;
  const contextHeight = Math.min(
    prioritize ? 5 : 2,
    Math.floor(height / 3),
    Math.max(0, height - 1 - reserve),
  );
  rows.push(
    ...excerpt(
      wrapped(column.summary ?? column.emptyMessage, width),
      contextHeight,
      width,
    ).map(theme.muted),
  );

  // Give each visible property a name and a readable start to its reason. Share
  // the remaining lines so a lengthy assessment cannot crowd out the next gap.
  const cards = ordered.map((item) => ({
    title: propertyTitle(item, column.focusId, theme, width),
    reason: wrapped(item.details, width - 2),
    shown: 0,
  }));
  let room = height - rows.length;
  let visible = 0;
  for (const [index, card] of cards.entries()) {
    const minimum = Math.min(2, card.reason.length);
    const more = index + 1 < cards.length ? 1 : 0;
    if (card.title.length + minimum + more > room && visible > 0) break;
    if (card.title.length > room) break;
    card.shown = Math.min(
      minimum,
      Math.max(0, room - card.title.length - more),
    );
    room -= card.title.length + card.shown;
    visible++;
  }
  const omitted = cards.length - visible;
  const footerHeight = Math.min(room, omitted > 0 ? 1 : groups.length);
  room -= footerHeight;
  const shown = cards.slice(0, visible);
  while (room > 0) {
    const unfinished = shown.filter((card) => card.shown < card.reason.length);
    if (unfinished.length === 0) break;
    for (const card of unfinished.slice(0, room)) {
      card.shown++;
      room--;
    }
  }
  for (const card of shown) {
    rows.push(
      ...card.title,
      ...excerpt(card.reason, card.shown, width - 2).map((line) =>
        theme.muted(`  ${line}`),
      ),
    );
  }
  if (omitted > 0) {
    if (footerHeight > 0)
      rows.push(theme.muted(`+${String(omitted)} more properties`));
    return rows;
  }
  for (const group of groups.slice(0, footerHeight)) {
    rows.push(
      statusPaint(
        theme,
        group.tone ?? "muted",
      )(`▸ ${inline(group.label)} ${String(group.items.length)}`),
    );
  }
  return rows;
}

function implementationRows(
  implementation: ImplementationPresentation,
  column: StatusColumn,
  graph: SidebarGraph,
  theme: StatusTheme,
  width: number,
  height: number,
  preview: boolean,
): string[] {
  if (height <= 0) return [];
  const rows = [sectionHeading(column, theme, width)];
  if (height === 1) return rows;
  rows.push(
    ...renderBeadProgress(
      implementation,
      theme,
      width,
      Math.min(3, height - rows.length),
    ),
  );
  if (!preview) {
    const context = wrapped(
      column.summary ??
        (graph.lines.length === 0 ? column.emptyMessage : undefined),
      width,
    );
    const count = Math.min(
      2,
      Math.max(0, height - rows.length - Math.min(graph.lines.length, 2)),
    );
    rows.push(...excerpt(context, count, width).map(theme.muted));
  }
  rows.push(...fitSidebarGraph(graph, height - rows.length, theme));
  return rows;
}

/** Keep the plan in view during discovery, then give its dependency graph the available space. */
export function renderSocratesSections(
  snapshot: SidebarSnapshot,
  theme: GraphTheme,
  width: number,
  height: number,
  compact = false,
  workers?: WorkerSidebarView,
): string[] {
  const showWorkers =
    workers !== undefined &&
    (workers.rows.length > 0 || workers.evidenceError !== undefined);
  if (!showWorkers)
    return renderPlanSections(snapshot, theme, width, height, compact);
  if (width < 3 || height < 1) return [];
  const gap = !compact && height >= 6 ? 1 : 0;
  const workerBudget = Math.max(1, Math.floor(height / 2));
  const roster = renderWorkerCompact(workers, theme, width, workerBudget, true);
  const plan = renderPlanSections(
    snapshot,
    theme,
    width,
    height - roster.length - gap,
    compact,
  );
  return [
    ...plan,
    ...(plan.length > 0 && gap > 0 ? [theme.muted("─".repeat(width))] : []),
    ...(roster.length === workerBudget &&
    plan.length + gap + workerBudget < height
      ? renderWorkerCompact(
          workers,
          theme,
          width,
          height - plan.length - gap,
          true,
        )
      : roster),
  ];
}

function renderPlanSections(
  snapshot: SidebarSnapshot,
  theme: GraphTheme,
  width: number,
  height: number,
  compact: boolean,
): string[] {
  const spec = snapshot.dockColumns.find(
    (column) => column.id === "specification",
  );
  const plan = snapshot.dockColumns.find(
    (column) => column.id === "implementation",
  );
  if (width < 3 || height < 1) return [];
  if (plan === undefined)
    return spec === undefined
      ? []
      : specificationRows(spec, theme, width, height, true);
  const graph = renderSidebarGraph(snapshot.implementation, theme, width);
  if (spec === undefined)
    return implementationRows(
      snapshot.implementation,
      plan,
      graph,
      theme,
      width,
      height,
      false,
    );
  const priority = snapshot.prioritizeSpecification;
  const gap = compact || height < 6 ? 0 : 1;
  const available = height - gap;
  // Reserve a short preview while the spec is open. The graph gets every row
  // the properties leave unused, even while the plan is still a draft.
  const reservedForPlan = compact ? 1 : Math.min(5, 1 + graph.lines.length);
  const specBudget = priority
    ? available - Math.min(reservedForPlan, Math.floor(available / 3))
    : Math.min(8, Math.max(1, Math.floor(available / 3)));
  const rows = specificationRows(spec, theme, width, specBudget, priority);
  const planHeight = available - rows.length;
  if (planHeight > 0) {
    if (gap > 0) rows.push(theme.muted("─".repeat(width)));
    rows.push(
      ...implementationRows(
        snapshot.implementation,
        plan,
        graph,
        theme,
        width,
        planHeight,
        priority,
      ),
    );
  }
  return rows;
}

/** The caller allocates room for worker questions before laying out the compact dock. */
export function renderSocratesDock(
  snapshot: SidebarSnapshot,
  theme: GraphTheme,
  width: number,
  height: number,
  expanded: boolean,
): string[] {
  if (expanded && snapshot.prioritizeSpecification)
    return renderSocratesSections(snapshot, theme, width, height, true);
  const spec = snapshot.dockColumns.find(
    (column) => column.id === "specification",
  );
  const gridHeight =
    spec !== undefined && snapshot.prioritizeSpecification
      ? height - 1
      : height;
  const grid = expanded
    ? []
    : renderBeadProgress(snapshot.implementation, theme, width, gridHeight);
  if (grid.length === 0)
    return renderStatusDock({
      columns: snapshot.dockColumns,
      theme,
      width,
      expanded,
      maxRows: height,
    });
  if (spec === undefined || grid.length >= height) return grid;
  const summary = [
    theme.bold(spec.title),
    spec.status === undefined ? "" : renderStatusMark(spec.status, theme),
    renderStatusCounts(spec.counts ?? [], theme),
  ]
    .filter(Boolean)
    .join("  ");
  const rows = [truncateToWidth(summary, width, "…"), ...grid];
  if (
    rows.length < height &&
    spec.summary !== undefined &&
    spec.summary.trim().length > 0
  )
    rows.push(truncateToWidth(theme.muted(inline(spec.summary)), width, "…"));
  return rows;
}

/** Passive companion to the lead. The editor retains keyboard focus. */
export function renderStatusSidebar(
  snapshot: SidebarSnapshot,
  theme: GraphTheme,
  width: number,
  height: number,
  workers?: WorkerSidebarView,
): string[] {
  if (width < 6 || height < 1 || snapshot.dockColumns.length === 0) return [];
  const inner = width - 3;
  const rows = renderSocratesSections(
    snapshot,
    theme,
    inner,
    height,
    false,
    workers,
  );
  const divider = theme.muted("│");
  return Array.from(
    { length: height },
    (_, index) =>
      `${divider} ${truncateToWidth(rows[index] ?? "", inner, "…", true)} `,
  );
}
