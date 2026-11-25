import { keyText, type Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { selectorText } from "@lanej/pi-components";
import { z } from "zod";
import { deliveryOutcome, draftSchema, taskReviewLines } from "./lead-plan.ts";
import { planGraph, planGraphColor, renderGraphPrefix } from "./plan-graph.ts";

const previewTaskLimit = 6;
const previewLineLimit = 10;

function singleLine(value: string): string {
  return selectorText(value).replace(/\s+/gu, " ").trim();
}

export function renderPlanCall(
  args: unknown,
  theme: Theme,
  context: { expanded: boolean; argsComplete: boolean; isPartial: boolean },
): Component {
  // On transcript replay Pi supplies a final result without marking argsComplete.
  const streaming = !context.argsComplete && context.isPartial;
  const parsed = streaming ? undefined : draftSchema.safeParse(args);
  const draft = parsed?.success === true ? parsed.data : undefined;
  const partialSummary =
    typeof args === "object" &&
    args !== null &&
    "summary" in args &&
    typeof args.summary === "string"
      ? args.summary
      : "";
  const graph = planGraph(draft?.tasks ?? []);
  const color = planGraphColor(theme);
  return {
    invalidate() {},
    render(width) {
      if (width < 1) return [];
      const heading = theme.fg(
        "toolTitle",
        theme.bold(
          streaming ? "Drafting implementation plan" : "Implementation plan",
        ),
      );
      const count =
        draft === undefined
          ? ""
          : graph.length === 0
            ? "No child tasks"
            : `${String(graph.length)} ${graph.length === 1 ? "task" : "tasks"}`;
      const lines = [
        heading + (count.length === 0 ? "" : theme.fg("muted", `   ${count}`)),
      ];
      const summary = context.expanded
        ? selectorText(draft?.summary ?? partialSummary)
        : singleLine(partialSummary);
      if (summary.length > 0) {
        const wrapped = wrapTextWithAnsi(summary, width);
        const [first = "", second = ""] = wrapped;
        const excerpt =
          context.expanded || wrapped.length <= 2
            ? wrapped
            : [first, `${truncateToWidth(second.trimEnd(), width - 1, "")}…`];
        lines.push(...excerpt.map((line) => theme.fg("text", line)));
      }
      if (context.expanded && parsed?.success === false)
        lines.push(
          ...wrapTextWithAnsi(
            selectorText(z.prettifyError(parsed.error)),
            width,
          ),
        );
      if (graph.length > 0) lines.push("");
      let shown = 0;
      let graphLines = 0;
      for (const row of graph) {
        const connectors = graph[shown - 1]?.connectors ?? [];
        if (
          !context.expanded &&
          (shown === previewTaskLimit ||
            graphLines + connectors.length + 1 > previewLineLimit)
        )
          break;
        for (const line of connectors)
          lines.push(renderGraphPrefix(line, color));
        const { task } = row;
        const hold = task.hold === true ? theme.fg("warning", "  on hold") : "";
        lines.push(
          `${renderGraphPrefix(row.prefix, color)}  ${theme.fg("text", singleLine(task.title))}${hold}`,
        );
        lines.push(
          ...wrapTextWithAnsi(
            `  ${task.key} · ${deliveryOutcome(task.delivery)}${task.delivery === undefined ? " (default)" : ""}`,
            width,
          ),
        );
        graphLines += connectors.length + 2;
        shown++;
      }
      if (shown < graph.length) {
        const remaining = graph.length - shown;
        const shortcut = keyText("app.tools.expand");
        lines.push(
          theme.fg(
            "muted",
            `+${String(remaining)} more ${remaining === 1 ? "task" : "tasks"}${shortcut.length > 0 ? ` · ${shortcut} to expand` : ""}`,
          ),
        );
      }
      if (context.expanded) {
        for (const { task } of graph) {
          lines.push(
            "",
            ...wrapTextWithAnsi(
              theme.bold(`${task.key} · ${singleLine(task.title)}`),
              width,
            ),
            ...wrapTextWithAnsi(
              selectorText(taskReviewLines(task).join("\n")),
              width,
            ),
          );
        }
      }
      return lines.map((line) => truncateToWidth(line, width, "…"));
    },
  };
}
