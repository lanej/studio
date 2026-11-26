import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { diagramNodeLabel, diagramProjection, initialView, type Diagram, type DiagramView } from "./model.ts";
import { renderDiagramCanvas } from "./render.ts";

type Node = Diagram["nodes"][number];
type Projection = ReturnType<typeof diagramProjection>;

const kindLabel = {
  person: "Person",
  system: "Software system",
  container: "Container",
};

function elementDetails(diagram: Diagram, projection: Projection, node: Node, theme: Theme, width: number): string[] {
  const label = diagramNodeLabel(diagram, node);
  const kind = [kindLabel[node.kind], node.kind === "container" ? node.technology : undefined]
    .filter(Boolean)
    .join(" · ");
  const connections: string[] = [];
  for (const edge of projection.edges) {
    if (edge.from !== node.id && edge.to !== node.id) continue;
    const outgoing = edge.from === node.id;
    const otherId = outgoing ? edge.to : edge.from;
    const other = projection.nodes.find((item) => item.id === otherId);
    const name = !other ? otherId : diagramNodeLabel(diagram, other);
    const arrow = edge.from === edge.to ? "↻" : outgoing ? "→" : "←";
    const protocol = edge.technology === undefined ? "" : " · " + theme.fg("syntaxString", edge.technology);
    connections.push(...wrapTextWithAnsi(`${theme.fg("accent", arrow)} ${name} · ${edge.label}${protocol}`, width));
  }
  return [
    ...wrapTextWithAnsi(theme.bold(label) + theme.fg("muted", "  " + kind), width),
    ...wrapTextWithAnsi(node.detail, width),
    ...(connections.length === 0 ? [] : ["", ...connections]),
  ];
}

function canvasWindow(lines: string[], focusLine: number, rows: number) {
  const start = Math.max(0, Math.min(focusLine - Math.floor(rows / 2), lines.length - rows));
  return lines.slice(start, start + rows);
}

export async function inspectDiagram(
  ctx: ExtensionContext,
  diagram: Diagram,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!ctx.hasUI || signal?.aborted === true) return undefined;
  let view = initialView(diagram);
  const firstContainer = diagram.nodes.find((node) => node.kind === "container");
  const selected: Record<DiagramView, string> = {
    context: diagram.systemId,
    container: firstContainer?.id ?? diagram.systemId,
  };
  let projection = diagramProjection(diagram, view);
  let nodeOrder = projection.nodes.map((node) => node.id);
  const question = diagram.question;
  return ctx.ui.custom<string | undefined>(
    (tui, theme, _keys, done) => {
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
          const node = projection.nodes.find((item) => item.id === selected[view]);
          if (!node || width < 6) return [];
          const inner = width - 4;
          const height = Math.max(1, tui.terminal.rows - 2);
          const border = (text: string) => theme.fg("borderAccent", text);
          const title = truncateToWidth(theme.bold(diagram.title), width - 5);
          const header = border("╭─ ") + title + border(" " + "─".repeat(width - 5 - visibleWidth(title)) + "╮");
          const framed = (text: string) => border("│ ") + truncateToWidth(text, inner, "…", true) + border(" │");
          const tab = (id: DiagramView, name: string) =>
            view === id ? theme.bold(`▸ ${name}`) : theme.fg("muted", name);
          const tabs = !firstContainer
            ? theme.bold("System context")
            : tab("context", "System context") + "    " + tab("container", "Containers");
          const prompt = question === undefined ? [] : wrapTextWithAnsi(theme.bold(question), inner);
          const lead = [tabs, ...prompt.slice(0, Math.max(0, height - 6))];
          page = Math.max(1, height - lead.length - 3);
          let body: string[];
          if (inspecting) {
            const details = elementDetails(diagram, projection, node, theme, inner);
            maximum = Math.max(0, details.length - page);
            scroll = Math.min(scroll, maximum);
            body = details.slice(scroll, scroll + page);
          } else {
            const canvas = renderDiagramCanvas(diagram, theme, view, node.id, inner);
            nodeOrder = canvas.nodeOrder;
            const graph = canvasWindow(canvas.lines, canvas.focusLine, page);
            // Give the canvas its full width first. A side pane is useful only
            // when it leaves every box, arrow, and system boundary intact.
            const graphWidth = Math.max(
              0,
              ...canvas.lines.map((line) => visibleWidth(stripTerminalSequences(line).trimEnd())),
            );
            const sideWidth = inner - graphWidth - 3;
            if (sideWidth >= 26) {
              const details = elementDetails(diagram, projection, node, theme, sideWidth);
              body = Array.from(
                {
                  length: Math.min(page, Math.max(graph.length, details.length)),
                },
                (_, i) =>
                  truncateToWidth(graph[i] ?? "", graphWidth, "", true) +
                  theme.fg("border", " │ ") +
                  (details[i] ?? ""),
              );
            } else {
              const room = page - graph.length - 1;
              body =
                room < 2
                  ? graph
                  : [
                      ...graph,
                      theme.fg("border", "─".repeat(inner)),
                      ...elementDetails(diagram, projection, node, theme, inner).slice(0, room),
                    ];
            }
          }
          const action = question === undefined ? (inspecting ? "" : "Enter details") : "Enter choose";
          const hint = [
            action,
            inner < 60 ? "↑↓" : inspecting ? "↑↓ scroll" : "↑↓ browse",
            ...(!inspecting && question !== undefined ? ["l details"] : []),
            ...(!firstContainer ? [] : ["Tab zoom"]),
            inspecting ? "Esc back" : question === undefined ? "Esc close" : "Esc cancel",
          ]
            .filter(Boolean)
            .join(" · ");
          return [
            header,
            ...[...lead, ...body, theme.fg("muted", hint)].map(framed),
            border("╰" + "─".repeat(width - 2) + "╯"),
          ].slice(0, height);
        },
        handleInput(input: string) {
          if (matchesKey(input, "ctrl+c") || (matchesKey(input, "escape") && !inspecting)) {
            cancel();
            return;
          }
          if (matchesKey(input, "enter") && question !== undefined) {
            done(selected[view]);
            return;
          }
          if ((matchesKey(input, "tab") || matchesKey(input, "shift+tab")) && firstContainer) {
            view = view === "context" ? "container" : "context";
            projection = diagramProjection(diagram, view);
            nodeOrder = projection.nodes.map((item) => item.id);
            inspecting = false;
          } else if (inspecting && (matchesKey(input, "escape") || matchesKey(input, "left") || input === "h")) {
            inspecting = false;
          } else if (matchesKey(input, "enter") || matchesKey(input, "right") || input === "l") {
            inspecting = true;
            scroll = 0;
          } else {
            const last = inspecting ? maximum : nodeOrder.length - 1;
            let next = inspecting ? scroll : nodeOrder.indexOf(selected[view]);
            if (matchesKey(input, "down") || input === "j") next++;
            else if (matchesKey(input, "up") || input === "k") next--;
            else if (matchesKey(input, "pageDown")) next += page;
            else if (matchesKey(input, "pageUp")) next -= page;
            else if (matchesKey(input, "home")) next = 0;
            else if (matchesKey(input, "end")) next = last;
            else return;
            next = Math.max(0, Math.min(last, next));
            if (inspecting) scroll = next;
            else selected[view] = nodeOrder[next] ?? selected[view];
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
      ...(question === undefined ? {} : { blocked: { kind: "question", message: question } }),
    },
  );
}
