import { z } from "zod";
import { parseDiffLines } from "./diff.ts";
import type { DiffScope } from "./scopes.ts";
import { withSyntaxTrees, type SyntaxNode } from "./tree-sitter.ts";

export const syntaxReplacement = z.object({
  row: z.number().int().nonnegative(),
  start: z.number().int().nonnegative(),
  original: z.string().min(1),
  updated: z.string().min(1),
});
export type SyntaxReplacement = z.infer<typeof syntaxReplacement>;
type DiffLine = ReturnType<typeof parseDiffLines>[number];

// These are names of grammar rules. Source text is tokenized only by Tree-sitter.
const numberKinds = new Set([
  "number",
  "integer",
  "float",
  "number_literal",
  "integer_literal",
  "int_literal",
  "float_literal",
  "floating_point_literal",
  "decimal_integer_literal",
  "hex_integer_literal",
  "octal_integer_literal",
  "binary_integer_literal",
  "decimal_floating_point_literal",
  "hex_floating_point_literal",
  "integer_value",
  "float_value",
]);

function tokenAt(root: SyntaxNode, row: number, column: number): SyntaxNode | undefined {
  const node = root.descendantForPosition({ row, column }, { row, column: column + 1 });
  if (
    node === null ||
    !node.isNamed ||
    node.childCount !== 0 ||
    node.startPosition.row !== row ||
    node.endPosition.row !== row
  )
    return undefined;
  return numberKinds.has(node.type) ||
    node.type === "identifier" ||
    node.type.endsWith("_identifier") ||
    node.type === "variable_name"
    ? node
    : undefined;
}

const maxContextDepth = 128;

// Siblings cover disjoint source ranges in order, including anonymous operators.
function childIndex(parent: SyntaxNode, node: SyntaxNode): number {
  let start = 0,
    end = parent.childCount;
  while (start < end) {
    const index = Math.floor((start + end) / 2);
    const child = parent.child(index);
    if (child === null) break;
    if (child.id === node.id) return index;
    if (child.endIndex <= node.startIndex) start = index + 1;
    else end = index;
  }
  return -1;
}

function sameSyntaxPosition(oldNode: SyntaxNode, newNode: SyntaxNode): boolean {
  let left = oldNode,
    right = newNode;
  for (let depth = 0; depth < maxContextDepth && left.type === right.type; depth++) {
    const oldParent = left.parent,
      newParent = right.parent;
    if (oldParent === null || newParent === null) return oldParent === null && newParent === null;
    const index = childIndex(oldParent, left);
    if (
      index < 0 ||
      index !== childIndex(newParent, right) ||
      oldParent.fieldNameForChild(index) !== newParent.fieldNameForChild(index)
    )
      return false;
    left = oldParent;
    right = newParent;
  }
  return false;
}

function replacement(
  oldRoot: SyntaxNode,
  newRoot: SyntaxNode,
  oldLine: DiffLine,
  newLine: DiffLine,
  row: number,
): SyntaxReplacement | undefined {
  const oldCode = oldLine.rawCode,
    newCode = newLine.rawCode;
  let first = 0;
  while (first < Math.min(oldCode.length, newCode.length) && oldCode[first] === newCode[first]) first++;
  if (oldCode === newCode) return undefined;
  const oldRow = Number(oldLine.beforeNumber) - 1,
    newRow = Number(newLine.afterNumber) - 1;
  // An insertion/deletion can end at the token boundary (e.g. max -> maxMs).
  for (const column of [first, first - 1]) {
    if (column < 0 || column >= newCode.length) continue;
    const updated = tokenAt(newRoot, newRow, column);
    if (!updated) continue;
    const start = updated.startPosition.column;
    const original = tokenAt(oldRoot, oldRow, start);
    if (
      !original ||
      original.type !== updated.type ||
      original.startPosition.column !== start ||
      original.text === updated.text ||
      (numberKinds.has(original.type) && original.text.startsWith("-") !== updated.text.startsWith("-")) ||
      oldCode.slice(0, start) !== newCode.slice(0, start) ||
      oldCode.slice(original.endPosition.column) !== newCode.slice(updated.endPosition.column) ||
      !sameSyntaxPosition(original, updated)
    )
      continue;
    return { row, start, original: original.text, updated: updated.text };
  }
  return undefined;
}

const functions = new Set([
  "function_declaration",
  "function_definition",
  "function_item",
  "function_statement",
  "function_signature",
  "method_declaration",
  "method_definition",
  "method",
  "singleton_method",
  "constructor_declaration",
  "local_function_statement",
  "generator_function_declaration",
  "function_expression",
  "arrow_function",
]);
const types = new Set([
  "class",
  "class_declaration",
  "class_definition",
  "class_specifier",
  "interface_declaration",
  "module",
  "module_declaration",
  "namespace_definition",
  "namespace_declaration",
  "struct_specifier",
  "struct_declaration",
  "enum_declaration",
  "record_declaration",
  "struct_item",
  "enum_item",
  "trait_item",
  "impl_item",
  "mod_item",
  "type_item",
  "type_spec",
  "type_alias_declaration",
]);

function declaration(node: SyntaxNode, source: string, firstVisible: number): string | undefined {
  if (node.startPosition.row >= firstVisible) return undefined;
  let headerNode = node;
  if (node.type === "arrow_function" || node.type === "function_expression") {
    // Anonymous callbacks need no extra heading. Named bindings carry the name on their parent.
    const binding = node.parent;
    if (binding?.childForFieldName("value")?.id === node.id) headerNode = binding;
    else if (node.childForFieldName("name") === null) return undefined;
  }
  const firstChild = headerNode.firstNamedChild;
  const name =
    headerNode.childForFieldName("name") ??
    headerNode.childForFieldName("type") ??
    (firstChild?.type === "function_name" ? firstChild : null);
  const body = node.childForFieldName("body") ?? node.childForFieldName("value");
  if (body !== null && body.startIndex - headerNode.startIndex <= 512) {
    const header = source.slice(headerNode.startIndex, body.startIndex).trimEnd();
    const lines = header.split("\n");
    const label = lines
      .map((line) => line.trim())
      .join(" ")
      .replace(/\s*=\s*$/u, "");
    if (label.length > 0 && label.length <= 200 && headerNode.startPosition.row + lines.length - 1 < firstVisible)
      return label;
  }
  return name !== null && name.startPosition.row < firstVisible ? name.text : undefined;
}

function scopeAt(
  root: SyntaxNode,
  source: string,
  side: "beforeNumber" | "afterNumber",
  hunk: DiffLine[],
): string | undefined {
  const sign = side === "beforeNumber" ? "-" : "+";
  const changed = hunk.filter((line) => line.prefix === sign);
  const first = changed[0],
    last = changed.at(-1),
    visible = hunk.find((line) => line[side] !== "");
  if (!first || !last || !visible) return undefined;
  const start = {
    row: Number(first[side]) - 1,
    column: first.rawCode.length - first.rawCode.trimStart().length,
  };
  const end = {
    row: Number(last[side]) - 1,
    column: last.rawCode.trimEnd().length,
  };
  if (start.row === end.row && start.column > end.column) return undefined;
  const firstVisible = Number(visible[side]) - 1;
  let label: string | undefined;
  let depth = 0;
  for (let node = root.descendantForPosition(start, end); node !== null; node = node.parent) {
    if (++depth > maxContextDepth) return undefined;
    if (!functions.has(node.type) && !types.has(node.type)) continue;
    if (label === undefined) {
      label = declaration(node, source, firstVisible);
    } else if (types.has(node.type) && node.startPosition.row < firstVisible) {
      const owner = node.childForFieldName("name") ?? node.childForFieldName("type");
      if (owner !== null) label = `${owner.text} › ${label}`;
      break;
    }
  }
  return label !== undefined && label.length <= 240 && !/\p{Cc}/u.test(label) ? label : undefined;
}

export async function analyzeEditSyntax(path: string, before: string, after: string, diff: string) {
  if (before.length > 1024 * 1024 || after.length > 1024 * 1024 || diff.length > 65536) return undefined;
  const lines = parseDiffLines(diff);
  const oldLines = before.split("\n"),
    newLines = after.split("\n");
  for (const line of lines) {
    if (
      (line.beforeNumber !== "" && oldLines[Number(line.beforeNumber) - 1] !== line.rawCode) ||
      (line.afterNumber !== "" && newLines[Number(line.afterNumber) - 1] !== line.rawCode)
    )
      return undefined;
  }
  return withSyntaxTrees(path, before, after, (oldRoot, newRoot) => {
    if (oldRoot.hasError || newRoot.hasError) return undefined;
    const deadline = performance.now() + 100;
    const replacements: SyntaxReplacement[] = [],
      scopes: DiffScope[] = [];
    let index = 0;
    while (index < lines.length) {
      if (performance.now() >= deadline) return undefined;
      const row = index;
      while (lines[index]?.prefix !== undefined) {
        const start = index;
        while (lines[index]?.prefix === "-") index++;
        const added = index;
        while (lines[index]?.prefix === "+") index++;
        if (index === start) {
          index++;
        } else if (added - start === index - added && replacements.length < 2048) {
          for (let i = added; i < index && replacements.length < 2048; i++) {
            if (performance.now() >= deadline) return undefined;
            const oldLine = lines[start + i - added],
              newLine = lines[i];
            if (!oldLine || !newLine) continue;
            const change = replacement(oldRoot, newRoot, oldLine, newLine, i);
            if (change) replacements.push(change);
          }
        }
      }
      if (row < index && scopes.length < 32) {
        const hunk = lines.slice(row, index);
        const oldScope = scopeAt(oldRoot, before, "beforeNumber", hunk);
        const newScope = scopeAt(newRoot, after, "afterNumber", hunk);
        const scope = !hunk.some((line) => line.prefix === "-")
          ? newScope
          : !hunk.some((line) => line.prefix === "+") || oldScope === newScope
            ? oldScope
            : undefined;
        if (scope !== undefined) scopes.push({ row, label: scope });
      }
      index++; // unnumbered omission marker
    }
    return { replacements, scopes };
  });
}
