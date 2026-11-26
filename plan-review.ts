import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { selectorText } from "@lanej/pi-components";
import { taskReviewFields, TaskDelivery, type LeadDraft } from "./lead-plan.ts";
import { planGraph, planGraphColor, renderGraphPrefix } from "./plan-graph.ts";

interface ReviewField {
  label: string;
  value: string;
  tone?: ThemeColor;
}

export interface PlanReview {
  draft: LeadDraft;
  context?: readonly ReviewField[];
  publications?: readonly ReviewField[];
  specification?: string;
}

type ReviewTheme = Pick<Theme, "fg" | "bold">;

function clean(value: string): string {
  return selectorText(value).replace(/\t/gu, "   ");
}

function oneLine(value: string): string {
  return clean(value).replace(/\s+/gu, " ").trim();
}

export function reviewContextValue(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replace(
      /\p{Cc}/gu,
      (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
}

function renderFields(
  fields: readonly ReviewField[],
  theme: ReviewTheme,
  width: number,
  exact = false,
): string[] {
  const labels = fields.map(({ label }) => oneLine(label));
  const indent = Math.max(0, ...labels.map(visibleWidth)) + 2;
  const inline = width - indent >= 16;
  const valueWidth = inline ? width - indent : width;
  return fields.flatMap(({ value, tone }, index) => {
    const label = labels[index] ?? "";
    const name = theme.fg("muted", label);
    const [first = "", ...rest] = wrapTextWithAnsi(
      exact ? reviewContextValue(value) : clean(value),
      valueWidth,
    ).map((line) => theme.fg(tone ?? "text", line));
    if (!inline) return [...wrapTextWithAnsi(name, width), first, ...rest];
    const padding = " ".repeat(indent - visibleWidth(label));
    const continuation = " ".repeat(indent);
    return [name + padding + first, ...rest.map((line) => continuation + line)];
  });
}

export function renderPlanReview(
  { draft, context = [], publications = [], specification }: PlanReview,
  theme: ReviewTheme,
  overviewWidth: number,
  detailsWidth = overviewWidth,
): { overview: string[]; details: string[] } {
  if (overviewWidth < 1 || detailsWidth < 1)
    return { overview: [], details: [] };
  const graph = planGraph(draft.tasks);
  const color = planGraphColor(theme);
  const wrap = (value: string, width: number) =>
    wrapTextWithAnsi(clean(value), width);
  const section = (value: string, width: number) =>
    wrapTextWithAnsi(theme.fg("accent", theme.bold(value)), width);
  const overview: string[] = [];
  if (context.length > 0)
    overview.push(...renderFields(context, theme, overviewWidth, true), "");

  overview.push(...section("Task dependencies", overviewWidth));
  if (graph.length === 0)
    overview.push(...wrap("No child tasks", overviewWidth));
  for (const { task, prefix, connectors } of graph) {
    const hold = task.hold === true ? theme.fg("warning", "  on hold") : "";
    overview.push(
      `${renderGraphPrefix(prefix, color)}  ${theme.fg("text", oneLine(task.title))}${hold}`,
      ...connectors.map((line) => renderGraphPrefix(line, color).trimEnd()),
    );
  }

  if (publications.length > 0)
    overview.push(
      "",
      ...section("PR publication", overviewWidth),
      ...renderFields(publications, theme, overviewWidth),
    );

  overview.push(
    "",
    ...section("Plan summary", overviewWidth),
    ...wrap(draft.summary, overviewWidth),
  );
  if (draft.pullRequestMerge !== undefined)
    overview.push(
      ...renderFields(
        [{ label: "PR merge", value: draft.pullRequestMerge }],
        theme,
        overviewWidth,
      ),
    );
  overview.push(
    ...wrap(
      "Change a proposal before approval: /plan-delivery <task-key> <local|pull-request>",
      overviewWidth,
    ),
  );

  const details: string[] = [];
  if (graph.length > 0) details.push(...section("Task details", detailsWidth));
  for (const { task } of graph) {
    const heading = `${task.key} · ${oneLine(task.title)}`;
    const fields: ReviewField[] = taskReviewFields(task).map(
      ({ label, value }) => ({
        label,
        value,
        ...(label === "Admission" && task.hold === true
          ? { tone: "warning" }
          : {}),
        ...(label === "Delivery" && task.delivery === TaskDelivery.PullRequest
          ? { tone: "accent" }
          : {}),
      }),
    );
    details.push(
      ...wrapTextWithAnsi(
        theme.fg("toolTitle", theme.bold(heading)),
        detailsWidth,
      ),
      ...wrap(task.description, detailsWidth),
      ...renderFields(fields, theme, detailsWidth),
      "",
    );
  }

  if (specification !== undefined)
    details.push(
      ...section("Specification", detailsWidth),
      ...wrap(specification.trimEnd(), detailsWidth),
    );
  else if (details.at(-1) === "") details.pop();

  return {
    overview: overview.map((line) => truncateToWidth(line, overviewWidth, "…")),
    details: details.map((line) => truncateToWidth(line, detailsWidth, "…")),
  };
}
