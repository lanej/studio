import { parseArgs } from "node:util";
import { Parser, type Language, type Tree } from "@vscode/tree-sitter-wasm";
import {
  loadLanguage,
  type SyntaxNode,
} from "./code-intelligence/tree-sitter.ts";

let bash: Language | undefined;

export async function prepareMarkdownHeredoc(): Promise<void> {
  try {
    bash = await loadLanguage("bash");
  } catch {
    // Shell rendering still works without the optional syntax decoration.
  }
}

export interface MarkdownHeredoc {
  header: string;
  body: string;
  following: string;
}

function literalArgument(node: SyntaxNode | null): string | undefined {
  if (node === null) return undefined;
  if (node.type === "number") return node.text;
  if (node.type === "word" && !/[\\$`*?[{~]/u.test(node.text)) return node.text;
  if (
    node.type === "raw_string" ||
    (node.type === "string" &&
      node.namedChildren.every((child) => child?.type === "string_content") &&
      !node.text.includes("\\"))
  )
    return node.text.slice(1, -1);
  return undefined;
}

const createFlags = {
  assignee: { type: "string", short: "a" },
  label: { type: "string", short: "l" },
} as const;

const prCreateFlags = {
  head: { type: "string", short: "H" },
  draft: { type: "boolean", short: "d" },
  reviewer: { type: "string", short: "r" },
} as const;

const reviewFlags = {
  approve: { type: "boolean", short: "a" },
  comment: { type: "boolean", short: "c" },
  "request-changes": { type: "boolean", short: "r" },
} as const;

// Only options whose arity we know can establish that "-" is the body file.
// An unknown switch or an expansion could consume or replace that argument.
function readsGithubBody(command: SyntaxNode, gap: string): boolean {
  if (
    command.type !== "command" ||
    command.childForFieldName("name")?.text !== "gh" ||
    /\S\\\r?\n(?=\S)/u.test(command.text)
  )
    return false;
  const args: string[] = [];
  for (const node of command.childrenForFieldName("argument")) {
    const value = literalArgument(node);
    if (value === undefined) return false;
    args.push(value);
  }
  // This Bash grammar leaves a final standalone hyphen outside the command node.
  if (/^[ \t]+-[ \t]*$/u.test(gap)) args.push("-");
  else if (!/^[ \t]*$/u.test(gap)) return false;
  const [noun, verb, ...flags] = args;
  if (
    !(
      (noun === "issue" || noun === "pr") &&
      (verb === "create" ||
        verb === "edit" ||
        verb === "comment" ||
        (noun === "pr" && verb === "review"))
    )
  )
    return false;
  const { values } = parseArgs({
    args: flags,
    allowPositionals: true,
    options: {
      "body-file": { type: "string", short: "F", multiple: true },
      repo: { type: "string", short: "R" },
      ...(verb === "create" || verb === "edit"
        ? ({ title: { type: "string", short: "t" } } as const)
        : {}),
      ...(noun === "pr" && (verb === "create" || verb === "edit")
        ? ({ base: { type: "string", short: "B" } } as const)
        : {}),
      ...(verb === "create" ? createFlags : {}),
      ...(noun === "pr" && verb === "create" ? prCreateFlags : {}),
      ...(verb === "review" ? reviewFlags : {}),
    },
  });
  const files = values["body-file"];
  return files?.length === 1 && files[0] === "-";
}

function splitHeredoc(
  source: string,
  root: SyntaxNode,
): MarkdownHeredoc | undefined {
  const statement = root.namedChildren.find(
    (child) => child?.type === "redirected_statement",
  );
  if (statement?.namedChildCount !== 2) return undefined;
  const command = statement.firstNamedChild;
  const redirect = statement.lastNamedChild;
  if (
    command === null ||
    redirect?.type !== "heredoc_redirect" ||
    redirect.childCount !== 4 ||
    !readsGithubBody(
      command,
      source.slice(command.endIndex, redirect.startIndex),
    )
  )
    return undefined;
  const [operator, start, , end] = redirect.children;
  if (
    (operator?.text !== "<<" && operator?.text !== "<<-") ||
    start?.type !== "heredoc_start" ||
    end?.type !== "heredoc_end" ||
    end.text === ""
  )
    return undefined;

  // The grammar can omit leading whitespace from the body and accept a closing
  // token in the middle of a physical line. Validate the lines before slicing.
  const openingNewline = source.indexOf("\n", start.endIndex);
  const closingLine = source.lastIndexOf("\n", end.startIndex - 1) + 1;
  const indent = source.slice(closingLine, end.startIndex);
  if (
    openingNewline === -1 ||
    closingLine <= openingNewline ||
    !/^[ \t]*$/u.test(source.slice(start.endIndex, openingNewline)) ||
    (indent !== "" && (operator.text !== "<<-" || !/^\t+$/u.test(indent))) ||
    (end.endIndex < source.length && source[end.endIndex] !== "\n")
  )
    return undefined;

  const body = source.slice(openingNewline + 1, closingLine);
  // Quoting any part of the delimiter disables Bash's expansion of the body.
  // For an unquoted marker only preview bodies that are already literal.
  if (start.text === end.text) {
    if (/[$`\\]/u.test(body)) return undefined;
  } else if (
    !(start.text === "'" + end.text + "'" && !end.text.includes("'")) &&
    !(start.text === '"' + end.text + '"' && !/["\\]/u.test(end.text)) &&
    !(start.text === "\\" + end.text && /^[\w.-]+$/u.test(end.text))
  )
    return undefined;
  return {
    header: source.slice(0, redirect.startIndex).trimEnd(),
    body: operator.text === "<<-" ? body.replace(/(^|\n)\t+/gu, "$1") : body,
    following: source.slice(end.endIndex + 1),
  };
}

export function markdownHeredoc(command: string): MarkdownHeredoc | undefined {
  if (
    bash === undefined ||
    !command.includes("<<") ||
    Buffer.byteLength(command) > 50_000 ||
    /[^\P{Cc}\n\t]/u.test(command)
  )
    return undefined;
  let parser: Parser | undefined;
  let tree: Tree | null = null;
  try {
    parser = new Parser();
    parser.setLanguage(bash);
    const deadline = performance.now() + 100;
    tree = parser.parse(command, null, {
      progressCallback: () => performance.now() >= deadline,
    });
    if (
      tree !== null &&
      !tree.rootNode.hasError &&
      tree.rootNode.descendantCount <= 4096
    )
      return splitHeredoc(command, tree.rootNode);
  } catch {
    // Unsupported argument shapes and incomplete shell input keep the raw call.
  } finally {
    tree?.delete();
    parser?.delete();
  }
  return undefined;
}
