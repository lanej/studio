import assert from "node:assert/strict";
import { test } from "node:test";
import { SymbolKind } from "vscode-languageserver-protocol";
import { resolveDiffScopes } from "../code-intelligence/scopes.ts";

await test("scope labels come from an enclosing declaration outside the hunk", () => {
  const declaration = "function retry(attempt: number) {";
  const source = [
    declaration,
    "  return attempt + 2;",
    "}",
    "const limit = 4;",
  ].join("\n");
  const symbols = [
    {
      name: "retry",
      kind: 12,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 2, character: 1 },
      },
      selectionRange: {
        start: { line: 0, character: 9 },
        end: { line: 0, character: 14 },
      },
    },
  ];
  const inside = "-2   return attempt + 1;\n+2   return attempt + 2;";
  const outside = "-4 const limit = 2;\n+4 const limit = 4;";
  const scopes = resolveDiffScopes(
    `   ...\n${inside}\n   ...\n${outside}`,
    source,
    symbols,
  );
  assert.deepEqual(
    scopes.map(({ row }) => row),
    [1],
  );
  assert.match(scopes[0]?.label ?? "", /retry\(attempt: number\)/u);
  assert.deepEqual(
    resolveDiffScopes(` 1 ${declaration}\n${inside}`, source, symbols),
    [],
  );
  assert.deepEqual(resolveDiffScopes(inside, source, []), []);
});

await test("class and type context requires an unambiguous declaration", () => {
  const diff = "-2   limit: 2;\n+2   limit: 4;";
  for (const [header, kind, label] of [
    ["class Policy {", SymbolKind.Class, "class Policy"],
    ["export type Policy = {", SymbolKind.Variable, "type Policy"],
    ["const Policy = {", SymbolKind.Variable, undefined],
  ] as const) {
    const source = [header, "  limit: 4;", "}"].join("\n");
    const nameStart = header.indexOf("Policy");
    const symbol = {
      name: "Policy",
      kind,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 2, character: 1 },
      },
      selectionRange: {
        start: { line: 0, character: nameStart },
        end: { line: 0, character: nameStart + "Policy".length },
      },
    };
    assert.deepEqual(
      resolveDiffScopes(diff, source, [symbol]),
      label === undefined ? [] : [{ row: 0, label }],
    );
    assert.deepEqual(resolveDiffScopes(diff, source, [symbol, symbol]), []);
  }
});
