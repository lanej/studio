import assert from "node:assert/strict";
import { test } from "node:test";
import { diagramNodeLabel, parseDiagram } from "../diagram/model.ts";

const nodes = [
  { id: "start", label: "Review", detail: "Before implementation" },
  { id: "end", label: "Review" },
];

await test("diagram IDs uniquely identify endpoints even when display labels match", () => {
  const edges = [
    { from: "start", to: "end" },
    { from: "end", to: "end", label: "Retry" },
  ];
  const diagram = parseDiagram({ title: "Review", nodes, edges });
  assert.deepEqual(diagram.edges, edges);
  assert.deepEqual(
    diagram.nodes.map((node) => diagramNodeLabel(diagram, node)),
    ["Review (start)", "Review (end)"],
  );
  assert.throws(
    () => parseDiagram({ ...diagram, nodes: [...nodes, nodes[0]] }),
    /Duplicate diagram node ID: start/,
  );
  assert.throws(
    () =>
      parseDiagram({ ...diagram, edges: [{ from: "start", to: "absent" }] }),
    /Unknown diagram node ID: absent/,
  );
});

await test("diagram text is bounded and rendered as terminal-safe plain text", () => {
  const diagram = parseDiagram({
    title: "  \x1b[31mReview\x1b[0m\u202e",
    nodes,
    edges: [],
  });
  assert.equal(diagram.title, "Review");
  assert.throws(
    () => parseDiagram({ ...diagram, question: "   " }),
    /visible characters/,
  );
  assert.throws(() =>
    parseDiagram({
      ...diagram,
      nodes: Array.from({ length: 25 }, (_, i) => ({
        id: String(i),
        label: "Step",
      })),
    }),
  );
});
