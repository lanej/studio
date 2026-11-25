import { selectorText } from "@lanej/pi-components";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const id = Type.String({ pattern: "^[a-zA-Z0-9_-]{1,40}$" });
const text = (maxLength: number, description?: string) =>
  Type.String({
    minLength: 1,
    maxLength,
    ...(description === undefined ? {} : { description }),
  });
const strict = { additionalProperties: false };
const viewParameter = Type.Union([
  Type.Literal("context"),
  Type.Literal("container"),
]);

export const diagramParameters = Type.Object(
  {
    title: text(120),
    systemId: Type.String({
      ...id,
      description:
        "ID of the software system in scope. All container nodes belong to this system.",
    }),
    view: Type.Optional(viewParameter),
    nodes: Type.Array(
      Type.Object(
        {
          id,
          kind: Type.Union([
            Type.Literal("person"),
            Type.Literal("system"),
            Type.Literal("container"),
          ]),
          label: text(100),
          detail: text(
            1000,
            "The role of this person or the responsibility of this software system, application or data store.",
          ),
          technology: Type.Optional(
            text(100, "Technology used by a container, when known."),
          ),
        },
        strict,
      ),
      { minItems: 1, maxItems: 24 },
    ),
    edges: Type.Array(
      Type.Object(
        {
          from: id,
          to: id,
          label: text(
            100,
            "A verb phrase describing what the source does with the target.",
          ),
          technology: Type.Optional(
            text(
              100,
              "Protocol, API, event or data format used by this relationship, when known.",
            ),
          ),
        },
        strict,
      ),
      { maxItems: 48 },
    ),
    question: Type.Optional(
      text(
        240,
        "Ask the user to choose an architectural element. Omit for an explanation.",
      ),
    ),
  },
  strict,
);

export type Diagram = Static<typeof diagramParameters>;
export type DiagramView = Static<typeof viewParameter>;
type Node = Diagram["nodes"][number];
type Edge = Diagram["edges"][number];

export function diagramNodeLabel(diagram: Diagram, node: Node): string {
  return diagram.nodes.some(
    (other) => other.id !== node.id && other.label === node.label,
  )
    ? `${node.label} (${node.id})`
    : node.label;
}

function plain(value: string): string {
  const cleaned = selectorText(value)
    .replace(/\p{Bidi_Control}/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (cleaned.length === 0)
    throw new Error("Diagram text must contain visible characters");
  return cleaned;
}

function technology(item: { technology?: string }) {
  return item.technology === undefined
    ? {}
    : { technology: plain(item.technology) };
}

function focalSystem(diagram: Diagram): Node {
  const system = diagram.nodes.find((node) => node.id === diagram.systemId);
  if (system?.kind !== "system")
    throw new Error("systemId must identify the software system in scope");
  return system;
}

export function initialView(diagram: Diagram): DiagramView {
  return diagram.view ?? "context";
}

export function parseDiagram(input: unknown): Diagram {
  if (!Check(diagramParameters, input))
    throw new Error(
      "Expected a C4 architecture with systemId, typed elements with responsibilities, and labeled relationships",
    );
  focalSystem(input);
  const ids = new Set<string>();
  const nodes = input.nodes.map((node) => {
    if (ids.has(node.id))
      throw new Error(`Duplicate diagram node ID: ${node.id}`);
    ids.add(node.id);
    return {
      id: node.id,
      kind: node.kind,
      label: plain(node.label),
      detail: plain(node.detail),
      ...technology(node),
    };
  });
  const containers = new Set(
    nodes.filter((n) => n.kind === "container").map((n) => n.id),
  );
  if (input.view === "container" && containers.size === 0)
    throw new Error(
      "A container view needs at least one application or data store inside the system",
    );
  const edges = input.edges.map((edge) => {
    for (const endpoint of [edge.from, edge.to])
      if (!ids.has(endpoint))
        throw new Error(`Unknown diagram node ID: ${endpoint}`);
    if (
      (edge.from === input.systemId && containers.has(edge.to)) ||
      (edge.to === input.systemId && containers.has(edge.from))
    )
      throw new Error(
        "Describe interactions between containers or with external elements. Containment is already expressed by systemId.",
      );
    return {
      from: edge.from,
      to: edge.to,
      label: plain(edge.label),
      ...technology(edge),
    };
  });
  return {
    ...input,
    title: plain(input.title),
    nodes,
    edges,
    ...(input.question === undefined
      ? {}
      : { question: plain(input.question) }),
  };
}

// A declared system-level relationship takes precedence over the concrete
// connections it summarizes. Compare ordered endpoints so that callbacks in
// the reverse direction remain visible.
function contextEdges(diagram: Diagram, containers: Set<string>): Edge[] {
  const isContext = (edge: Edge) =>
    !containers.has(edge.from) && !containers.has(edge.to);
  const explicit = diagram.edges.filter(isContext);
  const summarized = new Set(explicit.map((edge) => `${edge.from}/${edge.to}`));
  const result: Edge[] = explicit.map(({ from, to, label }) => ({
    from,
    to,
    label,
  }));
  for (const edge of diagram.edges) {
    if (isContext(edge)) continue;
    const from = containers.has(edge.from) ? diagram.systemId : edge.from;
    const to = containers.has(edge.to) ? diagram.systemId : edge.to;
    if (from === to || summarized.has(`${from}/${to}`)) continue;
    if (
      !result.some(
        (other) =>
          other.from === from && other.to === to && other.label === edge.label,
      )
    )
      result.push({ from, to, label: edge.label });
  }
  return result;
}

export function diagramProjection(diagram: Diagram, view: DiagramView) {
  const system = focalSystem(diagram);
  const containers = new Set(
    diagram.nodes.filter((n) => n.kind === "container").map((n) => n.id),
  );
  if (view === "context")
    return {
      system,
      nodes: diagram.nodes.filter((n) => n.kind !== "container"),
      edges: contextEdges(diagram, containers),
    };

  // A context-only dependency has no known container endpoint. Zooming in
  // must not assign it to an arbitrary application.
  const neighbors = new Set<string>();
  for (const edge of diagram.edges) {
    if (containers.has(edge.from)) neighbors.add(edge.to);
    if (containers.has(edge.to)) neighbors.add(edge.from);
  }
  const nodes = diagram.nodes.filter(
    (n) => n.kind === "container" || neighbors.has(n.id),
  );
  const visible = new Set(nodes.map((n) => n.id));
  return {
    system,
    nodes,
    edges: diagram.edges.filter(
      (e) => visible.has(e.from) && visible.has(e.to),
    ),
  };
}
