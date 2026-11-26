import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { ConditionState, conditionMark, selectorText } from "@lanej/pi-components";
import { type LeadDraft, publicationGroups } from "../lead-plan.ts";
import { planGraph, planGraphColor, renderGraphPrefix } from "../plan-graph.ts";
import { coverageBasisCurrent, coverageProperties } from "../socrates/assessment.ts";
import { conditionStates } from "../socrates/columns.ts";
import { type LeadSpecification, SpecStatus } from "../socrates/spec.ts";

type ReviewTheme = Pick<Theme, "fg" | "bold">;

function inline(text: string): string {
  return selectorText(text).replace(/\s+/gu, " ").trim();
}

function heading(theme: ReviewTheme, title: string, context: string): string {
  return theme.fg("text", theme.bold(title)) + "  " + theme.fg("muted", context);
}

function specificationRows(
  theme: ReviewTheme,
  width: number,
  draft: LeadDraft,
  spec: LeadSpecification | undefined,
): string[] {
  const badges: string[] = [];
  if (spec) {
    const basisCurrent = coverageBasisCurrent(spec, spec.acceptedRevision);
    const properties = coverageProperties(spec.draft);
    const states = [
      ConditionState.Open,
      ConditionState.Partial,
      ConditionState.Satisfied,
      ConditionState.NotApplicable,
    ] as const;
    for (const state of ["recheck", ...states] as const) {
      const stale = state === "recheck";
      const total = properties.filter((property) =>
        stale
          ? property.recorded && !basisCurrent
          : (basisCurrent || !property.recorded) && conditionStates[property.status] === state,
      ).length;
      if (total === 0) continue;
      const mark = stale ? conditionMark({ stale: true }) : conditionMark({ state });
      const color = mark.tone === "review" ? "thinkingHigh" : mark.tone;
      badges.push(theme.fg(color, `${mark.glyph} ${String(total)} ${mark.label.toLowerCase()}`));
    }
  }
  const status = !spec
    ? "No saved specification"
    : `${spec.status === SpecStatus.Frozen ? "◆ Frozen" : "◇ Draft"} · v${String(spec.version)}`;
  const objective = inline(spec?.draft?.objective ?? draft.summary);
  return [
    ...wrapTextWithAnsi([heading(theme, "Specification", status), ...badges].join("   "), width),
    ...wrapTextWithAnsi(theme.fg("text", objective), width),
  ];
}

function graphRows(theme: ReviewTheme, width: number, draft: LeadDraft): string[] {
  const graph = planGraph(draft.tasks);
  const rows = wrapTextWithAnsi(
    heading(theme, "Implementation", `${String(graph.length)} ${graph.length === 1 ? "bead" : "beads"}`),
    width,
  );
  const color = planGraphColor(theme);
  const prerequisites = new Set(draft.tasks.flatMap((task) => task.blockedBy));
  const keyWidth = Math.max(0, ...graph.map(({ key }) => visibleWidth(key)));
  for (const row of graph) {
    const prefix = renderGraphPrefix(row.prefix, color, theme.fg("muted", "◇"));
    // Carry live lanes through wrapped titles so their fork or join stays attached.
    const continued = renderGraphPrefix(row.prefix, (lane, glyph) =>
      color(lane, glyph === "●" ? (prerequisites.has(row.key) ? "│" : " ") : glyph),
    );
    const title = theme.fg("text", inline(row.task.title));
    const key = theme.fg("muted", inline(row.key));
    const hold = row.task.hold === true ? theme.fg("warning", " · On hold") : "";
    const titleWidth = width - visibleWidth(prefix) - keyWidth - 3;
    if (titleWidth >= 16) {
      const lines = wrapTextWithAnsi(title + hold, titleWidth);
      for (const [index, line] of lines.entries()) {
        rows.push(
          index === 0
            ? prefix + " " + line + " ".repeat(Math.max(2, titleWidth - visibleWidth(line) + 2)) + key
            : continued + " " + line,
        );
      }
    } else if (width > visibleWidth(prefix) + 1) {
      const lines = wrapTextWithAnsi(`${title}  ${key}${hold}`, width - visibleWidth(prefix) - 1);
      rows.push(...lines.map((line, index) => (index === 0 ? prefix : continued) + " " + line));
    } else {
      rows.push(...wrapTextWithAnsi(`${prefix} ${title}  ${key}${hold}`, width));
    }
    for (const connector of row.connectors) {
      rows.push(...wrapTextWithAnsi(renderGraphPrefix(connector, color), width));
    }
  }
  return rows;
}

function deliveryRows(theme: ReviewTheme, width: number, draft: LeadDraft): string[] {
  const groups = publicationGroups(draft);
  const rows = wrapTextWithAnsi(
    heading(theme, "Delivery", `${String(groups.length)} ${groups.length === 1 ? "PR" : "PRs"}`),
    width,
  );
  const published = new Set<string>();
  for (const { publisher, local } of groups) {
    published.add(publisher.key);
    rows.push(...wrapTextWithAnsi(theme.fg("text", theme.bold(inline(publisher.key))), width));
    if (local.length > 0) {
      for (const task of local) published.add(task.key);
      rows.push(
        ...wrapTextWithAnsi(
          theme.fg("muted", "  Also includes ") + local.map(({ key }) => inline(key)).join(", "),
          width,
        ),
      );
    }
  }
  const staying = draft.tasks.filter((task) => !published.has(task.key));
  if (staying.length > 0) {
    if (groups.length > 0) rows.push("");
    rows.push(...wrapTextWithAnsi(theme.fg("text", theme.bold("Stays local")), width));
    rows.push(...wrapTextWithAnsi(staying.map((task) => inline(task.key)).join(", "), width));
  }
  if (groups.length > 0) {
    const rule =
      draft.pullRequestMerge === "manual"
        ? "Manual approval"
        : draft.pullRequestMerge === "project-policy"
          ? "Project policy"
          : "Project policy (runtime default)";
    rows.push("", ...wrapTextWithAnsi(theme.fg("muted", "Merge · ") + theme.fg("text", rule), width));
  }
  return rows;
}

export function handoffOverview(
  theme: ReviewTheme,
  width: number,
  draft: LeadDraft,
  specification: LeadSpecification | undefined,
): string[] {
  if (width < 1) return [];
  const summary = specificationRows(theme, width, draft, specification);
  if (width < 88) return [...summary, "", ...graphRows(theme, width, draft), "", ...deliveryRows(theme, width, draft)];
  const leftWidth = Math.floor((width - 3) * 0.58);
  const left = graphRows(theme, leftWidth, draft);
  const right = deliveryRows(theme, width - leftWidth - 3, draft);
  const divider = theme.fg("borderMuted", " │ ");
  const body = Array.from({ length: Math.max(left.length, right.length) }, (_, index) => {
    const line = left[index] ?? "";
    return line + " ".repeat(Math.max(0, leftWidth - visibleWidth(line))) + divider + (right[index] ?? "");
  });
  return [...summary, "", ...body];
}
