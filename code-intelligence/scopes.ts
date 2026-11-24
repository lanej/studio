import { DocumentSymbol, SymbolKind } from "vscode-languageserver-protocol";
import { z } from "zod";
import { parseDiffLines } from "./diff.ts";

/** The zero-based row in Pi's numbered diff where this scope should appear. */
export const diffScope = z.object({
  row: z.number().int().nonnegative(),
  label: z.string().min(1).max(240),
});
export type DiffScope = z.infer<typeof diffScope>;

const callable = new Set<SymbolKind>([
  SymbolKind.Function,
  SymbolKind.Method,
  SymbolKind.Constructor,
]);
const containers = new Set<SymbolKind>([
  SymbolKind.Class,
  SymbolKind.Interface,
  SymbolKind.Struct,
  SymbolKind.Enum,
  SymbolKind.Namespace,
  SymbolKind.Module,
  SymbolKind.Object,
]);

function isContainer(symbol: DocumentSymbol, source: string[]): boolean {
  if (containers.has(symbol.kind)) return true;
  // tsserver describes type aliases as variables. Confirm the declaration at
  // its symbol location before treating an ordinary value as a type.
  if (symbol.kind !== SymbolKind.Variable) return false;
  const line = source[symbol.selectionRange.start.line] ?? "";
  return (
    /^\s*(?:export\s+)?(?:declare\s+)?type\s+([$_\p{ID_Start}][$\p{Join_Control}\p{ID_Continue}]*)/u.exec(
      line,
    )?.[1] === symbol.name
  );
}

function enclosingScopes(
  symbols: unknown,
  first: number,
  last: number,
  source: string[],
): DocumentSymbol[] {
  if (!Array.isArray(symbols)) return [];
  let siblings: readonly unknown[] = symbols;
  const enclosing: DocumentSymbol[] = [];
  for (let depth = 0; depth < 32 && siblings.length <= 2048; depth++) {
    const candidates = siblings
      .filter(DocumentSymbol.is)
      .filter(
        ({ range }) =>
          range.start.line <= first &&
          (range.end.line > last ||
            (range.end.line === last && range.end.character > 0)),
      );
    const symbol = candidates[0];
    if (candidates.length !== 1 || symbol === undefined) break;
    if (callable.has(symbol.kind) || isContainer(symbol, source))
      enclosing.push(symbol);
    siblings = symbol.children ?? [];
  }
  return enclosing;
}

function declaration(
  symbol: DocumentSymbol,
  source: string[],
  firstVisible: number,
): string {
  if (!callable.has(symbol.kind)) {
    if (symbol.kind === SymbolKind.Variable) return `type ${symbol.name}`;
    const header = source[symbol.selectionRange.start.line]?.trim() ?? "";
    if (
      header.length <= 180 &&
      header.includes(symbol.name) &&
      header.endsWith("{")
    )
      return header.replace(/\s*(?:=\s*)?\{$/u, "");
    return symbol.name;
  }
  // The server identifies the declaration. Only quote its signature when we have its body opener.
  const start = symbol.selectionRange.start.line;
  const parts: string[] = [];
  for (const line of source.slice(start, Math.min(start + 8, firstVisible))) {
    if (line.length > 240) break;
    parts.push(line.trim());
    const header = parts.join(" ");
    if (header.length > 200) break;
    if (
      header.endsWith("{") &&
      header.includes("(") &&
      header.split("(").length === header.split(")").length
    )
      return header.slice(0, -1).trimEnd();
    if (/\)\s*[^{}]*\{.+|;\s*$/u.test(line)) break;
  }
  return symbol.name;
}

function changedSpan(hunk: ReturnType<typeof parseDiffLines>): number[] {
  const anchors: number[] = [];
  let index = 0;
  while (index < hunk.length) {
    const start = index;
    while (hunk[index]?.prefix === "-") index++;
    const added = index;
    while (hunk[index]?.prefix === "+") {
      const line = hunk[index++];
      if (line !== undefined) anchors.push(Number(line.afterNumber) - 1);
    }
    if (start === index) {
      index++;
    } else if (added === index) {
      // A deletion has no position in the resulting document. Both adjacent
      // retained lines must vouch for its enclosing declaration.
      const before = hunk[start - 1];
      const after = hunk[index];
      if (before?.prefix !== " " || after?.prefix !== " ") return [];
      anchors.push(
        Number(before.afterNumber) - 1,
        Number(after.afterNumber) - 1,
      );
    }
  }
  return anchors;
}

export function resolveDiffScopes(
  diff: string,
  source: string,
  symbols: unknown,
): DiffScope[] {
  if (diff.length > 65536 || source.length > 1024 * 1024) return [];
  const sourceLines = source.split(/\r?\n/u);
  const lines = parseDiffLines(diff);
  const scopes: DiffScope[] = [];
  let index = 0;
  while (index < lines.length) {
    const row = index;
    while (lines[index]?.prefix !== undefined) index++;
    const hunk = lines.slice(row, index);
    index++; // Pi separates retained source ranges with an unnumbered omission marker.
    if (hunk.length === 0) continue;
    const surviving = hunk.filter((line) => line.afterNumber !== "");
    const firstVisible = surviving[0];
    if (firstVisible === undefined) continue;
    if (
      surviving.some(
        (line) => sourceLines[Number(line.afterNumber) - 1] !== line.rawCode,
      )
    )
      return []; // A subsequent edit changed this snapshot.
    const anchors = changedSpan(hunk);
    const first = anchors[0];
    const last = anchors.at(-1);
    if (first === undefined || last === undefined) continue;
    const visible = Number(firstVisible.afterNumber) - 1;
    const hidden = enclosingScopes(symbols, first, last, sourceLines).filter(
      (symbol) => symbol.selectionRange.start.line < visible,
    );
    const inner = hidden.at(-1);
    if (inner === undefined) continue;
    const owner = hidden
      .slice(0, -1)
      .findLast((symbol) => isContainer(symbol, sourceLines));
    const signature = declaration(inner, sourceLines, visible);
    const label =
      owner === undefined ? signature : `${owner.name} › ${signature}`;
    if (
      label.trim().length > 0 &&
      label.length <= 240 &&
      !/\p{Cc}/u.test(label)
    )
      scopes.push({ row, label });
    if (scopes.length >= 32) break;
  }
  return scopes;
}
