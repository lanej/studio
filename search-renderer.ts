import { parseArgs } from "node:util";
import { analyzeShell, prepareShellSyntax } from "./shell-syntax.ts";
import { registerCodingRenderer } from "./model-tools/rendering.ts";
import {
  type ExtensionAPI,
  type Theme,
  getLanguageFromPath,
  highlightCode,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
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

function highlightShellCommand(command: string, theme: Theme): string {
  const highlighted = highlightCode(command, "bash");
  const styles = analyzeShell(command)?.styles;
  if (styles === undefined || styles.length > 256)
    return highlighted.join("\n");
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
        if (style === undefined || style.start >= offset + line.length) break;
        const start = style.start - offset;
        const column = visibleWidth(line.slice(0, end));
        rendered += sliceByColumn(
          syntax,
          column,
          visibleWidth(line.slice(0, start)) - column,
        );
        rendered += theme.fg(
          style.role,
          style.role === "syntaxFunction" ? theme.bold(style.raw) : style.raw,
        );
        end = start + style.raw.length;
        index++;
      }
      rendered += sliceByColumn(
        syntax,
        visibleWidth(line.slice(0, end)),
        Infinity,
      );
      offset += line.length + 1;
      return rendered;
    })
    .join("\n");
}

type Highlighter = (text: string, language: string) => string[];

// Shell syntax establishes which commands can contribute output. Each tool's
// arguments establish whether its rows contain source and where the language is recorded.
type SearchFormat =
  | { kind: "excerpt" | "numbered" | "unnumbered"; language: string }
  | { kind: "filename"; language?: undefined };

// These rg switches select source lines without rewriting them. parseArgs
// handles option values, short bundles like -nA8, long options, and --.
const rgOptions = {
  "line-number": { type: "boolean", short: "n" },
  "with-filename": { type: "boolean", short: "H" },
  "after-context": { type: "string", short: "A" },
  "before-context": { type: "string", short: "B" },
  context: { type: "string", short: "C" },
  "max-count": { type: "string", short: "m" },
  regexp: { type: "string", short: "e" },
  glob: { type: "string", short: "g" },
  iglob: { type: "string" },
  type: { type: "string", short: "t" },
  "type-not": { type: "string", short: "T" },
  "fixed-strings": { type: "boolean", short: "F" },
  "ignore-case": { type: "boolean", short: "i" },
  "smart-case": { type: "boolean", short: "S" },
  "case-sensitive": { type: "boolean", short: "s" },
  "word-regexp": { type: "boolean", short: "w" },
  "line-regexp": { type: "boolean", short: "x" },
  "no-heading": { type: "boolean" },
  "no-ignore": { type: "boolean" },
  hidden: { type: "boolean" },
} as const;

function ripgrepFormat(args: string[]): SearchFormat | undefined {
  try {
    const { values, positionals } = parseArgs({
      args,
      options: rgOptions,
      allowPositionals: true,
      strict: true,
    });
    const files =
      values.regexp === undefined ? positionals.slice(1) : positionals;
    const path = files[0];
    const language =
      files.length === 1 && path !== undefined
        ? getLanguageFromPath(path)
        : undefined;
    if (values["with-filename"] === true || language === undefined)
      return { kind: "filename" };
    return {
      kind: values["line-number"] === true ? "numbered" : "unnumbered",
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

function shellSearchFormat(args: unknown): SearchFormat | undefined {
  const parsed = searchArgs.safeParse(args);
  if (!parsed.success) return undefined;
  const commands = analyzeShell(
    parsed.data.sourceCommand ?? parsed.data.command,
  )?.commands;
  if (commands === undefined) return undefined;
  const formats = commands.map(searchFormat);
  const first = formats[0];
  if (first === undefined) return undefined;
  // The shell returns one stream without command boundaries. Bare rows need
  // a common interpretation across every possible producer, including || arms.
  if (
    formats.every(
      (format) =>
        format?.kind === first.kind && format.language === first.language,
    )
  )
    return first;
  return formats.every(
    (format) => format?.kind === "numbered" || format?.kind === "filename",
  )
    ? { kind: "filename" }
    : undefined;
}

function highlightSearchRow(
  line: string,
  format: SearchFormat,
  highlight: Highlighter,
): string {
  if (
    line === "" ||
    line === "--" ||
    line.startsWith("rg:") ||
    line.startsWith("binary file matches")
  )
    return line;
  if (format.kind === "unnumbered")
    return highlight(line, format.language).join("\n");
  const numbered = /^(\d+[:-])(.*)$/u.exec(line);
  if (numbered !== null) {
    const code = numbered[2] ?? "";
    return format.language === undefined
      ? line
      : (numbered[1] ?? "") + highlight(code, format.language).join("\n");
  }
  const match = /^(.+?)([:-])(\d+)\2(.*)$/u.exec(line);
  const language =
    match?.[1] === undefined ? undefined : getLanguageFromPath(match[1]);
  const code = match?.[4];
  return language === undefined || code === undefined
    ? line
    : line.slice(0, line.length - code.length) +
        highlight(code, language).join("\n");
}

export function highlightSearchOutput(
  tool: string,
  args: unknown,
  output: string,
  highlight: Highlighter = highlightCode,
): string {
  if (
    Buffer.byteLength(output) > MAX_HIGHLIGHT_BYTES ||
    output.includes("\x1b")
  )
    return output;
  const format: SearchFormat | undefined =
    tool === "grep"
      ? { kind: "filename" }
      : tool === "bash"
        ? shellSearchFormat(args)
        : undefined;
  if (format === undefined) return output;
  const footer =
    /\n\n\[(?:Showing[^\n]*Full output:|Command exited with code)[\s\S]*$/u.exec(
      output,
    );
  const text = footer === null ? output : output.slice(0, footer.index);
  const styled =
    format.kind === "excerpt"
      ? highlight(text, format.language)
      : text
          .split("\n")
          .map((line) => highlightSearchRow(line, format, highlight));
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

export function registerSearchRendering(pi: ExtensionAPI): void {
  pi.on("session_start", prepareShellSyntax);
  const painted = new WeakSet<Component>();
  registerCodingRenderer(pi, (name, next) => {
    const base = next();
    if (name !== "bash" && name !== "grep") return base;
    const render = base?.renderResult;
    if (render === undefined) return base;
    const renderCall = base?.renderCall;
    return {
      ...base,
      ...(name === "bash" && renderCall !== undefined
        ? {
            renderCall(args, theme, context) {
              // Let Pi start its tool timer and reuse its width-aware text component.
              const component = renderCall(args, theme, context);
              const parsed = shellCallArgs.safeParse(args);
              if (!parsed.success || !(component instanceof Text))
                return component;
              const { command, timeout } = parsed.data;
              if (
                command.trim() === "" ||
                command.includes("\x1b") ||
                Buffer.byteLength(command) > MAX_HIGHLIGHT_BYTES
              )
                return component;
              const prompt = theme.fg(
                "toolTitle",
                theme.bold(context.displayToolName ?? "$"),
              );
              const syntax = highlightShellCommand(command, theme);
              const suffix =
                timeout !== undefined && timeout !== 0
                  ? theme.fg("muted", ` (timeout ${timeout.toString()}s)`)
                  : "";
              component.setText(`${prompt} ${syntax}${suffix}`);
              return component;
            },
          }
        : {}),
      renderResult(result, options, theme, context) {
        const fallback = () =>
          render(
            result,
            options,
            theme,
            context.lastComponent !== undefined &&
              painted.has(context.lastComponent)
              ? { ...context, lastComponent: undefined }
              : context,
          );
        const block = result.content[0];
        if (
          options.isPartial ||
          context.isError ||
          result.isError === true ||
          result.content.length !== 1 ||
          block?.type !== "text"
        )
          return fallback();
        const details = outputDetails.safeParse(result.details);
        if (
          details.success &&
          (details.data.truncation?.truncated === true ||
            details.data.fullOutputPath !== undefined ||
            details.data.matchLimitReached !== undefined ||
            details.data.linesTruncated === true)
        )
          return fallback();
        const args: unknown = context.args;
        const highlighted = highlightSearchOutput(name, args, block.text);
        if (highlighted === block.text) return fallback();

        const component = new Container();
        component.addChild({
          invalidate() {},
          render(width) {
            const rows = wrapTextWithAnsi(
              highlighted.trimEnd(),
              Math.max(1, width),
            );
            const limit = name === "bash" ? 5 : 15;
            if (options.expanded || rows.length <= limit) return ["", ...rows];
            const hidden = rows.length - limit;
            const direction = name === "bash" ? "earlier" : "more";
            const hint = truncateToWidth(
              theme.fg(
                "muted",
                `... (${hidden.toString()} ${direction} lines,`,
              ) +
                ` ${context.keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
              width,
            );
            return name === "bash"
              ? ["", hint, ...rows.slice(-limit)]
              : ["", ...rows.slice(0, limit), hint];
          },
        });
        // The native shell renderer owns the live timer and its recorded duration.
        if (name === "bash")
          component.addChild(
            render({ ...result, content: [] }, options, theme, {
              ...context,
              lastComponent: undefined,
            }),
          );
        painted.add(component);
        return component;
      },
    };
  });
}
