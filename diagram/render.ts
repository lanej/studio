import {
  keyText,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { render, type MermaidArt } from "lovely-mermaid";
import {
  diagramNodeLabel,
  diagramProjection,
  initialView,
  type Diagram,
  type DiagramView,
} from "./model.ts";

type ThemeInk = Pick<Theme, "fg" | "bold">;
type Node = Diagram["nodes"][number];
type Edge = Diagram["edges"][number];

interface Canvas {
  lines: string[];
  focusLine: number;
  nodeOrder: string[];
}

function kindLabel(node: Node, focal: string): string {
  if (node.kind === "person") return "Person";
  if (node.kind === "system")
    return node.id === focal ? "Software system" : "External system";
  return node.technology === undefined
    ? "Container"
    : `Container · ${node.technology}`;
}

function nodeColor(node: Node, focal: string): ThemeColor {
  if (node.kind === "person") return "syntaxString";
  if (node.kind === "system" && node.id !== focal) return "syntaxNumber";
  return "accent";
}

function verb(edge: Edge) {
  return edge.technology === undefined
    ? edge.label
    : `${edge.label} · ${edge.technology}`;
}

function edgeText(edge: Edge, names: Map<string, string>) {
  return `${names.get(edge.from) ?? edge.from} → ${names.get(edge.to) ?? edge.to}  ·  ${verb(edge)}`;
}

const wrap = (text: string, width: number) =>
  wrapTextWithAnsi(text, Math.max(1, width)).map((line) =>
    visibleWidth(line) > width
      ? truncateToWidth(line, width, "…")
      : line.trimEnd(),
  );

function relationshipMap(diagram: Diagram, view: DiagramView) {
  const projection = diagramProjection(diagram, view);
  const { nodes, system, edges } = projection;
  const names = new Map(
    nodes.map((node) => [node.id, diagramNodeLabel(diagram, node)]),
  );
  const keys = new Map(
    nodes.map((node, index) => [node.id, `N${String(index)}`]),
  );
  const members = new Set(
    nodes.filter((node) => node.kind === "container").map((node) => node.id),
  );
  // A crossing edge lands on the subgraph frame. Its numbered port appears on
  // the specific container behind that boundary as well as on the connector.
  const ports = new Map<string, string[]>();
  const departures = new Map<string, string[]>();
  // A boundary crossing shares the outer diagram's destination port with
  // other edges entering that frame. Internal destinations are separate.
  function drawnTarget(edge: Edge) {
    return !members.has(edge.from) && members.has(edge.to)
      ? "#boundary"
      : edge.to;
  }
  const routes = edges.map((edge, i) => {
    let port = "";
    if (members.has(edge.from) !== members.has(edge.to)) {
      const owner = members.has(edge.from) ? edge.from : edge.to;
      port = `[${String(i + 1)}]`;
      const endpoint =
        edge.technology === undefined ? port : `${port} ${edge.technology}`;
      ports.set(owner, [...(ports.get(owner) ?? []), endpoint]);
    }
    // Shared stems cannot carry a source-specific verb. Put the action on its
    // source when there's only one local destination, or spell out both ends.
    const local = port === "";
    const joins = edges.some(
      (other) => other !== edge && drawnTarget(other) === drawnTarget(edge),
    );
    const atSource =
      local &&
      joins &&
      edges.filter(
        (other) =>
          other.from === edge.from &&
          members.has(other.to) === members.has(edge.to),
      ).length === 1;
    if (atSource) departures.set(edge.from, [`→ ${verb(edge)}`]);
    const caption = local ? verb(edge) : `${port} ${edge.label}`;
    const compact = visibleWidth(caption) + 1 > 28;
    // Reserve one column between the arrowhead and its caption.
    const label = " " + (compact ? `[${String(i + 1)}]` : caption);
    // Only fixed-width placeholders enter the diagram grammar. The renderer
    // replaces entire parsed spans, so punctuation in model text stays literal.
    const symbol =
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".charAt(i);
    return {
      edge,
      compact,
      port,
      label,
      neutral: joins,
      atSource,
      token: symbol.repeat(Math.max(1, visibleWidth(label))),
    };
  });
  const boxes = nodes.map((node, index) => {
    const name = names.get(node.id) ?? node.label;
    const nameLines = wrap(name, 24).map(stripTerminalSequences);
    const meta = [
      kindLabel(node, system.id),
      (ports.get(node.id) ?? []).join("   "),
      ...(departures.get(node.id) ?? []),
    ].filter((line) => line !== "");
    const lines = [
      ...nameLines,
      ...meta.flatMap((line) => wrap(line, 24).map(stripTerminalSequences)),
    ];
    // lovely-mermaid wraps at 24 columns and paints up to four lines per box.
    // Two tokens of 12 cells plus their separator always occupy separate lines.
    const width = Math.max(12, ...lines.map(visibleWidth));
    const placeholder = lines
      .map((_, i) => String.fromCharCode(65 + i).repeat(width))
      .join(" ");
    const key = `N${String(index)}`;
    const shape =
      node.kind === "person" ? `(${placeholder})` : `[${placeholder}]`;
    return {
      node,
      key,
      lines,
      nameLines: nameLines.length,
      declaration: `${key}${shape}:::${key}`,
    };
  });
  const boundary = diagramNodeLabel(diagram, system);
  const body = boxes
    .filter((box) => box.node.kind !== "container")
    .map((box) => box.declaration);
  if (view === "container") {
    body.push(
      `subgraph boundary[${"G".repeat(visibleWidth(boundary))}]`,
      ...boxes
        .filter((box) => box.node.kind === "container")
        .map((box) => box.declaration),
      "end",
    );
  }
  for (const route of routes)
    body.push(
      `${keys.get(route.edge.from) ?? ""} -->${route.neutral ? "" : `|${route.token}|`} ${keys.get(route.edge.to) ?? ""}`,
    );
  return {
    projection,
    names,
    routes,
    boxes,
    boundary,
    source: body.join("\n"),
  };
}

type ArchitectureMap = ReturnType<typeof relationshipMap>;

const heavyLines = new Map(
  Object.entries({
    "┌": "┏",
    "┐": "┓",
    "└": "┗",
    "┘": "┛",
    "╭": "┏",
    "╮": "┓",
    "╰": "┗",
    "╯": "┛",
    "─": "━",
    "│": "┃",
    "├": "┣",
    "┤": "┫",
    "┬": "┳",
    "┴": "┻",
  }),
);

function paintArt(
  art: MermaidArt,
  map: ArchitectureMap,
  theme: ThemeInk,
  selectedId: string | undefined,
  width: number,
): Canvas {
  const order = new Set<string>();
  const labeled = new Set<Edge>();
  let focusLine = 0;
  const lines = art.styled.map((row, y) =>
    row
      .map((span) => {
        const key = span.classes?.[0];
        const box =
          key === undefined
            ? undefined
            : map.boxes.find((item) => item.key === key);
        if (box !== undefined) {
          const node = box.node;
          const selected = node.id === selectedId;
          if (span.role === "text") {
            const i = span.text.charCodeAt(0) - 65;
            const text = box.lines[i] ?? "";
            const padding = Math.max(0, span.text.length - visibleWidth(text));
            const inset = Math.floor(padding / 2);
            if (i === 0) {
              order.add(node.id);
              if (selected) focusLine = y;
            }
            const ink =
              i < box.nameLines
                ? theme.bold(theme.fg("text", text))
                : theme.fg(nodeColor(node, map.projection.system.id), text);
            return " ".repeat(inset) + ink + " ".repeat(padding - inset);
          }
          if (span.role === "border") {
            const border = selected
              ? span.text.replace(
                  /[┌┐└┘╭╮╰╯─│├┤┬┴]/gu,
                  (c) => heavyLines.get(c) ?? c,
                )
              : span.text;
            return theme.fg(
              selected ? "warning" : nodeColor(node, map.projection.system.id),
              border,
            );
          }
        }
        if (span.role === "edgeLabel") {
          // The engine may overlay or shorten captions at crowded joins. Never
          // infer a missing character or leave layout tokens in the finished view.
          const caption = span.text.replace(/([a-zA-Z])\1*/gu, (token) => {
            const route = map.routes.find((item) => item.token === token);
            if (route === undefined) return " ".repeat(token.length);
            labeled.add(route.edge);
            return route.label;
          });
          return theme.fg("text", caption);
        }
        if (span.role === "text")
          return theme.bold(
            theme.fg(
              "accent",
              span.text.replace(/G+/gu, () => map.boundary),
            ),
          );
        if (span.role === "edge") return theme.fg("muted", span.text);
        if (span.role === "border") return theme.fg("accent", span.text);
        return span.text;
      })
      .join("")
      .trimEnd(),
  );

  if (order.size !== map.boxes.length)
    return groupedList(map, theme, selectedId, width);
  for (const [i, route] of map.routes.entries()) {
    if (!route.atSource && (route.compact || !labeled.has(route.edge))) {
      const id =
        route.compact || route.port !== "" ? `[${String(i + 1)}] ` : "";
      lines.push(
        ...wrap(theme.fg("text", id + edgeText(route.edge, map.names)), width),
      );
    }
  }
  return { lines, focusLine, nodeOrder: [...order] };
}

function groupedList(
  map: ArchitectureMap,
  theme: ThemeInk,
  selectedId: string | undefined,
  width: number,
): Canvas {
  const { nodes, edges, system } = map.projection;
  const lines: string[] = [];
  const nodeOrder: string[] = [];
  let focusLine = 0;
  function append(node: Node, inside: boolean) {
    const frame = inside && width >= 8;
    const room = frame ? width - 4 : width;
    const rows = [
      ...wrap(
        theme.bold(
          theme.fg(
            nodeColor(node, system.id),
            (node.id === selectedId ? "▸ " : "") +
              (map.names.get(node.id) ?? node.label),
          ),
        ),
        room,
      ),
      ...wrap(theme.fg("muted", kindLabel(node, system.id)), room),
      ...edges
        .filter((edge) => edge.from === node.id)
        .flatMap((edge) =>
          wrap(
            `${theme.fg("text", verb(edge))} → ${map.names.get(edge.to) ?? edge.to}`,
            room,
          ),
        ),
    ];
    nodeOrder.push(node.id);
    if (node.id === selectedId) focusLine = lines.length;
    for (const row of rows)
      lines.push(
        frame
          ? theme.fg("accent", "│ ") +
              row +
              " ".repeat(Math.max(0, room - visibleWidth(row))) +
              theme.fg("accent", " │")
          : row,
      );
  }
  for (const node of nodes.filter((n) => n.kind !== "container"))
    append(node, false);
  const containers = nodes.filter((n) => n.kind === "container");
  if (containers.length > 0) {
    lines.push(...wrap(theme.bold(theme.fg("accent", map.boundary)), width));
    if (width >= 8)
      lines.push(theme.fg("accent", "┌" + "─".repeat(width - 2) + "┐"));
    for (const node of containers) append(node, true);
    if (width >= 8)
      lines.push(theme.fg("accent", "└" + "─".repeat(width - 2) + "┘"));
  }
  return { lines, focusLine, nodeOrder };
}

function prepare(diagram: Diagram, view: DiagramView) {
  const map = relationshipMap(diagram, view);
  const supported =
    map.boxes.every((box) => box.lines.length <= 4) &&
    (view !== "container" || visibleWidth(map.boundary) <= 24);
  const arts = supported
    ? ["LR", "TD"].flatMap((dir) => {
        const art = render(`flowchart ${dir}\n${map.source}`);
        return art === null || art.warnings.length > 0 ? [] : [art];
      })
    : [];
  return { map, arts };
}

// Resizing and keyboard focus change frequently. Each immutable tool payload
// needs only the two orientations for each of its two architecture views.
const layouts = new WeakMap<
  Diagram,
  Partial<Record<DiagramView, ReturnType<typeof prepare>>>
>();

export function renderDiagramCanvas(
  diagram: Diagram,
  theme: ThemeInk,
  view: DiagramView,
  selectedId: string | undefined,
  width: number,
): Canvas {
  if (width < 1) return { lines: [], focusLine: 0, nodeOrder: [] };
  let views = layouts.get(diagram);
  if (views === undefined) {
    views = {};
    layouts.set(diagram, views);
  }
  const { map, arts } = (views[view] ??= prepare(diagram, view));
  const art = arts
    .filter((a) => a.width <= width)
    .sort((a, b) => a.plain.length - b.plain.length)[0];
  return art === undefined
    ? groupedList(map, theme, selectedId, width)
    : paintArt(art, map, theme, selectedId, width);
}

export function renderDiagram(
  diagram: Diagram,
  theme: ThemeInk,
  expanded: boolean,
  view: DiagramView = initialView(diagram),
  selectedId?: string,
): Component {
  return {
    invalidate() {},
    render(width) {
      if (width < 1) return [];
      const { nodes, edges, system } = diagramProjection(diagram, view);
      const heading = theme.bold(theme.fg("toolTitle", diagram.title));
      const kind = theme.fg(
        "muted",
        view === "context" ? "System context" : "Containers",
      );
      const canvas = renderDiagramCanvas(
        diagram,
        theme,
        view,
        selectedId,
        width,
      );
      const lines = [...wrap(heading + "   " + kind, width), ""];
      if (!expanded && canvas.lines.length > 28) {
        const names = new Map(
          nodes.map((node) => [node.id, diagramNodeLabel(diagram, node)]),
        );
        lines.push(
          ...wrap(
            `${system.label} · ${String(nodes.length)} elements · ${String(edges.length)} relationships`,
            width,
          ),
        );
        for (const edge of edges.slice(0, 3)) {
          const text = wrap(edgeText(edge, names), width);
          if (lines.length + text.length > 12) break;
          lines.push(...text);
        }
        lines.push(
          ...wrap(
            theme.fg("muted", "Expand to see the full architecture."),
            width,
          ),
        );
      } else lines.push(...canvas.lines);
      if (expanded) {
        for (const node of nodes)
          lines.push(
            "",
            ...wrap(theme.bold(diagramNodeLabel(diagram, node)), width),
            ...wrap(node.detail, width),
          );
      }
      const hints = [];
      if (!expanded) {
        const key = keyText("app.tools.expand");
        if (key !== "") hints.push(`${key} for details`);
      }
      if (diagram.question === undefined) hints.push("/diagram to inspect");
      if (hints.length > 0)
        lines.push(...wrap(theme.fg("muted", hints.join(" · ")), width));
      return lines;
    },
  };
}
