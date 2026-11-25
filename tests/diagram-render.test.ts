import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderDiagram } from "../diagram/render.ts";
import type { Diagram } from "../diagram/model.ts";

const monochrome: Parameters<typeof renderDiagram>[1] = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

const fork: Diagram = {
  title: "Release decision",
  nodes: [
    { id: "review", label: "Review" },
    { id: "revise", label: "Revise", detail: "Address reviewer feedback." },
    { id: "ship", label: "Ship" },
    { id: "watch", label: "Observe independently" },
  ],
  edges: [
    { from: "review", to: "revise", label: "changes" },
    { from: "review", to: "ship", label: "approved" },
  ],
};

await test("the transcript shows fork labels and independent nodes in plain text", () => {
  const lines = renderDiagram(fork, monochrome, false).render(60);
  assert.equal(lines[0], fork.title);
  assert.ok(lines.some((line) => line.includes("├─╮")));
  assert.ok(lines.some((line) => line.includes("Revise  · changes")));
  assert.ok(lines.some((line) => line.includes("Ship  · approved")));
  assert.ok(lines.some((line) => line.includes("Observe independently")));
  assert.ok(!lines.some((line) => line.includes("reviewer feedback")));
});

await test("cycles, self loops and parallel transitions retain their endpoints and captions", () => {
  const loop = {
    ...fork,
    edges: [
      ...fork.edges,
      { from: "review", to: "revise", label: "conflict" },
      { from: "revise", to: "review", label: "resubmit" },
      { from: "ship", to: "ship", label: "retry" },
    ],
  };
  const lines = renderDiagram(loop, monochrome, true).render(60);
  const plain = lines.join("\n");
  for (const annotation of [
    "changes → Revise",
    "conflict → Revise",
    "approved → Ship",
    "resubmit ↺ Review",
    "retry ↺ Ship",
    "Address reviewer feedback.",
  ])
    assert.ok(plain.includes(annotation), annotation);
});

await test("expanded text wraps and very narrow views preserve explicit direction", () => {
  const label = "工程 Release a candidate build after reviewing the change";
  const diagram = {
    title: "Publish",
    nodes: [
      { id: "build", label },
      { id: "release", label: "Publish package" },
    ],
    edges: [{ from: "build", to: "release" }],
  };
  const view = renderDiagram(diagram, monochrome, true);
  assert.deepEqual(view.render(0), []);
  for (const width of [8, 20, 60]) {
    const lines = view.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(!lines.slice(0, -1).some((line) => line.includes("…")));
    assert.ok(lines.join(" ").includes("after"));
    assert.ok(lines.some((line) => line.includes("→")));
  }
});

await test("preview folding reports omitted nodes and expanded view distinguishes repeated labels", () => {
  const nodes = Array.from({ length: 20 }, (_, index) => ({
    id: String(index),
    label: "Service",
  }));
  const diagram = {
    title: "Pipeline",
    nodes,
    edges: nodes
      .slice(1)
      .map(({ id }, index) => ({ from: String(index), to: id })),
  };
  const preview = renderDiagram(diagram, monochrome, false).render(60);
  assert.match(preview.at(-1) ?? "", /\+\d+ more nodes/u);
  const expanded = renderDiagram(diagram, monochrome, true).render(60);
  assert.ok(expanded.some((line) => line.includes("→ Service (19)")));
});
