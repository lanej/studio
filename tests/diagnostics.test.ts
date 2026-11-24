import { syntaxDiffRows } from "../code-intelligence/diff.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThemeBg, ThemeColor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  diagnosticRows,
  type DiagnosticSnapshot,
} from "../code-intelligence/diagnostics.ts";
const plain = {
  bg: (_tone: ThemeBg, value: string) => value,
  fg: (_tone: ThemeColor, value: string) => value,
  bold: (value: string) => value,
};
await test("inline diagnostics distinguish pending and reported results, wrap, and expand", () => {
  const value: DiagnosticSnapshot = {
    path: "/project/retry.ts",
    state: "received",
    freshness: "unversioned",
    total: 4,
    diagnostics: [
      {
        line: 3,
        column: 1,
        severity: "warning",
        message: "Unused value",
        code: 6133,
        source: "ts",
      },
      {
        line: 7,
        column: 3,
        severity: "error",
        message: "Type 'string' is not assignable to type 'number'.",
        code: 2322,
        source: "ts",
      },
      {
        line: 9,
        column: 3,
        severity: "error",
        message: "Type 'string' is not assignable to type 'number'.",
        code: 2322,
        source: "ts",
      },
      {
        line: 8,
        column: 3,
        severity: "error",
        message: "Invalid value\x1b[31m",
        code: 2322,
        source: "ts",
      },
    ],
  };
  const narrow = diagnosticRows(value, plain, 30, false);
  assert.ok(narrow.every((row) => visibleWidth(row) <= 30));
  const text = narrow.join("\n");
  assert.match(text, /× 7:3, 9:3\n {2}Type/u);
  assert.doesNotMatch(text, /⚠ 3:1/u);
  assert.match(text, /1 more message/u);
  assert.doesNotMatch(text, /TS2322/u);
  assert.equal(text.match(/assignable/gu)?.length, 1);
  assert.equal(text.includes("\x1b"), false);
  assert.match(
    diagnosticRows(value, plain, 100, true).join("\n"),
    /⚠ 3:1 {2}Unused value/u,
  );
  const wide = diagnosticRows(value, plain, 55, false);
  const first = wide.findIndex((row) => row.startsWith("× 7:3"));
  assert.match(wide[first] ?? "", /^× 7:3, 9:3 {2}Type/u);
  assert.match(wide[first + 1] ?? "", /^ {12}\S/u);
  assert.match(text, /document version/u);
  assert.match(
    diagnosticRows(
      { path: value.path, state: "pending", diagnostics: [] },
      plain,
      100,
      false,
    ).join("\n"),
    /checking/u,
  );
  const empty = diagnosticRows(
    { path: value.path, state: "received", total: 0, diagnostics: [] },
    plain,
    100,
    false,
  ).join("\n");
  assert.match(empty, /no errors or warnings reported/u);
  assert.doesNotMatch(empty, /project clean/u);
});

await test("edit diffs switch between aligned split and unified layouts without losing changes", () => {
  const diff = [
    ' 6 const label = "漢字😀";',
    "-7 const retries = 3;",
    "-8 const removed = true;",
    '+7 const retries = "three";',
    " 9 finish();",
    "+10 added();",
  ].join("\n");
  const highlight = (text: string) => text.split("\n");
  for (const width of [60, 92, 93, 100, 140]) {
    const rows = syntaxDiffRows(
      diff,
      "retry.ts",
      plain,
      width,
      "/project",
      highlight,
    );
    const text = rows.join("\n");
    assert.ok(
      rows.every((row) => visibleWidth(row) <= width),
      `overflow at ${String(width)}`,
    );
    assert.match(text, /removed = true/u);
    assert.match(text, /added\(\)/u);
    assert.match(text, /漢字😀/u);
    assert.match(text, /retries = 3/u);
    assert.match(text, /retries = "three"/u);
    assert.equal(text.includes(" │ "), width >= 93);
    if (width >= 93) {
      assert.match(text, /Original.*Updated/u);
      assert.match(text, /9 finish\(\).*│.*8 finish\(\)/u);
    }
  }
  const long = `-1 const value = "${"漢字😀".repeat(25)}";\n+1 const value = "short";`;
  const wrapped = syntaxDiffRows(
    long,
    "retry.ts",
    plain,
    100,
    "/project",
    highlight,
  );
  assert.ok(wrapped.every((row) => visibleWidth(row) <= 100));
  assert.match(wrapped.join("\n"), /short/u);
});

function renderDiff(diff: string, width: number): string {
  const rows = syntaxDiffRows(diff, "retry.txt", plain, width, "/project");
  assert.ok(rows.every((row) => visibleWidth(row) <= width));
  return rows.map(stripTerminalSequences).join("\n");
}

await test("small replacements show both tokens inline and shared code once", () => {
  const diff = [
    " 1 const policy = {",
    "-2   retries: 2,",
    "-3   timeoutMs: 1500,",
    "-4   mode: passive,",
    "+2   retries: 4,",
    "+3   timeoutMs: 3000,",
    "+4   mode: active,",
    " 5 };",
  ].join("\n");
  for (const width of [60, 120]) {
    const text = renderDiff(diff, width);
    assert.doesNotMatch(text, /Original|Updated| │ /u);
    for (const label of ["const policy", "retries:", "timeoutMs:", "mode:"])
      assert.equal(text.split(label).length, 2, label);
    assert.ok(text.includes("retries: 2 → 4,"));
    assert.ok(text.includes("timeoutMs: 1500 → 3000,"));
    assert.ok(text.includes("mode: passive → active,"));
  }
  assert.match(
    renderDiff("-1 rate: 1.25\n+1 rate: 1.75", 120),
    /rate: 1\.25 → 1\.75/u,
  );
});

await test("changing an operator or whitespace with a value preserves both expressions", () => {
  assert.match(
    renderDiff("-1 base-2\n+1 base+4", 120),
    /-1 base-2\s*│\s*\+1 base\+4/u,
  );
  assert.match(
    renderDiff("-1 retries: 2\n+1 retries:  4", 120),
    /-1 retries: 2\s*│\s*\+1 retries: {2}4/u,
  );
});

await test("a replacement that cannot fit inline keeps both source lines", () => {
  const diff = "-1 mode: previousMode,\n+1 mode: proposedMode,";
  const text = renderDiff(diff, 24);
  assert.match(text, /-1 mode: previousMode,/u);
  assert.match(text, /\+1 mode: proposedMode,/u);
});

await test("one-sided diffs use a single column even with surrounding context", () => {
  for (const sign of ["+", "-"]) {
    const text = renderDiff(` 1 start();\n${sign}2 retry();`, 120);
    assert.doesNotMatch(text, /Original|Updated| │ /u);
    assert.ok(text.includes(`${sign}2 retry();`));
    assert.equal(text.split("start();").length, 2);
  }
});

await test("edit inlays stay attached to each occurrence and underline the source range", () => {
  const diff = '+1 const a = "bad";\n+2 const b = "bad";';
  const issues: DiagnosticSnapshot["diagnostics"] = [1, 2].map((line) => ({
    line,
    column: 11,
    endLine: line,
    endColumn: 16,
    severity: "error",
    message: "Use a number",
  }));
  for (const width of [60, 100]) {
    const rows = syntaxDiffRows(
      diff,
      "retry.ts",
      plain,
      width,
      "/project",
      (text) => text.split("\n"),
      undefined,
      issues,
    );
    assert.ok(rows.every((row) => visibleWidth(row) <= width));
    for (const name of ["a", "b"]) {
      assert.ok(
        rows.some(
          (row) =>
            row.includes(`const ${name} = \x1b[4:3m"bad"\x1b[24m`) &&
            row.includes("× Use a number"),
        ),
      );
    }
  }
});
