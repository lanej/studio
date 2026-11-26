import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  renderStatusCounts,
  renderStatusMark,
  selectorText,
  statusPaint,
  type StatusTheme,
} from "@lanej/pi-components";
import { planGraph, planGraphColor, renderGraphPrefix } from "../plan-graph.ts";
import { withTaskAssignment } from "../ui.ts";
import { implementationColumn, taskMarks } from "./columns.ts";
import type { ImplementationPresentation } from "./implementation.ts";

function graphRows(plan: ImplementationPresentation) {
  return planGraph(plan.rows.map((row) => ({ ...row, key: row.id })));
}

export function createPlanInspector(
  initial: ImplementationPresentation,
  theme: Theme,
  options: {
    title: string;
    theme: StatusTheme;
    height: () => number;
    requestRender: () => void;
    onClose: () => void;
  },
) {
  let plan = initial;
  let column = implementationColumn(plan);
  let rows = graphRows(plan);
  let selected = 0;
  let detail = false;
  let offset = 0;
  let maximum = 0;
  let page = 1;
  const color = planGraphColor(theme);
  const oneLine = (text: string) =>
    selectorText(text).replace(/\s+/gu, " ").trim();

  return {
    invalidate() {},
    setPlan(next: ImplementationPresentation) {
      const id = rows[selected]?.task.id;
      plan = next;
      column = implementationColumn(plan);
      rows = graphRows(plan);
      const index = rows.findIndex(({ task }) => task.id === id);
      if (index < 0) {
        detail = false;
        offset = 0;
      }
      selected = Math.max(index, 0);
      options.requestRender();
    },
    render(width: number) {
      const height = options.height();
      if (width < 1 || height < 1) return [];
      const heading = theme.bold(oneLine(options.title));
      const task = rows[selected]?.task;
      let header: string[];
      let body: string[];
      let targetLine = 0;
      let footer: string;
      if (detail && task !== undefined) {
        const status = renderStatusMark(taskMarks[task.state], options.theme);
        header = [
          heading,
          ...wrapTextWithAnsi(
            `${theme.bold(oneLine(task.label))}  ${status}`,
            width,
          ),
          "",
        ];
        body = wrapTextWithAnsi(selectorText(task.details), width);
        footer = "↑↓ scroll  ·  Esc back";
      } else {
        const status =
          column.status === undefined
            ? ""
            : renderStatusMark(column.status, options.theme);
        const counts = renderStatusCounts(column.counts ?? [], options.theme);
        header = [heading, [status, counts].filter(Boolean).join("   ")];
        if (column.summary !== undefined) {
          const summary = wrapTextWithAnsi(oneLine(column.summary), width);
          const limit = Math.min(3, Math.max(1, height - 6));
          header.push(
            ...summary
              .slice(0, limit)
              .map((line, i) =>
                theme.fg(
                  "muted",
                  i === limit - 1 && summary.length > limit
                    ? `${truncateToWidth(line.trimEnd(), width - 1, "")}…`
                    : line,
                ),
              ),
          );
        }
        header.push("");
        body = [];
        for (const [index, graph] of rows.entries()) {
          const item = graph.task;
          const mark = taskMarks[item.state];
          const prefix = renderGraphPrefix(
            graph.prefix,
            color,
            statusPaint(options.theme, mark.tone)(mark.glyph),
          );
          const label = oneLine(item.label);
          const current = index === selected;
          const pointer = current ? theme.fg("accent", "› ") : "  ";
          const row = truncateToWidth(
            withTaskAssignment(
              `${pointer}${prefix}  ${label}`,
              item.assignment,
              width,
              (text) => theme.fg("muted", text),
            ),
            width,
          );
          if (current) targetLine = body.length;
          body.push(
            current
              ? options.theme.selected(truncateToWidth(row, width, "", true))
              : row,
          );
          body.push(
            ...graph.connectors.map(
              (line) => `  ${renderGraphPrefix(line, color)}`,
            ),
          );
        }
        if (body.length === 0)
          body.push(theme.fg("muted", oneLine(plan.detail)));
        footer =
          rows.length === 0
            ? "Esc close"
            : "↑↓ select  ·  Enter details  ·  Esc close";
      }
      // Keep one content line available even in a short split pane.
      header = header.slice(0, Math.max(0, height - 2));
      page = Math.max(1, height - header.length - 1);
      maximum = Math.max(0, body.length - page);
      offset = Math.min(offset, maximum);
      if (!detail)
        offset = Math.min(targetLine, Math.max(offset, targetLine - page + 1));
      return [
        ...header,
        ...body.slice(offset, offset + page),
        theme.fg("dim", footer),
      ]
        .slice(0, height)
        .map((line) => truncateToWidth(line, width));
    },
    handleInput(input: string) {
      if (matchesKey(input, "ctrl+c")) {
        options.onClose();
        return;
      }
      if (
        matchesKey(input, "escape") ||
        (detail && (input === "h" || matchesKey(input, "left")))
      ) {
        if (!detail) {
          options.onClose();
          return;
        }
        detail = false;
        offset = 0;
      } else if (
        matchesKey(input, "enter") &&
        !detail &&
        rows[selected] !== undefined
      ) {
        detail = true;
        offset = 0;
      } else {
        const last = detail ? maximum : Math.max(0, rows.length - 1);
        const at = detail ? offset : selected;
        let next: number;
        if (matchesKey(input, "home")) next = 0;
        else if (matchesKey(input, "end")) next = last;
        else if (matchesKey(input, "pageDown")) next = at + page;
        else if (matchesKey(input, "pageUp")) next = at - page;
        else if (input === "j" || matchesKey(input, "down")) next = at + 1;
        else if (input === "k" || matchesKey(input, "up")) next = at - 1;
        else return;
        next = Math.max(0, Math.min(last, next));
        if (detail) offset = next;
        else selected = next;
      }
      options.requestRender();
    },
  };
}
