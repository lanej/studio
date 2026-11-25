import { keyText, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { planGraph, planGraphColor, renderGraphPrefix } from "../plan-graph.ts";
import { diagramNodeLabel, type Diagram } from "./model.ts";

type Edge = Diagram["edges"][number];

export function diagramLayout(diagram: Diagram) {
  const nodes = diagram.nodes.map((node) => ({
    ...node,
    key: node.id,
    name: diagramNodeLabel(diagram, node),
    outgoing: diagram.edges.filter((edge) => edge.from === node.id),
    blockedBy: new Set<string>(),
  }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  const ancestors = new Set<string>();
  const returns = new Set<Edge>();

  // Rails run down the page. An edge back to an ancestor gets an explicit
  // return arrow on its source, leaving an acyclic graph for the rail layout.
  function visit(node: (typeof nodes)[number]) {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    ancestors.add(node.id);
    for (const edge of node.outgoing) {
      const target = byId.get(edge.to);
      if (target === undefined) throw new Error(`Unknown node ${edge.to}`);
      if (ancestors.has(target.id)) returns.add(edge);
      else {
        target.blockedBy.add(node.id);
        visit(target);
      }
    }
    ancestors.delete(node.id);
  }
  for (const node of nodes) visit(node);
  const rows = planGraph(
    nodes.map((node) => ({ ...node, blockedBy: [...node.blockedBy] })),
  );
  // A single incoming edge can carry its caption at the destination. At a
  // join the source must name its target to disambiguate the relationship.
  const arrival = new Map<string, string>();
  for (const { id } of nodes) {
    const incoming = diagram.edges.filter((edge) => edge.to === id);
    const [edge] = incoming;
    if (
      incoming.length === 1 &&
      edge?.label !== undefined &&
      !returns.has(edge)
    )
      arrival.set(id, edge.label);
  }
  return { rows, byId, returns, arrival };
}

export function renderDiagram(
  diagram: Diagram,
  theme: Pick<Theme, "fg" | "bold">,
  expanded: boolean,
): Component {
  const { rows, byId, returns, arrival } = diagramLayout(diagram);
  const color = planGraphColor(theme);
  const railWidth = rows[0]?.prefix.length ?? 0;

  function fit(text: string, width: number) {
    return expanded
      ? wrapTextWithAnsi(text, width)
      : [truncateToWidth(text, width, "…")];
  }

  function renderNode(
    row: (typeof rows)[number],
    width: number,
    rails: boolean,
  ) {
    const { task, prefix } = row;
    const marker = rails ? renderGraphPrefix(prefix, color) + "  " : "";
    const continues = task.outgoing.some((edge) => !returns.has(edge));
    const lane = prefix.find((cell) => cell.glyph === "●")?.lane ?? 0;
    const guide = rails
      ? renderGraphPrefix(prefix, color, continues ? color(lane, "│") : " ") +
        "  "
      : "";

    const bodyWidth = width - visibleWidth(marker);
    const caption = rails && !expanded ? arrival.get(task.id) : undefined;
    const title =
      theme.fg("text", task.name) +
      (caption === undefined ? "" : theme.fg("syntaxString", `  · ${caption}`));
    const lines = fit(title, bodyWidth).map(
      (line, i) => (i === 0 ? marker : guide) + line,
    );
    const indent = bodyWidth > 6 ? "  " : "";
    function annotate(text: string) {
      for (const line of fit(text, bodyWidth - indent.length))
        lines.push(guide + indent + line);
    }

    if (expanded && task.detail !== undefined)
      annotate(theme.fg("text", task.detail));
    const transitions = task.outgoing.filter(
      (edge) =>
        expanded ||
        !rails ||
        returns.has(edge) ||
        (edge.label !== undefined && !arrival.has(edge.to)),
    );
    for (const edge of expanded ? transitions : transitions.slice(0, 2)) {
      const target = byId.get(edge.to)?.name ?? edge.to;
      const condition =
        edge.label === undefined
          ? ""
          : theme.fg("syntaxString", edge.label) + " ";
      const arrow = theme.fg("muted", returns.has(edge) ? "↺ " : "→ ");
      annotate(condition + arrow + target);
    }
    if (!expanded && transitions.length > 2)
      annotate(
        theme.fg(
          "muted",
          `+${String(transitions.length - 2)} more transitions`,
        ),
      );
    return lines;
  }

  return {
    invalidate() {},
    render(width) {
      if (width < 1) return [];
      const lines = fit(
        theme.fg("toolTitle", theme.bold(diagram.title)),
        width,
      );
      // Once rails crowd out labels, switch to explicit directed transitions.
      const rails = width >= railWidth + 12;
      let connectors: string[] = [];
      let shown = 0;
      for (const row of rows) {
        const nodeLines = renderNode(row, width, rails);
        if (
          !expanded &&
          shown > 0 &&
          lines.length + connectors.length + nodeLines.length > 15
        )
          break;
        lines.push(...connectors, ...nodeLines);
        connectors = rails
          ? row.connectors.map((line) =>
              renderGraphPrefix(line, color).trimEnd(),
            )
          : [];
        shown++;
      }
      const hints: string[] = [];
      const more = rows.length - shown;
      if (more > 0)
        hints.push(`+${String(more)} more ${more === 1 ? "node" : "nodes"}`);
      const shortcut = keyText("app.tools.expand");
      if (!expanded && shortcut !== "") hints.push(`${shortcut} for details`);
      if (diagram.question === undefined) hints.push("/diagram to inspect");
      if (hints.length > 0) lines.push(theme.fg("muted", hints.join(" · ")));
      return lines.map((line) => truncateToWidth(line, width, "…"));
    },
  };
}
