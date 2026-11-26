import { editFileHeading, syntaxDiffRows } from "../code-intelligence/diff.ts";
import type { SyntaxReplacement } from "../code-intelligence/syntax-analysis.ts";
import studioTheme from "../resources/theme.json" with { type: "json" };
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThemeBg, ThemeColor, ThemeStyle } from "@earendil-works/pi-coding-agent";
import { parseColor, styleText, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { diagnosticRows, type DiagnosticSnapshot } from "../code-intelligence/diagnostics.ts";

const plain = {
  appearance: "dark" as const,
  bg: (_tone: ThemeBg, value: string) => value,
  fg: (_tone: ThemeColor, value: string) => value,
  bold: (value: string) => value,
  colors: {
    text: parseColor("#D8DEE9"),
    toolSuccessBg: parseColor("#3B4252"),
    toolDiffRemoved: parseColor("#BF616A"),
    toolDiffAdded: parseColor("#A3BE8C"),
  },
  style: (value: string) => value,
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
  assert.match(diagnosticRows(value, plain, 100, true).join("\n"), /⚠ 3:1 {2}Unused value/u);
  const wide = diagnosticRows(value, plain, 55, false);
  const first = wide.findIndex((row) => row.startsWith("× 7:3"));
  assert.match(wide[first] ?? "", /^× 7:3, 9:3 {2}Type/u);
  assert.match(wide[first + 1] ?? "", /^ {12}\S/u);
  assert.match(text, /document version/u);
  assert.match(
    diagnosticRows({ path: value.path, state: "pending", diagnostics: [] }, plain, 100, false).join("\n"),
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
    "   ...",
    ' 6 const label = "漢字😀";',
    "-7 const retries = 3;",
    "-8 const removed = true;",
    '+7 const retries = "three";',
    " 9 finish();",
    "+10 added();",
    "   ...",
  ].join("\n");
  const highlight = (text: string) => text.split("\n");
  const scope = { row: 1, label: "applyRetry(limit: number)" };
  for (const width of [60, 92, 93, 100, 140]) {
    const rows = syntaxDiffRows(diff, "retry.ts", plain, width, "/project", highlight, undefined, [], {
      scopes: [scope],
    });
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
    assert.equal(text.split(scope.label).length, 2);
    assert.ok(text.indexOf(scope.label) < text.indexOf("const label"));
    assert.doesNotMatch(text.slice(0, text.indexOf(scope.label)), /\.\.\./u);
    assert.match(text.slice(text.indexOf("added()")), /\.\.\./u);
    assert.equal(text.includes(" │ "), width >= 93);
    assert.doesNotMatch(text, /Original.*Updated/u);
    if (width >= 93) {
      assert.match(text, /-\s*7 const retries = 3;.*│.*\+\s*7 const retries = "three";/u);
      assert.match(text, /9 finish\(\).*│.*8 finish\(\)/u);
    }
  }
  const long = `-1 const value = "${"漢字😀".repeat(25)}";\n+1 const value = "short";`;
  const wrapped = syntaxDiffRows(long, "retry.ts", plain, 100, "/project", highlight);
  assert.ok(wrapped.every((row) => visibleWidth(row) <= 100));
  assert.match(wrapped.join("\n"), /short/u);
});

function renderDiff(diff: string, width: number, replacements: SyntaxReplacement[] = []): string {
  const rows = syntaxDiffRows(diff, "retry.ts", plain, width, "/project", (text) => text.split("\n"), undefined, [], {
    replacements,
  });
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
    const text = renderDiff(diff, width, [
      { row: 4, start: 11, original: "2", updated: "4" },
      { row: 5, start: 13, original: "1500", updated: "3000" },
      { row: 6, start: 8, original: "passive", updated: "active" },
    ]);
    assert.doesNotMatch(text, /Original|Updated| │ /u);
    for (const label of ["const policy", "retries:", "timeoutMs:", "mode:"])
      assert.equal(text.split(label).length, 2, label);
    assert.ok(text.includes("retries: 2 → 4,"));
    assert.ok(text.includes("timeoutMs: 1500 → 3000,"));
    assert.ok(text.includes("mode: passive → active,"));
  }
  assert.match(
    renderDiff("-1 rate: 1.25\n+1 rate: 1.75", 120, [{ row: 1, start: 6, original: "1.25", updated: "1.75" }]),
    /rate: 1\.25 → 1\.75/u,
  );
});

await test("compact rows use UTF-16 syntax offsets and require matching saved source", () => {
  const prefix = 'log("漢😀", ';
  const diff = `-1 ${prefix}2);\n+1 ${prefix}4);`;
  const change = { row: 1, start: prefix.length, original: "2", updated: "4" };
  assert.ok(renderDiff(diff, 120, [change]).includes(`${prefix}2 → 4);`));
  for (const replacements of [[], [{ ...change, original: "5" }], [{ ...change, start: 2 }]]) {
    const full = renderDiff(diff, 120, replacements);
    assert.ok(full.includes(" │ "));
    assert.ok(full.includes(`${prefix}2);`));
    assert.ok(full.includes(`${prefix}4);`));
  }
});

await test("changing an operator or whitespace with a value preserves both expressions", () => {
  assert.match(renderDiff("-1 base-2\n+1 base+4", 120), /-1 base-2\s*│\s*\+1 base\+4/u);
  assert.match(renderDiff("-1 retries: 2\n+1 retries:  4", 120), /-1 retries: 2\s*│\s*\+1 retries: {2}4/u);
});

await test("file reasons share the heading and a creation marks the file once", () => {
  const render = (width: number, addedFile: boolean) =>
    syntaxDiffRows(
      "+1 export const x = 2;\n+2 done();",
      "src/retry.ts",
      plain,
      width,
      "/project",
      (text) => text.split("\n"),
      undefined,
      [],
      { displayToolName: "", addedFile, reason: "Cover the retry boundary." },
    ).map(stripTerminalSequences);
  const lines = render(72, true);
  assert.match(lines[0] ?? "", /\+ src\/retry.ts {2}· Cover the retry boundary/u);
  assert.match(lines[1] ?? "", /^\s*1 export/u);
  assert.doesNotMatch(lines.join("\n"), /\+\s*\d/u);
  const inFile = render(72, false);
  assert.match(inFile.join("\n"), /\+1 export/u);
  for (const width of [12, 18, 33]) {
    const narrow = render(width, true);
    assert.ok(narrow.every((row) => visibleWidth(row) <= width));
    assert.match(narrow.join(" ").replace(/\s+/gu, " "), /Cover the retry boundary\./u);
  }
  assert.equal(editFileHeading(plain, "Edit", "f", "\x1b[31m reason\x1b[0m"), "Edit f  · reason");
  assert.equal(editFileHeading(plain, "Edit", "f", " "), "Edit f");
});

await test("token fills and gutter roles survive compact, paired and wrapped diffs", () => {
  const theme = {
    ...plain,
    name: studioTheme.name,
    colors: {
      ...plain.colors,
      toolSuccessBg: parseColor(studioTheme.colors.toolSuccessBg),
      toolDiffRemoved: parseColor(studioTheme.colors.toolDiffRemoved),
      toolDiffAdded: parseColor(studioTheme.colors.toolDiffAdded),
    },
    fg(role: ThemeColor, text: string) {
      const ansi = role === "warning" ? "\x1b[33m" : role === "toolDiffContext" ? "\x1b[34m" : "";
      return ansi + text + (ansi === "" ? "" : "\x1b[39m");
    },
    style(text: string, options: ThemeStyle) {
      assert.ok(typeof options.fg === "object");
      assert.ok(options.bg === undefined || typeof options.bg === "object");
      return styleText(
        text,
        {
          fg: options.fg,
          ...(!options.bg ? {} : { bg: options.bg }),
          bold: options.bold === true,
        },
        "truecolor",
      );
    },
  };
  const gray = "\x1b[38;2;177;177;177m";
  const reason = "Allow another attempt";
  assert.ok(editFileHeading(theme, "Edit", "retry.ts", reason).includes(`${gray}  · ${reason}`));
  const light = {
    ...theme,
    name: "custom-light",
    appearance: "light" as const,
    colors: {
      ...theme.colors,
      toolSuccessBg: parseColor("#F2F2F2"),
      text: parseColor("#202020"),
    },
  };
  assert.ok(editFileHeading(light, "Edit", "retry.ts", reason).includes("\x1b[38;2;85;85;85m"));
  const diff = "-12 return attempts < 2;\n+12 return attempts < 4;";
  const change = { row: 1, start: 18, original: "2", updated: "4" };
  for (const [width, withIssue] of [
    [80, false],
    [120, true],
    [19, true],
  ] as const) {
    const issue: DiagnosticSnapshot["diagnostics"] = withIssue
      ? [
          {
            line: 12,
            column: 19,
            endLine: 12,
            endColumn: 20,
            severity: "error",
            message: "Out of range",
          },
        ]
      : [];
    const rows = syntaxDiffRows(
      diff,
      "retry.ts",
      theme,
      width,
      "/project",
      (text) => text.split("\n"),
      undefined,
      issue,
      { replacements: [change] },
    );
    const view = rows.join("\n");
    assert.ok(rows.every((row) => visibleWidth(row) <= width));
    assert.ok(view.includes("\x1b[48;2;71;52;63m"), "dark rose removal tint");
    assert.ok(view.includes("\x1b[48;2;48;70;57m"), "dark green addition tint");
    assert.ok(view.includes("\x1b[38;2;191;97;106m"), "original red removal ink");
    assert.ok(view.includes("\x1b[38;2;163;190;140m"), "original green addition ink");
    if (withIssue && width === 120) assert.ok(view.includes(`${gray}Out of range`));
    if (!withIssue) {
      assert.ok(view.includes("\x1b[33m~\x1b[39m\x1b[34m12 "));
      assert.ok(view.includes("\x1b[38;2;191;97;106m\x1b[48;2;71;52;63m2"));
      assert.ok(view.includes("\x1b[38;2;163;190;140m\x1b[48;2;48;70;57m4"));
      assert.match(stripTerminalSequences(view), /return attempts < 2 → 4;/u);
    } else {
      assert.ok(view.includes("\x1b[4:3m"));
    }
    const custom = syntaxDiffRows(
      diff,
      "retry.ts",
      light,
      width,
      "/project",
      (text) => text.split("\n"),
      {
        min_split_columns: 40,
        inline_diagnostics: true,
        removed_background: "#080808",
        added_background: "#f0f0f0",
      },
      issue,
      { replacements: [change] },
    ).join("\n");
    assert.ok(
      custom.includes("\x1b[38;2;255;162;168m\x1b[48;2;8;8;8m"),
      "readable custom theme ink survives a configured dark fill",
    );
    assert.ok(
      custom.includes("\x1b[38;2;0;0;0m\x1b[48;2;240;240;240m"),
      "unreadable diff ink adapts to a configured light fill",
    );
  }
  const otherDark = syntaxDiffRows(
    diff,
    "retry.ts",
    { ...theme, name: "custom-dark" },
    80,
    "/project",
    (text) => text.split("\n"),
    undefined,
    [],
    { replacements: [change] },
  ).join("\n");
  assert.ok(
    otherDark.includes("\x1b[38;2;255;162;168m\x1b[48;2;71;52;63m2"),
    "other dark themes retain their removal ink",
  );
  assert.ok(
    otherDark.includes("\x1b[38;2;169;196;146m\x1b[48;2;48;70;57m4"),
    "other dark themes retain their addition ink",
  );
});

await test("a replacement that cannot fit inline keeps both source lines", () => {
  const diff = "-1 mode: previousMode,\n+1 mode: proposedMode,";
  const text = renderDiff(diff, 24, [{ row: 1, start: 6, original: "previousMode", updated: "proposedMode" }]);
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
        rows.some((row) => row.includes(`const ${name} = \x1b[4:3m"bad"\x1b[24m`) && row.includes("× Use a number")),
      );
    }
  }
});
