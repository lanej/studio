import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { selectorText } from "@lanej/pi-components";
import { taskReviewFields, TaskDelivery, type LeadDraft } from "./lead-plan.ts";
import { planGraph, planGraphColor, renderGraphPrefix } from "./plan-graph.ts";
import { taskWaves } from "./smart-plan-graph.ts";

interface ReviewField {
  label: string;
  value: string;
  tone?: ThemeColor;
}

export interface PlanReview {
  draft: LeadDraft;
  context?: readonly ReviewField[];
  specification?: string;
}

type ReviewTheme = Pick<Theme, "fg" | "bold">;

function clean(value: string): string {
  return selectorText(value).replace(/\t/gu, "   ");
}

function oneLine(value: string): string {
  return clean(value).replace(/\s+/gu, " ").trim();
}

function renderFields(
  fields: readonly ReviewField[],
  theme: ReviewTheme,
  width: number,
): string[] {
  const labels = fields.map(({ label }) => oneLine(label));
  const indent = Math.max(0, ...labels.map(visibleWidth)) + 2;
  const inline = width - indent >= 16;
  const valueWidth = inline ? width - indent : width;
  return fields.flatMap(({ value, tone }, index) => {
    const label = labels[index] ?? "";
    const name = theme.fg("muted", label);
    const [first = "", ...rest] = wrapTextWithAnsi(
      clean(value),
      valueWidth,
    ).map((line) => theme.fg(tone ?? "text", line));
    if (!inline) return [...wrapTextWithAnsi(name, width), first, ...rest];
    const padding = " ".repeat(indent - visibleWidth(label));
    const continuation = " ".repeat(indent);
    return [name + padding + first, ...rest.map((line) => continuation + line)];
  });
}

export function renderPlanReview(
  { draft, context = [], specification }: PlanReview,
  theme: ReviewTheme,
  width: number,
): string[] {
  if (width < 1) return [];
  const graph = planGraph(draft.tasks);
  const color = planGraphColor(theme);
  const wrap = (value: string) => wrapTextWithAnsi(clean(value), width);
  const section = (value: string) =>
    wrapTextWithAnsi(theme.fg("accent", theme.bold(value)), width);
  const lines: string[] = [];
  if (context.length > 0)
    lines.push(...renderFields(context, theme, width), "");

  lines.push(...section("Task dependencies"));
  if (graph.length === 0) lines.push(...wrap("No child tasks"));
  for (const { task, prefix, connectors } of graph) {
    const hold = task.hold === true ? theme.fg("warning", "  on hold") : "";
    lines.push(
      `${renderGraphPrefix(prefix, color)}  ${theme.fg("text", oneLine(task.title))}${hold}`,
      ...connectors.map((line) => renderGraphPrefix(line, color).trimEnd()),
    );
  }

  lines.push("", ...section("Plan summary"), ...wrap(draft.summary));
  if (draft.pullRequestMerge !== undefined)
    lines.push(
      ...renderFields(
        [{ label: "PR merge", value: draft.pullRequestMerge }],
        theme,
        width,
      ),
    );
  lines.push(
    ...wrap(
      "Change a proposal before approval: /plan-delivery <task-key> <local|pull-request>",
    ),
  );

  if (graph.length > 0) lines.push("", ...section("Task details"));
  const waves = taskWaves(draft.tasks);
  let displayedWave: number | undefined;
  for (const { task } of graph) {
    const wave = waves.get(task.key);
    if (wave !== undefined && wave !== displayedWave) {
      lines.push(
        ...wrapTextWithAnsi(theme.fg("accent", `Wave ${String(wave)}`), width),
      );
      displayedWave = wave;
    }
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
    lines.push(
      ...wrapTextWithAnsi(theme.fg("toolTitle", theme.bold(heading)), width),
      ...wrap(task.description),
      ...renderFields(fields, theme, width),
      "",
    );
  }

  if (specification !== undefined) {
    if (lines.at(-1) !== "") lines.push("");
    lines.push(...section("Specification"), ...wrap(specification.trimEnd()));
  } else if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.map((line) => truncateToWidth(line, width, "…"));
}
