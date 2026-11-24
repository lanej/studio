import { createRequire } from "node:module";
import { basename, extname } from "node:path";
import {
  Language,
  Parser,
  type Node as SyntaxNode,
  type Tree,
} from "@vscode/tree-sitter-wasm";

export type { SyntaxNode };
export const maxSyntaxSourceBytes = 1024 * 1024;

const extensions: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".cts": "typescript",
  ".mts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".cjs": "javascript",
  ".mjs": "javascript",
  ".go": "go",
  ".rs": "rust",
  ".py": "python",
  ".pyi": "python",
  ".pyw": "python",
  ".rb": "ruby",
  ".rake": "ruby",
  ".gemspec": "ruby",
  ".sh": "bash",
  ".bash": "bash",
  ".java": "java",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".cc": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".hh": "cpp",
  ".cs": "c-sharp",
  ".css": "css",
  ".ini": "ini",
  ".php": "php",
  ".ps1": "powershell",
  ".psm1": "powershell",
  ".psd1": "powershell",
  ".json": "json",
};

function grammarFor(path: string): string | undefined {
  const name = basename(path);
  if (name === "Gemfile" || name === "Rakefile") return "ruby";
  if (name === ".bashrc" || name === ".bash_profile") return "bash";
  return extensions[extname(name).toLowerCase()];
}

export function supportsSyntax(path: string): boolean {
  return grammarFor(path) !== undefined;
}

const require = createRequire(import.meta.url);
const languages = new Map<string, Promise<Language>>();
let initialized: Promise<void> | undefined;

function loadLanguage(grammar: string): Promise<Language> {
  const cached = languages.get(grammar);
  if (cached !== undefined) return cached;
  initialized ??= Parser.init({
    locateFile: () =>
      require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm"),
  });
  const asset =
    grammar === "json"
      ? "@lumis-sh/wasm-json/tree-sitter-json.wasm"
      : `@vscode/tree-sitter-wasm/wasm/tree-sitter-${grammar}.wasm`;
  const language = initialized.then(() =>
    Language.load(require.resolve(asset)),
  );
  languages.set(grammar, language);
  return language;
}

/** Consume these nodes synchronously. Their WASM trees are released after the callback. */
export async function withSyntaxTrees<T>(
  path: string,
  before: string,
  after: string,
  visit: (beforeRoot: SyntaxNode, afterRoot: SyntaxNode) => T,
): Promise<T | undefined> {
  const grammar = grammarFor(path);
  if (
    grammar === undefined ||
    Buffer.byteLength(before) > maxSyntaxSourceBytes ||
    Buffer.byteLength(after) > maxSyntaxSourceBytes
  )
    return undefined;
  let parser: Parser | undefined;
  let oldTree: Tree | null = null;
  let newTree: Tree | null = null;
  try {
    const language = await loadLanguage(grammar);
    parser = new Parser();
    parser.setLanguage(language);
    const deadline = performance.now() + 100;
    const options = { progressCallback: () => performance.now() >= deadline };
    oldTree = parser.parse(before, null, options);
    if (oldTree === null) return undefined;
    newTree = parser.parse(after, null, options);
    if (newTree === null) return undefined;
    return visit(oldTree.rootNode, newTree.rootNode);
  } catch {
    // Syntax decoration is optional, including when an installed grammar fails to load.
    return undefined;
  } finally {
    newTree?.delete();
    oldTree?.delete();
    parser?.delete();
  }
}
