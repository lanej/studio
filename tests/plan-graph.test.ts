import assert from "node:assert/strict";
import { test } from "node:test";
import { planGraph, renderGraphPrefix } from "../plan-graph.ts";

function picture(dependencies: Record<string, string[]>): string[] {
  const tasks = Object.entries(dependencies).map(([key, blockedBy]) => ({
    key,
    blockedBy,
  }));
  return planGraph(tasks).flatMap(({ task, prefix, connectors }) => [
    `${renderGraphPrefix(prefix)} ${task.key}`,
    ...connectors.map((line) => renderGraphPrefix(line).trimEnd()),
  ]);
}

await test("a branch meets its exact prerequisites at the join", () => {
  // The source order need not be topological. Siblings retain their draft order.
  assert.deepEqual(
    picture({
      publish: ["audit", "resume"],
      chunk: [],
      resume: ["chunk"],
      audit: ["chunk"],
    }),
    [
      "●   chunk",
      "├─╮",
      "● │ resume",
      "│ │",
      "│ ● audit",
      "├─╯",
      "●   publish",
    ],
  );
});

await test("a task with no prerequisites does not acquire an incoming rail", () => {
  assert.deepEqual(
    picture({ left: [], right: [], save: ["left"], done: ["right", "save"] }),
    ["●   left", "│", "│ ● right", "│ │", "● │ save", "╰─┤", "  ● done"],
  );
  assert.deepEqual(picture({ one: [], two: [], three: [] }), [
    "● one",
    "● two",
    "● three",
  ]);
});

await test("joining two waiting tasks does not attach an unrelated rail crossing the join", () => {
  const lines = picture({
    a: [],
    b: [],
    c: ["a"],
    d: ["b"],
    e: ["b", "c"],
    f: ["b", "c"],
  });
  assert.deepEqual(lines.slice(4, 8), [
    "● │ │ │ c",
    "├─┆▸┤ │",
    "╰─┆─┆─┤",
    "  ● │ │ d",
  ]);
});

await test("a maximal fan leaves room for titles and marks each child once", () => {
  const children = Array.from({ length: 11 }, (_, index) => ({
    key: `child-${String(index)}`,
    blockedBy: ["root"],
  }));
  const tasks = [{ key: "root", blockedBy: [] }, ...children];
  const rows = planGraph(tasks);
  assert.deepEqual(
    rows.map((row) => row.key),
    tasks.map((item) => item.key),
  );
  assert.ok(rows.every((row) => renderGraphPrefix(row.prefix).length === 11));
  assert.equal(renderGraphPrefix(rows[0]?.connectors[0] ?? []), "├┬┬┬┬┬┬┬┬┬╮");
  for (const [index, row] of rows.slice(1).entries()) {
    assert.equal(row.task, children[index]);
    const glyphs = renderGraphPrefix(row.prefix, (_lane, glyph) => glyph, "◐");
    assert.equal(glyphs.indexOf("◐"), index);
    assert.ok(!glyphs.includes("●"));
  }
});
