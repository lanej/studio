import { shellElapsed, shellOutputPreview } from "./shell-preview.ts";
import { parseArgs } from "node:util";
import { estimateShellUsage } from "./shell-usage.ts";
import { analyzeShell, prepareShellSyntax } from "./shell-syntax.ts";
import { registerCodingRenderer } from "./model-tools/rendering.ts";
import { type ShellHeredocs, shellHeredocs, prepareShellHeredoc } from "./shell-heredoc.ts";
import {
  type ExtensionAPI,
  type Theme,
  getLanguageFromPath,
  getMarkdownTheme,
  highlightCode,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Markdown,
  Spacer,
  Text,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { z } from "zod";

const MAX_HIGHLIGHT_BYTES = 50_000;
const commandArgs = z.object({ command: z.string() });
const searchArgs = commandArgs.extend({ sourceCommand: z.string().optional() });
const shellCallArgs = commandArgs.extend({ timeout: z.number().optional() });
const originalArgs = z.object({ invocationArgs: z.unknown() });

function highlightShellCommand(command: string, theme: Theme): string {
  const highlighted = highlightCode(command, "bash");
  const styles = analyzeShell(command)?.styles;
  if (!styles || styles.length > 256) return highlighted.join("\n");
  let offset = 0;
  let index = 0;
  // Slice the full Bash rendering so substitutions retain their surrounding quote colors.
  return command
    .split("\n")
    .map((line, row) => {
      const syntax = highlighted[row] ?? line;
      let rendered = "";
      let end = 0;
      while (index < styles.length) {
        const style = styles[index];
        if (!style || style.start >= offset + line.length) break;
        const start = style.start - offset;
        const column = visibleWidth(line.slice(0, end));
        rendered += sliceByColumn(syntax, column, visibleWidth(line.slice(0, start)) - column);
        rendered += theme.fg(style.role, style.role === "syntaxFunction" ? theme.bold(style.raw) : style.raw);
        end = start + style.raw.length;
        index++;
      }
      rendered += sliceByColumn(syntax, visibleWidth(line.slice(0, end)), Infinity);
      offset += line.length + 1;
      return rendered;
    })
    .join("\n");
}

type Highlighter = (text: string, language: string) => string[];

// Shell syntax establishes which commands can contribute output. Each tool's
// arguments establish whether its rows contain source and where the language is recorded.
interface SearchFile {
  path: string;
  language: string | undefined;
  numbered: boolean;
  context: boolean;
}

type SearchFormat =
  | { kind: "excerpt" | "numbered" | "unnumbered"; language: string }
  | { kind: "filename"; language?: undefined; files?: SearchFile[] };

type RipgrepOption = { type: "boolean"; short?: string; default: boolean } | { type: "string"; short?: string };

// These rg switches select source lines without rewriting them. parseArgs
// handles option values, short bundles like -nA8, long options, and --.
const rgOptions = {
  "line-number": { type: "boolean", short: "n", default: false },
  "with-filename": { type: "boolean", short: "H", default: false },
  "after-context": { type: "string", short: "A" },
  "before-context": { type: "string", short: "B" },
  context: { type: "string", short: "C" },
  "max-count": { type: "string", short: "m" },
  regexp: { type: "string", short: "e" },
  glob: { type: "string", short: "g" },
  iglob: { type: "string" },
  type: { type: "string", short: "t" },
  "type-not": { type: "string", short: "T" },
  "fixed-strings": { type: "boolean", short: "F", default: false },
  "ignore-case": { type: "boolean", short: "i", default: false },
  "smart-case": { type: "boolean", short: "S", default: false },
  "case-sensitive": { type: "boolean", short: "s", default: false },
  "word-regexp": { type: "boolean", short: "w", default: false },
  "line-regexp": { type: "boolean", short: "x", default: false },
  "no-heading": { type: "boolean", default: false },
  "no-ignore": { type: "boolean", default: false },
  "no-ignore-vcs": { type: "boolean", default: false },
  unrestricted: { type: "boolean", short: "u", default: false },
  follow: { type: "boolean", short: "L", default: false },
  color: { type: "string" },
  hidden: { type: "boolean", default: false },
} as const satisfies Record<string, RipgrepOption>;

function ripgrepFormat(args: string[]): SearchFormat | undefined {
  try {
    const { values, positionals } = parseArgs({
      args,
      options: rgOptions,
      allowPositionals: true,
      strict: true,
    });
    const files = values.regexp === undefined ? positionals.slice(1) : positionals;
    const path = files[0];
    const language = files.length === 1 && path !== undefined ? getLanguageFromPath(path) : undefined;
    const numbered = values["line-number"];
    if (values["with-filename"] || files.length > 1) {
      const context = [values["before-context"], values["after-context"], values.context].some(
        (value) => Number(value) > 0,
      );
      return {
        kind: "filename",
        files: files.map((path) => ({
          path,
          language: getLanguageFromPath(path),
          numbered,
          context,
        })),
      };
    }
    if (language === undefined) return { kind: "filename" };
    return {
      kind: numbered ? "numbered" : "unnumbered",
      language,
    };
  } catch {
    // Unknown options can change the record format, e.g. --json or --replace.
    return undefined;
  }
}

function searchFormat(words: string[]): SearchFormat | undefined {
  const [command, option, script, file] = words;
  if (command === "rg") return ripgrepFormat(words.slice(1));
  if (
    command === "sed" &&
    option === "-n" &&
    words.length === 4 &&
    script !== undefined &&
    /^\d+(?:,(?:\d+|\$))?p$/u.test(script) &&
    file !== undefined
  ) {
    const language = getLanguageFromPath(file);
    if (language !== undefined) return { kind: "excerpt", language };
  }
  return undefined;
}

function shellSearchFormat(args: unknown, output: string): SearchFormat | undefined {
  const parsed = searchArgs.safeParse(args);
  if (!parsed.success) return undefined;
  const commands = analyzeShell(parsed.data.sourceCommand ?? parsed.data.command)?.commands;
  if (!commands) return undefined;
  const formats = commands.filter(([command]) => command !== "cd").map(searchFormat);
  if (formats.length !== commands.length && /^\//mu.test(output)) {
    // A CDPATH lookup may have printed this absolute path. Bare excerpts
    // cannot distinguish it from source; a numbered search can, unless the
    // path itself looks like a filename-prefixed search record.
    if (formats.some((format) => format?.kind !== "numbered") || /^\/[^\n]*?([:-])\d+\1/mu.test(output))
      return undefined;
  }
  const first = formats[0];
  if (!first || formats.length === 1) return first;
  if (formats.every((format) => format?.kind === "filename"))
    return {
      kind: "filename",
      files: formats.flatMap((format) => format.files ?? []),
    };
  // The shell returns one stream without command boundaries. Bare rows need
  // a common interpretation across every possible producer, including || arms.
  if (formats.every((format) => format?.kind === first.kind && format.language === first.language)) return first;
  return formats.every((format) => format?.kind === "numbered" || format?.kind === "filename")
    ? { kind: "filename" }
    : undefined;
}

function highlightExplicitFile(line: string, files: SearchFile[], highlight: Highlighter): string | undefined {
  let start: number | undefined;
  let language: string | undefined;
  for (const file of files) {
    if (!line.startsWith(file.path)) continue;
    const separator = line[file.path.length];
    if (separator !== ":" && !(separator === "-" && file.context)) continue;
    let offset = file.path.length + 1;
    if (file.numbered) {
      const gutter = /^(\d+)([:-])/u.exec(line.slice(offset));
      if (gutter?.[2] !== separator) continue;
      offset += gutter[0].length;
    }
    // Hyphenated filenames may themselves start with another filename and a
    // context separator. A row has no escaping to resolve that ambiguity.
    if (start !== undefined && (start !== offset || language !== file.language)) return line;
    start = offset;
    language = file.language;
  }
  if (start === undefined) return undefined;
  return language === undefined ? line : line.slice(0, start) + highlight(line.slice(start), language).join("\n");
}

function highlightSearchRow(line: string, format: SearchFormat, highlight: Highlighter): string {
  if (line === "" || line === "--" || line.startsWith("rg:") || line.startsWith("binary file matches")) return line;
  if (format.kind === "unnumbered") return highlight(line, format.language).join("\n");
  if (format.kind === "filename" && format.files) {
    const named = highlightExplicitFile(line, format.files, highlight);
    if (named !== undefined) return named;
  }
  const numbered = /^(\d+[:-])(.*)$/u.exec(line);
  if (numbered !== null) {
    const code = numbered[2] ?? "";
    return format.language === undefined ? line : (numbered[1] ?? "") + highlight(code, format.language).join("\n");
  }
  const match = /^(.+?)([:-])(\d+)\2(.*)$/u.exec(line);
  const language = match?.[1] === undefined ? undefined : getLanguageFromPath(match[1]);
  const code = match?.[4];
  return language === undefined || code === undefined
    ? line
    : line.slice(0, line.length - code.length) + highlight(code, language).join("\n");
}

export function highlightSearchOutput(
  tool: string,
  args: unknown,
  output: string,
  highlight: Highlighter = highlightCode,
): string {
  if (Buffer.byteLength(output) > MAX_HIGHLIGHT_BYTES || output.includes("\x1b")) return output;
  const format: SearchFormat | undefined =
    tool === "grep" ? { kind: "filename" } : tool === "bash" ? shellSearchFormat(args, output) : undefined;
  if (!format) return output;
  const footer = /\n\n\[(?:Showing[^\n]*Full output:|Command exited with code)[\s\S]*$/u.exec(output);
  const text = footer === null ? output : output.slice(0, footer.index);
  const styled =
    format.kind === "excerpt"
      ? highlight(text, format.language)
      : text.split("\n").map((line) => highlightSearchRow(line, format, highlight));
  return styled.join("\n") + (footer?.[0] ?? "");
}

const outputDetails = z
  .object({
    truncation: z.object({ truncated: z.boolean().optional() }).optional(),
    fullOutputPath: z.string().optional(),
    matchLimitReached: z.number().optional(),
    linesTruncated: z.boolean().optional(),
  })
  .loose();

// Pi invalidates terminal components after a theme change or when deferred grammars load.
class HighlightedText extends Text {
  constructor(private readonly highlight: () => string) {
    super(highlight(), 0, 0);
  }

  override invalidate(): void {
    this.setText(this.highlight());
    super.invalidate();
  }
}

class HeredocShellCall extends Container {
  constructor(
    readonly header: Text,
    readonly command: string,
    readonly heredocs: ShellHeredocs,
    theme: Theme,
  ) {
    super();
    this.addChild(header);
    for (const [index, document] of heredocs.documents.entries()) {
      if (index > 0) {
        this.addChild(new Spacer(1));
        this.addChild(new HighlightedText(() => highlightShellCommand(document.header, theme)));
      }
      this.addChild(new Spacer(1));
      if (document.language === "markdown") {
        this.addChild(new Markdown(document.body, 0, 0, getMarkdownTheme()));
      } else {
        // The last newline separates the body from its closing delimiter.
        const source = document.body.replace(/\n$/u, "");
        this.addChild(new HighlightedText(() => highlightCode(source, document.language).join("\n")));
      }
    }
    if (heredocs.following !== "") {
      this.addChild(new Spacer(1));
      this.addChild(new HighlightedText(() => highlightShellCommand(heredocs.following, theme)));
    }
  }
}

export function registerSearchRendering(pi: ExtensionAPI): void {
  pi.on("session_start", async () => {
    await Promise.all([prepareShellSyntax(), prepareShellHeredoc()]);
  });
  const painted = new WeakSet<Component>();
  registerCodingRenderer(pi, (name, next) => {
    const base = next();
    if (name !== "bash" && name !== "grep") return base;
    const render = base?.renderResult;
    if (!render) return base;
    const renderCall = base.renderCall;
    return {
      ...base,
      ...(name === "bash" && renderCall
        ? {
            renderCall(args, theme, context) {
              // Pi owns the timer and reuses the header Text when a preview expands or collapses.
              const previous = context.lastComponent;
              const header = previous instanceof HeredocShellCall ? previous.header : previous;
              const component = renderCall(args, theme, {
                ...context,
                displayToolName: "$",
                lastComponent: header instanceof Text ? header : undefined,
              });
              const parsed = shellCallArgs.safeParse(args);
              if (!parsed.success || !(component instanceof Text)) return component;
              const { command, timeout } = parsed.data;
              if (command.trim() === "" || command.includes("\x1b") || Buffer.byteLength(command) > MAX_HIGHLIGHT_BYTES)
                return component;
              const prompt = theme.fg("toolTitle", theme.bold("$"));
              // Replayed calls receive a final result without an args-complete event.
              const currentPreview =
                previous instanceof HeredocShellCall && previous.command === command && previous.header === component
                  ? previous
                  : undefined;
              const heredocs =
                !context.expanded && (context.argsComplete || context.executionStarted || !context.isPartial)
                  ? (currentPreview?.heredocs ?? shellHeredocs(command))
                  : undefined;
              const syntax = highlightShellCommand(heredocs?.documents[0].header ?? command, theme);
              const suffix =
                timeout !== undefined && timeout !== 0 ? theme.fg("muted", ` (timeout ${timeout.toString()}s)`) : "";
              component.setText(`${prompt} ${syntax}${suffix}`);
              if (heredocs) {
                return currentPreview ?? new HeredocShellCall(component, command, heredocs, theme);
              }
              return component;
            },
          }
        : {}),
      renderResult(result, options, theme, context) {
        const details = outputDetails.safeParse(result.details);
        const block = result.content[0];
        const eligible =
          !options.isPartial &&
          !context.isError &&
          result.isError !== true &&
          result.content.length === 1 &&
          block?.type === "text" &&
          !block.text.includes("\x1b") &&
          !(
            details.success &&
            (details.data.truncation?.truncated === true ||
              details.data.fullOutputPath !== undefined ||
              details.data.matchLimitReached !== undefined ||
              details.data.linesTruncated === true)
          );
        const args: unknown = context.args;
        if (name === "bash") {
          const state: unknown = context.state;
          const invocation = originalArgs.safeParse(args);
          const usage = options.isPartial
            ? undefined
            : estimateShellUsage(
                context.displayToolName ?? name,
                invocation.success ? (invocation.data.invocationArgs ?? args) : args,
                result,
              );
          return render(result, options, theme, {
            ...context,
            renderShellOutput(output, timerText) {
              const styled = eligible ? highlightSearchOutput(name, args, output) : output;
              const source =
                styled === output
                  ? output
                      .split("\n")
                      .map((line) => (line === "" ? "" : theme.fg("toolOutput", line)))
                      .join("\n")
                  : styled;
              return shellOutputPreview(source, theme, {
                expanded: options.expanded,
                tokens: !usage ? undefined : usage.call + usage.result,
                elapsed: shellElapsed(timerText, context.durationMs, state),
              });
            },
          });
        }
        const fallback = () =>
          render(
            result,
            options,
            theme,
            context.lastComponent && painted.has(context.lastComponent)
              ? { ...context, lastComponent: undefined }
              : context,
          );
        if (!eligible) return fallback();
        const highlighted = highlightSearchOutput(name, args, block.text);
        if (highlighted === block.text) return fallback();
        const component: Component = {
          invalidate() {},
          render(width) {
            const rows = wrapTextWithAnsi(highlighted.trimEnd(), Math.max(1, width));
            if (options.expanded || rows.length <= 15) return ["", ...rows];
            const hint = truncateToWidth(
              theme.fg("muted", `... (${(rows.length - 15).toString()} more lines,`) +
                ` ${context.keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
              width,
            );
            return ["", ...rows.slice(0, 15), hint];
          },
        };
        painted.add(component);
        return component;
      },
    };
  });
}
