import { Parser, type Language, type Tree } from "@vscode/tree-sitter-wasm";
import {
  loadLanguage,
  type SyntaxNode,
} from "./code-intelligence/tree-sitter.ts";

interface ShellStyle {
  raw: string;
  start: number;
  role: "syntaxFunction" | "syntaxKeyword";
}

interface ShellAnalysis {
  styles: ShellStyle[];
  commands?: string[][];
}

let language: Language | undefined;
let preparation: Promise<void> | undefined;
const cache = new Map<string, ShellAnalysis | undefined>();

export function prepareShellSyntax(): Promise<void> {
  preparation ??= loadLanguage("bash").then(
    (loaded) => {
      language = loaded;
    },
    () => {
      // Generic shell highlighting remains available when WASM cannot load.
    },
  );
  return preparation;
}

function headerStyles(root: SyntaxNode): ShellStyle[] {
  const styles: ShellStyle[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    if (node.type.endsWith("_redirect")) continue;
    if (node.type === "command") {
      const name = node.childForFieldName("name");
      if (name !== null && /^[\w./-]+$/u.test(name.text))
        styles.push({
          raw: name.text,
          start: name.startIndex,
          role: "syntaxFunction",
        });
      for (const arg of node.childrenForFieldName("argument")) {
        if (arg === null) continue;
        if (literal(arg) === "--") break;
        if (arg.type !== "word" && arg.type !== "number") continue;
        const flag = /^--?(?:[A-Za-z][\w-]*|\d+)(?==|$)/u.exec(arg.text)?.[0];
        if (flag !== undefined)
          styles.push({
            raw: flag,
            start: arg.startIndex,
            role: "syntaxKeyword",
          });
      }
    }
    for (const child of node.namedChildren)
      if (child !== null) pending.push(child);
  }
  return styles.sort((a, b) => a.start - b.start);
}

// Tree-sitter supplies the word boundaries and quoting mode. Only resolve
// literal arguments: expansions and globs can change both argv and its length.
function literal(node: SyntaxNode): string | undefined {
  const raw = node.text;
  switch (node.type) {
    case "raw_string":
      return raw.slice(1, -1);
    case "string":
      return node.namedChildren.every(
        (child) => child?.type === "string_content",
      )
        ? raw
            .slice(1, -1)
            .replace(/\\(["$`\\\n])/gu, (_, escaped: string) =>
              escaped === "\n" ? "" : escaped,
            )
        : undefined;
    case "number":
      return raw;
    case "word":
      // Each escape consumes one literal character. Unescaped glob or brace
      // syntax can expand to several arguments, even within one word node.
      if (raw.startsWith("~") || !/^(?:\\[^\n]|[^\\*?[\]{}`$])+$/u.test(raw))
        return undefined;
      return raw.replace(/\\([^\n])/gu, "$1");
    case "concatenation": {
      let value = "";
      for (const child of node.namedChildren) {
        if (child === null) return undefined;
        const part = literal(child);
        if (part === undefined) return undefined;
        value += part;
      }
      return value;
    }
    default:
      return undefined;
  }
}

function commandWords(command: SyntaxNode): string[] | undefined {
  if (command.type !== "command") return undefined;
  const words: string[] = [];
  for (const [i, child] of command.children.entries()) {
    if (child === null) return undefined;
    const field = command.fieldNameForChild(i);
    if (field === "name") {
      const name = child.firstNamedChild;
      if (name === null) return undefined;
      const value = literal(name);
      if (value === undefined) return undefined;
      words.push(value);
    } else if (field === "argument") {
      const value = literal(child);
      if (value === undefined) return undefined;
      words.push(value);
    } else {
      return undefined;
    }
  }
  return words.length > 0 ? words : undefined;
}

function lineFilter(words: string[] | undefined): boolean {
  if (words === undefined) return false;
  const [name, option, count] = words;
  if (name !== "head" && name !== "tail") return false;
  if (option === undefined) return true;
  if (words.length === 2) return /^(?:-\d+|-n\d+|--lines=\d+)$/u.test(option);
  return (
    words.length === 3 &&
    (option === "-n" || option === "--lines") &&
    /^\d+$/u.test(count ?? "")
  );
}

// Collect every possible stdout producer. Following a sequence or branching
// list cannot identify which command produced a particular terminal row.
function outputCommands(node: SyntaxNode, commands: string[][]): boolean {
  if (node.type === "command") {
    const words = commandWords(node);
    if (words === undefined) return false;
    if (words[0] === "cd") {
      const path = words.at(-1);
      if (
        !(words.length === 2 || (words.length === 3 && words[1] === "--")) ||
        path === undefined ||
        path === "" ||
        path.startsWith("-") ||
        path.includes("\n")
      )
        return false;
      // Only bare relative paths are searched via CDPATH. On a successful
      // lookup Bash prints the absolute directory, alongside any search output.
      if (/^(?:\/|\.\.?(?:\/|$))/u.test(path)) return true;
    }
    commands.push(words);
    return true;
  }
  if (node.type === "pipeline") {
    let first = true;
    for (const stage of node.children) {
      if (stage === null) return false;
      if (stage.type === "comment" || stage.type === "|") continue;
      if (
        first
          ? !outputCommands(stage, commands)
          : !lineFilter(commandWords(stage))
      )
        return false;
      first = false;
    }
    return !first;
  }
  if (
    !["program", "list", "subshell", "compound_statement"].includes(node.type)
  )
    return false;
  for (const child of node.children) {
    if (child === null) return false;
    if ([";", "&&", "||", "(", ")", "{", "}", "comment"].includes(child.type))
      continue;
    if (!outputCommands(child, commands)) return false;
  }
  return true;
}

export function analyzeShell(command: string): ShellAnalysis | undefined {
  if (language === undefined || Buffer.byteLength(command) > 50_000)
    return undefined;
  if (cache.has(command)) return cache.get(command);
  let parser: Parser | undefined;
  let tree: Tree | null = null;
  let analysis: ShellAnalysis | undefined;
  try {
    parser = new Parser();
    parser.setLanguage(language);
    const deadline = performance.now() + 100;
    tree = parser.parse(command, null, {
      progressCallback: () => performance.now() >= deadline,
    });
    if (
      tree !== null &&
      !tree.rootNode.hasError &&
      tree.rootNode.descendantCount <= 4096
    ) {
      const root = tree.rootNode;
      const styles = headerStyles(root);
      const commands: string[][] = [];
      // Bash may join the word fragments on either side of a continuation;
      // this grammar reports them as separate arguments when no space intervenes.
      analysis =
        !/\S\\\r?\n(?=\S)/u.test(command) && outputCommands(root, commands)
          ? { styles, commands }
          : { styles };
    }
  } catch {
    // Incomplete or exceptionally complex input keeps Pi's generic rendering.
  } finally {
    tree?.delete();
    parser?.delete();
  }
  if (cache.size >= 16) {
    const oldest = cache.keys().next();
    if (oldest.done !== true) cache.delete(oldest.value);
  }
  cache.set(command, analysis);
  return analysis;
}
