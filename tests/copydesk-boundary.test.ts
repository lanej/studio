import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";

const root = fileURLToPath(new URL("../", import.meta.url));

function sources(directory: string): string[] {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap(
    (entry) => {
      if (["node_modules", "dist", ".git"].includes(entry.name)) return [];
      const filename = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return sources(filename);
      return entry.isFile() && /\.[cm]?ts$/.test(entry.name) ? [filename] : [];
    },
  );
}

function moduleReferences(filename: string): string[] {
  const references: string[] = [];
  const source = ts.createSourceFile(
    filename,
    readFileSync(resolve(root, filename), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const record = (node: ts.Node | undefined): void => {
    if (node !== undefined && ts.isStringLiteralLike(node))
      references.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      record(node.moduleSpecifier);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      record(node.argument.literal);
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      record(node.moduleReference.expression);
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    )
      record(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}

function modulePath(filename: string, specifier: string): string {
  return specifier.startsWith(".")
    ? relative(root, resolve(root, dirname(filename), specifier))
    : specifier;
}

await test("planning and task runtime retain authority without importing editor adapters", () => {
  const leadAdapters = [
    "lead/extensions/managed.ts",
    "lead/extensions/socrates.ts",
  ];
  for (const filename of [
    ...sources("planning"),
    ...sources("vendor/task-runtime"),
    ...leadAdapters,
  ]) {
    for (const specifier of moduleReferences(filename)) {
      const target = modulePath(filename, specifier);
      assert.ok(
        !target.startsWith("documents/") &&
          !target.startsWith("@lanej/copydesk"),
        `${filename} imports editor implementation ${specifier}`,
      );
      if (
        leadAdapters.includes(filename) ||
        filename === "planning/document-hooks.ts"
      ) {
        assert.ok(
          !target.startsWith("planning/documents"),
          `${filename} depends on the concrete document authority rather than its hooks`,
        );
      }
    }
  }
});

await test("Studio consumes an immutable independent package revision", () => {
  const manifest = z
    .object({ dependencies: z.record(z.string(), z.string()) })
    .parse(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")));
  assert.match(
    manifest.dependencies["@lanej/copydesk"] ?? "",
    /^git\+https:\/\/github\.com:443\/lanej\/copydesk\.git#[0-9a-f]{40}$/,
  );
});
