import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderDiagram, renderDiagramCanvas } from "../diagram/render.ts";
import type { Diagram, DiagramView } from "../diagram/model.ts";

const monochrome: Parameters<typeof renderDiagram>[1] = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

const architecture: Diagram = {
  title: "Parcel tracking",
  systemId: "visibility",
  nodes: [
    {
      id: "merchant",
      kind: "person",
      label: "Merchant",
      detail: "Follows a parcel.",
    },
    {
      id: "visibility",
      kind: "system",
      label: "Parcel visibility",
      detail: "Tracks a parcel across carriers.",
    },
    {
      id: "carrier",
      kind: "system",
      label: "Carrier network",
      detail: "Reports scans.",
    },
    {
      id: "api",
      kind: "container",
      label: "Tracking API",
      technology: "Go",
      detail: "Serves tracking history.",
    },
    {
      id: "worker",
      kind: "container",
      label: "Event worker",
      technology: "Rust",
      detail: "Normalizes scans.",
    },
    {
      id: "store",
      kind: "container",
      label: "Scan store",
      technology: "PostgreSQL",
      detail: "Stores parcel events.",
    },
  ],
  edges: [
    {
      from: "merchant",
      to: "api",
      label: "Looks up shipments",
      technology: "HTTPS",
    },
    {
      from: "worker",
      to: "carrier",
      label: "Fetches scans",
      technology: "HTTPS",
    },
    { from: "api", to: "store", label: "Reads history", technology: "SQL" },
    { from: "worker", to: "store", label: "Appends scans", technology: "SQL" },
  ],
};

function canvas(
  diagram: Diagram,
  view: DiagramView,
  width: number,
  selected?: string,
) {
  const result = renderDiagramCanvas(
    diagram,
    monochrome,
    view,
    selected,
    width,
  );
  return { ...result, lines: result.lines.map(stripTerminalSequences) };
}

await test("context draws people and systems with directional relationships in a 60-column terminal", () => {
  const { lines, nodeOrder } = canvas(architecture, "context", 60);
  const text = lines.join("\n");
  assert.match(text, /╭─/u);
  assert.match(text, /▼Looks up shipments/u);
  assert.match(text, /▼Fetches scans/u);
  assert.match(text, /Software system/u);
  assert.match(text, /External system/u);
  assert.doesNotMatch(text, /HTTP|Tracking API|Rust/u);
  assert.deepEqual(nodeOrder, ["merchant", "visibility", "carrier"]);
  assert.ok(lines.every((line) => visibleWidth(line) <= 60));
  assert.ok(canvas(architecture, "context", 120).lines.length < lines.length);
});

await test("containers sit inside the named boundary; verbs and protocols belong to the correct sources", () => {
  const { lines, focusLine, nodeOrder } = canvas(
    architecture,
    "container",
    60,
    "worker",
  );
  const top = lines.findIndex((line) => line.includes("┌ Parcel visibility "));
  const lastMember = lines.findIndex((line) =>
    line.includes("Container · PostgreSQL"),
  );
  const firstOutside = lines.findIndex((line) => line.includes("Merchant"));
  const lastOutside = lines.findIndex((line) =>
    line.includes("Carrier network"),
  );
  assert.ok(
    firstOutside >= 0 &&
      firstOutside < top &&
      top < focusLine &&
      focusLine < lastMember &&
      lastMember < lastOutside,
  );
  assert.match(lines[focusLine] ?? "", /┃\s*Event worker\s*┃/u);
  assert.match(
    lines.join("\n"),
    /→ Reads history · SQL\s*│.*┃\s*→ Appends scans · SQL/u,
  );
  assert.match(lines.join("\n"), /\[1\] HTTPS.*\[2\] HTTPS/u);
  assert.ok(
    lines.every(
      (line) => !/▼(Reads|Appends)/u.test(line) && visibleWidth(line) <= 60,
    ),
  );
  assert.deepEqual(nodeOrder, [
    "merchant",
    "api",
    "worker",
    "store",
    "carrier",
  ]);
  assert.equal(
    lines
      .slice(top + 1, lastMember + 1)
      .every((line) => line.trimStart().startsWith("│")),
    true,
  );
});

await test("model text is painted literally, including diagram syntax, wide characters and duplicate labels", () => {
  const diagram: Diagram = {
    title: "Literal labels",
    systemId: "a",
    nodes: [
      {
        id: "a",
        kind: "system",
        label: "API [v2]",
        detail: "Owns quoted text.",
      },
      { id: "b", kind: "person", label: "API [v2]", detail: "Uses it." },
      {
        id: "c",
        kind: "system",
        label: '中 --> "B"',
        detail: "Receives a request.",
      },
    ],
    edges: [
      { from: "b", to: "a", label: 'A --> B | "ok"' },
      { from: "a", to: "c", label: "Calls [v2]" },
    ],
  };
  const text = canvas(diagram, "context", 75).lines.join("\n");
  for (const literal of [
    'A --> B | "ok"',
    "API [v2] (a)",
    "API [v2] (b)",
    '中 --> "B"',
    "Calls [v2]",
  ])
    assert.ok(text.includes(literal), literal);
});

await test("dense architecture previews are bounded; expansion and the narrow inspector retain full relationships", () => {
  const nodes: Diagram["nodes"] = Array.from({ length: 18 }, (_, i) => ({
    id: `n${String(i)}`,
    kind: i === 0 ? "system" : "container",
    label: `Service ${String(i)}`,
    detail: `Responsibility ${String(i)}.`,
    technology: "TypeScript",
  }));
  const edges = nodes.slice(2).map((node, index) => ({
    from: `n${String(index + 1)}`,
    to: node.id,
    label: `Delivers payload ${String(index + 1)} to its subscriber`,
    technology: "gRPC",
  }));
  const dense: Diagram = {
    title: "Delivery",
    systemId: "n0",
    view: "container",
    nodes,
    edges,
  };
  const preview = renderDiagram(dense, monochrome, false).render(60);
  assert.ok(preview.length < 18);
  assert.match(preview.join(" "), /17 elements · 16 relationships/u);
  const full = renderDiagram(dense, monochrome, true)
    .render(60)
    .map(stripTerminalSequences)
    .join(" ");
  assert.match(full, /Delivers payload 16/u);
  assert.match(full, /Responsibility 17/u);
  const narrow = canvas(dense, "container", 12, "n16");
  assert.equal(narrow.nodeOrder.length, 17);
  assert.match(narrow.lines[narrow.focusLine] ?? "", /▸/u);
  assert.ok(narrow.lines.every((line) => visibleWidth(line) <= 12));
  assert.match(narrow.lines.join(" "), /gRPC/u);
  assert.deepEqual(canvas(dense, "container", 0).lines, []);
});

await test("a parallel relationship or cycle keeps each verb even if the layout shares its connectors", () => {
  const graph: Diagram = {
    ...architecture,
    edges: [
      { from: "merchant", to: "visibility", label: "Reviews history" },
      { from: "merchant", to: "visibility", label: "Creates label" },
      { from: "visibility", to: "merchant", label: "Sends status" },
      { from: "visibility", to: "visibility", label: "Recalculates" },
    ],
  };
  const text = canvas(graph, "context", 80).lines.join("\n");
  for (const label of [
    "Reviews history",
    "Creates label",
    "Sends status",
    "Recalculates",
  ])
    assert.ok(text.includes(label), label);
});
