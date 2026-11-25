import { selectorText } from "@lanej/pi-components";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const id = Type.String({ pattern: "^[a-zA-Z0-9_-]{1,40}$" });
const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const strict = { additionalProperties: false };

export const diagramParameters = Type.Object(
  {
    title: text(120),
    nodes: Type.Array(
      Type.Object(
        { id, label: text(100), detail: Type.Optional(text(1000)) },
        strict,
      ),
      { minItems: 1, maxItems: 24 },
    ),
    edges: Type.Array(
      Type.Object(
        { from: id, to: id, label: Type.Optional(text(100)) },
        strict,
      ),
      { maxItems: 48 },
    ),
    question: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 240,
        description:
          "Ask the user to choose one of the nodes. Omit for an explanation.",
      }),
    ),
  },
  strict,
);

export type Diagram = Static<typeof diagramParameters>;

export function diagramNodeLabel(
  diagram: Diagram,
  node: Diagram["nodes"][number],
): string {
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

export function parseDiagram(input: unknown): Diagram {
  if (!Check(diagramParameters, input))
    throw new Error(
      "Expected a diagram title, 1–24 nodes with IDs and labels, and up to 48 directed edges",
    );

  const ids = new Set<string>();
  const nodes = input.nodes.map(({ id, label, detail }) => {
    if (ids.has(id)) throw new Error(`Duplicate diagram node ID: ${id}`);
    ids.add(id);
    return {
      id,
      label: plain(label),
      ...(detail === undefined ? {} : { detail: plain(detail) }),
    };
  });
  const edges = input.edges.map(({ from, to, label }) => {
    for (const endpoint of [from, to])
      if (!ids.has(endpoint))
        throw new Error(`Unknown diagram node ID: ${endpoint}`);
    return {
      from,
      to,
      ...(label === undefined ? {} : { label: plain(label) }),
    };
  });
  return {
    title: plain(input.title),
    nodes,
    edges,
    ...(input.question === undefined
      ? {}
      : { question: plain(input.question) }),
  };
}
