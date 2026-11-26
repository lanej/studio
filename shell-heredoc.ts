import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { Parser, type Language, type Tree } from "@vscode/tree-sitter-wasm";
import { loadLanguage, type SyntaxNode } from "./code-intelligence/tree-sitter.ts";

let bash: Language | undefined;
// Use Pi's registry. Loading all grammars on the first language marker keeps
// sessions that never display a heredoc off that startup path.
const requireHighlighter: (id: "highlight.js") => typeof import("highlight.js") = createRequire(import.meta.url);

export async function prepareShellHeredoc(): Promise<void> {
  try {
    bash = await loadLanguage("bash");
  } catch {
    // Shell rendering still works without the optional syntax decoration.
  }
}

export interface ShellHeredoc {
  header: string;
  body: string;
  language: string;
}

export interface ShellHeredocs {
  documents: [ShellHeredoc, ...ShellHeredoc[]];
  following: string;
}

function taggedLanguage(marker: string): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9_+#-]*$/u.test(marker)) return undefined;
  const tag = marker.toLowerCase();
  const mapped = tag === "shell" ? "bash" : getLanguageFromPath(tag);
  const language = typeof mapped === "string" ? mapped : tag;
  return requireHighlighter("highlight.js").getLanguage(language) === undefined ? undefined : language;
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
      (verb === "create" || verb === "edit" || verb === "comment" || (noun === "pr" && verb === "review"))
    )
  )
    return false;
  try {
    const { values } = parseArgs({
      args: flags,
      allowPositionals: true,
      options: {
        "body-file": { type: "string", short: "F", multiple: true },
        repo: { type: "string", short: "R" },
        ...(verb === "create" || verb === "edit" ? ({ title: { type: "string", short: "t" } } as const) : {}),
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
  } catch {
    return false;
  }
}

// stdout and stderr file redirects may sit on either side of a heredoc.
function outputRedirect(node: SyntaxNode | null): boolean {
  return (
    node?.type === "file_redirect" &&
    node.childForFieldName("descriptor")?.text !== "0" &&
    node.children.some((child) => child !== null && [">", ">>", ">|", ">&", "&>", "&>>"].includes(child.type))
  );
}

function splitHeredoc(
  source: string,
  statement: SyntaxNode,
  from: number,
): { document: ShellHeredoc; after: number } | undefined {
  const redirects = statement.childrenForFieldName("redirect");
  const redirect = redirects.find((child) => child?.type === "heredoc_redirect");
  const command = statement.childForFieldName("body");
  if (
    command === null ||
    redirect === null ||
    !redirect ||
    redirects.some((child) => child?.id !== redirect.id && !outputRedirect(child))
  )
    return undefined;
  const children = redirect.children;
  const [operator, start] = children;
  const end = children.at(-1);
  const extras = children.slice(2, -2);
  if (
    (operator?.text !== "<<" && operator?.text !== "<<-") ||
    start?.type !== "heredoc_start" ||
    children.at(-2)?.type !== "heredoc_body" ||
    end?.type !== "heredoc_end" ||
    end.text === ""
  )
    return undefined;
  const tag = taggedLanguage(end.text);
  if (
    !extras.every(
      (child) =>
        child?.type === "comment" ||
        outputRedirect(child) ||
        (tag !== undefined && child?.type === "pipeline" && child.descendantsOfType("heredoc_redirect").length === 0),
    )
  )
    return undefined;
  const headerEnd = extras.at(-1)?.endIndex ?? start.endIndex;

  // The grammar can omit leading whitespace from the body and accept a closing
  // token in the middle of a physical line. Validate the lines before slicing.
  const openingNewline = source.indexOf("\n", headerEnd);
  const closingLine = source.lastIndexOf("\n", end.startIndex - 1) + 1;
  const indent = source.slice(closingLine, end.startIndex);
  if (
    openingNewline === -1 ||
    closingLine <= openingNewline ||
    !/^[ \t]*$/u.test(source.slice(headerEnd, openingNewline)) ||
    (indent !== "" && (operator.text !== "<<-" || !/^\t+$/u.test(indent))) ||
    (end.endIndex < source.length && source[end.endIndex] !== "\n")
  )
    return undefined;

  const body = source.slice(openingNewline + 1, closingLine);
  const quoted = start.text !== end.text;
  if (
    quoted &&
    !(start.text === "'" + end.text + "'" && !end.text.includes("'")) &&
    !(start.text === '"' + end.text + '"' && !/["\\]/u.test(end.text)) &&
    !(start.text === "\\" + end.text && /^[\w.-]+$/u.test(end.text))
  )
    return undefined;

  if (
    tag === undefined &&
    ((!quoted && /[$`\\]/u.test(body)) ||
      !readsGithubBody(command, source.slice(command.endIndex, redirects[0]?.startIndex ?? redirect.startIndex)))
  )
    return undefined;
  // A language marker describes the authored source, including literal shell
  // expressions. Keep it with the invocation so that its quoting stays visible.
  const header =
    tag === undefined
      ? source.slice(from, redirect.startIndex).trimEnd() + source.slice(start.endIndex, openingNewline)
      : source.slice(from, openingNewline);
  return {
    document: {
      header: header.trimEnd(),
      body: operator.text === "<<-" ? body.replace(/(^|\n)\t+/gu, "$1") : body,
      language: tag ?? "markdown",
    },
    after: end.endIndex + 1,
  };
}

export function shellHeredocs(command: string): ShellHeredocs | undefined {
  if (!bash || !command.includes("<<") || Buffer.byteLength(command) > 50_000 || /[^\P{Cc}\n\t]/u.test(command))
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
    if (tree === null || tree.rootNode.hasError || tree.rootNode.descendantCount > 4096) return undefined;
    let from = 0;
    let result: ShellHeredocs | undefined;
    for (const statement of tree.rootNode.namedChildren) {
      if (statement?.type !== "redirected_statement") continue;
      const part = splitHeredoc(command, statement, from);
      if (!part) continue;
      if (!result) result = { documents: [part.document], following: "" };
      else result.documents.push(part.document);
      from = part.after;
    }
    if (result) result.following = command.slice(from);
    return result;
  } catch {
    // Unsupported argument shapes and incomplete shell input keep the raw call.
  } finally {
    tree?.delete();
    parser?.delete();
  }
  return undefined;
}
