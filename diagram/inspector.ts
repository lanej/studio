import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { planGraphColor, renderGraphPrefix } from "../plan-graph.ts";
import type { Diagram } from "./model.ts";
import { diagramLayout } from "./render.ts";

type Layout = ReturnType<typeof diagramLayout>;

function relationshipLines(
  diagram: Diagram,
  layout: Layout,
  nodeId: string,
  theme: Theme,
  width: number,
): string[] {
  const node = layout.byId.get(nodeId);
  if (node === undefined) return [];
  const detail =
    node.detail === undefined ? [] : wrapTextWithAnsi(node.detail, width);
  const edges: string[] = [];
  for (const edge of diagram.edges) {
    if (edge.from !== nodeId && edge.to !== nodeId) continue;
    const outgoing = edge.from === nodeId;
    const otherId = outgoing ? edge.to : edge.from;
    const arrow = edge.from === edge.to ? "↻" : outgoing ? "→" : "←";
    const label =
      edge.label === undefined
        ? ""
        : ` · ${theme.fg("syntaxString", edge.label)}`;
    const target = layout.byId.get(otherId)?.name ?? otherId;
    edges.push(
      ...wrapTextWithAnsi(
        `${theme.fg("accent", arrow)} ${target}${label}`,
        width,
      ),
    );
  }
  if (detail.length === 0 && edges.length === 0)
    return [theme.fg("muted", "No connections")];
  return [
    ...detail,
    ...(detail.length > 0 && edges.length > 0 ? [""] : []),
    ...edges,
  ];
}

function graphList(
  layout: Layout,
  selected: number,
  theme: Theme,
  width: number,
  height: number,
) {
  const lines: string[] = [];
  const color = planGraphColor(theme);
  const rails = (layout.rows[0]?.prefix.length ?? 0) + 12 <= width;
  let focusLine = 0;
  for (const [index, row] of layout.rows.entries()) {
    const active = index === selected;
    const prefix = rails ? renderGraphPrefix(row.prefix, color) + "  " : "";
    const line = truncateToWidth(
      `${active ? "› " : "  "}${prefix}${row.task.name}`,
      width,
      "…",
      true,
    );
    if (active) focusLine = lines.length;
    lines.push(
      active
        ? theme.style(line, { fg: "text", bg: "selectedBg", bold: true })
        : line,
    );
    if (rails)
      lines.push(
        ...row.connectors.map(
          (connector) => "  " + renderGraphPrefix(connector, color),
        ),
      );
  }
  const start = Math.max(
    0,
    Math.min(focusLine - Math.floor(height / 2), lines.length - height),
  );
  return lines.slice(start, start + height);
}

export async function inspectDiagram(
  ctx: ExtensionContext,
  diagram: Diagram,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!ctx.hasUI || signal?.aborted === true) return undefined;
  const layout = diagramLayout(diagram);
  const question = diagram.question;
  return ctx.ui.custom<string | undefined>(
    (tui, theme, _keys, done) => {
      let selected = 0;
      let inspecting = false;
      let scroll = 0;
      let maximum = 0;
      let page = 1;
      const cancel = () => {
        done(undefined);
      };
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted === true) queueMicrotask(cancel);
      return {
        invalidate() {},
        render(width) {
          const node = layout.rows[selected]?.task;
          if (node === undefined || width < 6) return [];
          const inner = width - 4;
          const height = Math.max(1, tui.terminal.rows - 2);
          const border = (text: string) => theme.fg("borderAccent", text);
          const title = truncateToWidth(theme.bold(diagram.title), width - 5);
          const header =
            border("╭─ ") +
            title +
            border(" " + "─".repeat(width - 5 - visibleWidth(title)) + "╮");
          const framed = (text: string) =>
            border("│ ") +
            truncateToWidth(text, inner, "…", true) +
            border(" │");
          const heading =
            question === undefined
              ? []
              : wrapTextWithAnsi(theme.bold(question), inner);
          const hint = inspecting
            ? question === undefined
              ? "↑↓ scroll  ·  Esc back"
              : "↑↓ scroll  ·  Enter choose  ·  Esc back"
            : question === undefined
              ? "↑↓ browse  ·  Enter details  ·  Esc close"
              : "↑↓ browse  ·  l details  ·  Enter choose  ·  Esc cancel";
          const lead = heading.slice(0, Math.max(0, height - 5));
          const gap = lead.length > 0 ? [""] : [];
          page = Math.max(1, height - lead.length - gap.length - 3);
          let body: string[];
          if (inspecting) {
            const details = [
              ...wrapTextWithAnsi(theme.bold(node.name), inner),
              "",
              ...relationshipLines(diagram, layout, node.id, theme, inner),
            ];
            maximum = Math.max(0, details.length - page);
            scroll = Math.min(scroll, maximum);
            body = details.slice(scroll, scroll + page);
          } else if (inner >= 50) {
            const left = Math.min(45, Math.floor(inner * 0.43));
            const list = graphList(layout, selected, theme, left, page);
            const details = relationshipLines(
              diagram,
              layout,
              node.id,
              theme,
              inner - left - 3,
            ).slice(0, page);
            body = Array.from(
              { length: Math.max(list.length, details.length) },
              (_, i) =>
                truncateToWidth(list[i] ?? "", left, "", true) +
                theme.fg("border", " │ ") +
                (details[i] ?? ""),
            );
          } else {
            const list = graphList(
              layout,
              selected,
              theme,
              inner,
              Math.max(1, Math.floor(page / 2)),
            );
            const details = relationshipLines(
              diagram,
              layout,
              node.id,
              theme,
              inner,
            );
            body = [...list, "", ...details].slice(0, page);
          }
          return [
            header,
            ...[...lead, ...gap, ...body, theme.fg("muted", hint)].map(framed),
            border("╰" + "─".repeat(width - 2) + "╯"),
          ].slice(0, height);
        },
        handleInput(input: string) {
          if (
            matchesKey(input, "ctrl+c") ||
            (matchesKey(input, "escape") && !inspecting)
          ) {
            cancel();
            return;
          }
          if (matchesKey(input, "enter") && question !== undefined) {
            done(layout.rows[selected]?.task.id);
            return;
          }
          if (
            inspecting &&
            (matchesKey(input, "escape") ||
              matchesKey(input, "left") ||
              input === "h")
          ) {
            inspecting = false;
          } else if (
            matchesKey(input, "enter") ||
            matchesKey(input, "right") ||
            input === "l"
          ) {
            inspecting = true;
            scroll = 0;
          } else {
            const last = inspecting ? maximum : layout.rows.length - 1;
            let next = inspecting ? scroll : selected;
            if (matchesKey(input, "down") || input === "j") next++;
            else if (matchesKey(input, "up") || input === "k") next--;
            else if (matchesKey(input, "pageDown")) next += page;
            else if (matchesKey(input, "pageUp")) next -= page;
            else if (matchesKey(input, "home")) next = 0;
            else if (matchesKey(input, "end")) next = last;
            else return;
            next = Math.max(0, Math.min(last, next));
            if (inspecting) scroll = next;
            else selected = next;
          }
          tui.requestRender();
        },
        dispose() {
          signal?.removeEventListener("abort", cancel);
          // Pi can remove an overlay when the session changes, before a key is pressed.
          cancel();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "100%",
        margin: { top: 1, bottom: 1, left: 1, right: 1 },
      },
      ...(question === undefined
        ? {}
        : { blocked: { kind: "question", message: question } }),
    },
  );
}
