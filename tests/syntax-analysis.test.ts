import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeEditSyntax } from "../code-intelligence/syntax-analysis.ts";

const change = async (
  path: string,
  source: string,
  original: string,
  updated: string,
) => {
  const lines = source.split("\n");
  const row = lines.findIndex((line) => line.includes(original));
  const oldLine = lines[row];
  assert.ok(oldLine !== undefined);
  const newLine = oldLine.replace(original, updated);
  lines[row] = newLine;
  const diff = `-${String(row + 1)} ${oldLine}\n+${String(row + 1)} ${newLine}`;
  return analyzeEditSyntax(path, source, lines.join("\n"), diff);
};

await test("Tree-sitter compares number leaves and extracts enclosing declarations across languages", async () => {
  const fixtures = [
    [
      "policy.tsx",
      "const retry = (job: string) => {\n  return 1500;\n};",
      "retry = (job: string) =>",
    ],
    [
      "policy.py",
      "class Policy:\n  def retry(self, job):\n    return 1500",
      "Policy › def retry(self, job):",
    ],
    [
      "policy.rb",
      "class Policy\n  def retry(job)\n    1500\n  end\nend",
      "Policy › def retry(job)",
    ],
    [
      "policy.go",
      "package p\nfunc (p Policy) Retry(job string) int {\n  return 1500\n}\n",
      "func (p Policy) Retry(job string) int",
    ],
    [
      "policy.rs",
      "impl Policy {\n  fn retry(&self, job: Job) -> u32 {\n    1500\n  }\n}",
      "Policy › fn retry(&self, job: Job) -> u32",
    ],
    [
      "policy.cpp",
      "class Policy {\n int retry() {\n   return 1500;\n }\n};",
      "Policy › int retry()",
    ],
    [
      "Policy.java",
      "class Policy {\n  int retry() {\n    return 1500;\n  }\n}",
      "Policy › int retry()",
    ],
    ["policy.sh", "retry() {\n  local delay=1500\n}", "retry()"],
    ["policy.json", '{\n  "delay": 1500\n}', undefined],
  ] as const;
  for (const [path, source, label] of fixtures) {
    const result = await change(path, source, "1500", "3000");
    assert.ok(result !== undefined, path);
    const line = source.split("\n").find((row) => row.includes("1500"));
    assert.deepEqual(
      result.replacements,
      [
        {
          row: 1,
          start: line?.indexOf("1500"),
          original: "1500",
          updated: "3000",
        },
      ],
      path,
    );
    assert.deepEqual(
      result.scopes,
      label === undefined ? [] : [{ row: 0, label }],
      path,
    );
  }
});

await test("syntax positions and persisted offsets support Unicode and both token boundaries", async () => {
  const line = 'const 雨 = (emoji = "🐈") => "ok" + timeout;';
  for (const [oldToken, newToken] of [
    ["timeout", "timeoutMs"],
    ["timeout", "time"],
    ["timeout", "retryMs"],
  ] as const) {
    const result = await change("policy.ts", line, oldToken, newToken);
    assert.deepEqual(result?.replacements, [
      {
        row: 1,
        start: line.indexOf(oldToken),
        original: oldToken,
        updated: newToken,
      },
    ]);
  }
});

await test("edits in comments, quoted prose and regexes, syntax changes, and malformed input keep the full diff", async () => {
  for (const [path, source, from, to] of [
    ["x.ts", "// use 1500 milliseconds", "1500", "3000"],
    ["x.go", "package p\n/*\nvar delay = 1500\n*/\n", "1500", "3000"],
    ["x.ts", 'const text = "retry 1500";', "1500", "3000"],
    ["x.ts", "const matcher = /wait1500/;", "1500", "3000"],
    ["x.ts", 'const text = "x";', '"x"', "'x'"],
    ["x.py", "limit = base-2", "-2", "+4"],
    ["x.json", '{"limit": -2}', "-2", "4"],
    ["x.ts", "const flags = 2 / 3;", "2 / 3", "4 / 5"],
    ["x.ts", "const flags = 2;", " = 2", " =   4"],
  ] as const) {
    const result = await change(path, source, from, to);
    assert.ok(result !== undefined, path);
    assert.deepEqual(result.replacements, [], source);
  }
  assert.equal(
    await change("broken.ts", "function f( { return 1500;", "1500", "3000"),
    undefined,
  );
  assert.equal(
    await change("prose.txt", "wait 1500 milliseconds", "1500", "3000"),
    undefined,
  );
});

await test("each numbered hunk has its own scope and inserted or deleted lines use the matching revision", async () => {
  const before =
    "class Policy {\n retry() {\n  return 2;\n }\n}\nfunction other() {\n  return 1500;\n}";
  const after = before.replace("return 2", "return 4").replace("1500", "3000");
  const diff =
    "   ...\n-3   return 2;\n+3   return 4;\n   ...\n-7   return 1500;\n+7   return 3000;";
  const result = await analyzeEditSyntax("retry.ts", before, after, diff);
  assert.deepEqual(result?.scopes, [
    { row: 1, label: "Policy › retry()" },
    { row: 4, label: "function other()" },
  ]);
  assert.deepEqual(
    result?.replacements.map((r) => r.row),
    [2, 5],
  );
  const removed = before.replace("  return 2;\n", "");
  assert.deepEqual(
    (await analyzeEditSyntax("retry.ts", before, removed, "-3   return 2;"))
      ?.scopes,
    [{ row: 0, label: "Policy › retry()" }],
  );
  assert.deepEqual(
    (await analyzeEditSyntax("retry.ts", removed, before, "+3   return 2;"))
      ?.scopes,
    [{ row: 0, label: "Policy › retry()" }],
  );
  assert.equal(
    await analyzeEditSyntax(
      "retry.ts",
      before,
      after,
      "-3   return 9;\n+3   return 4;",
    ),
    undefined,
  );
  const header = "type Policy = {";
  const original = `${header}\n limit: 2;\n};`;
  assert.deepEqual((await change("policy.ts", original, "2", "4"))?.scopes, [
    { row: 0, label: "type Policy" },
  ]);
  assert.deepEqual(
    (
      await analyzeEditSyntax(
        "policy.ts",
        original,
        original.replace("2", "4"),
        ` 1 ${header}\n-2  limit: 2;\n+2  limit: 4;`,
      )
    )?.scopes,
    [],
  );
});

await test("excessively deep syntax falls back to the full diff", async () => {
  const before = `${"[".repeat(200)}2${"]".repeat(200)}`;
  const result = await change("deep.json", before, "2", "4");
  assert.deepEqual(result?.replacements ?? [], []);
  assert.deepEqual(result?.scopes ?? [], []);
});

await test("bundled grammars distinguish numeric leaves from untyped values", async () => {
  for (const [path, source, compact] of [
    ["policy.js", "const value = 2;", true],
    ["policy.cs", "class Policy { int value = 2; }", true],
    ["policy.css", "main { opacity: 0.2; }", true],
    ["policy.php", "<?php $value = 2;", true],
    ["policy.ps1", "$value = 2", true],
    ["policy.ini", "[retry]\nvalue = 2\n", false],
    ["policy.json", '{"label": "2"}', false],
    ["policy.json", '{"2": "label"}', false],
  ] as const) {
    const syntax = await change(path, source, "2", "4");
    assert.ok(syntax !== undefined, path);
    assert.equal(syntax.replacements.length, compact ? 1 : 0, source);
  }
});

await test("matching syntax roles are required for every compact token", async () => {
  const before = "function policy() {\n  retries = 2;\n}";
  const after = "class Policy {\n  retries = 4;\n}";
  const diff =
    "-1 function policy() {\n-2   retries = 2;\n+1 class Policy {\n+2   retries = 4;";
  // Both assignments have identical surrounding text, but the new number initializes a class field.
  assert.deepEqual(
    (await analyzeEditSyntax("policy.ts", before, after, diff))?.replacements,
    [],
  );
});
