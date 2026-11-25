import { registerCodingRenderer } from "./model-tools/rendering.ts";
import {
  type ExtensionAPI,
  type Theme,
  getLanguageFromPath,
  highlightCode,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Text,
  sliceByColumn,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { z } from "zod";

const MAX_HIGHLIGHT_BYTES = 50_000;
const commandArgs = z.object({ command: z.string() });
const shellCallArgs = commandArgs.extend({ timeout: z.number().optional() });

type ShellWord = { raw: string; start: number };

function simpleCommand(input: string): ShellWord[] {
  const command = input.trim();
  const leading = input.length - input.trimStart().length;
  const words: ShellWord[] = [];
  let end = 0;
  for (const token of command.matchAll(
    /'[^'\r\n]*'|"[^"\r\n]*"|[^\s'"|&;<>`$\\()]+/gu,
  )) {
    const gap = command.slice(end, token.index);
    if (words.length > 0 && !/^[ \t]+$/u.test(gap)) return [];
    if (words.length === 0 && token.index !== 0) return [];
    const raw = token[0];
    words.push({ raw, start: leading + token.index });
    end = token.index + raw.length;
  }
  return end === command.length ? words : [];
}

type ShellStyle = ShellWord & { role: "syntaxFunction" | "syntaxKeyword" };

// Header decoration does not establish the identity of the command producing output.
// Keep the stricter simpleCommand parser for that separate decision.
function shellHeaderStyles(command: string): ShellStyle[] | undefined {
  const styles: ShellStyle[] = [];
  let position = 0;
  const reserved = new Set([
    "if",
    "then",
    "else",
    "elif",
    "fi",
    "for",
    "while",
    "until",
    "do",
    "done",
    "case",
    "esac",
    "in",
    "function",
    "select",
    "time",
    "coproc",
    "!",
    "{",
    "}",
    "[[",
    "]]",
  ]);
  function substitution(depth: number): boolean {
    if (command.startsWith("$((", position) || depth >= 32) return false;
    position += 2;
    return sequence(depth + 1);
  }
  function quote(delimiter: string, depth: number): boolean {
    position++;
    while (position < command.length) {
      if (command[position] === delimiter) {
        position++;
        return true;
      }
      if (delimiter === '"' && command.startsWith("$(", position)) {
        if (!substitution(depth)) return false;
      } else if (delimiter === '"' && command[position] === "\\") {
        position += 2;
      } else {
        if (delimiter === '"' && command[position] === "`") return false;
        position++;
      }
    }
    return false;
  }
  function sequence(depth: number): boolean {
    let executable = true;
    let flags = true;
    let redirect = false;
    while (position < command.length) {
      const rest = command.slice(position);
      if (rest.startsWith(")")) {
        if (depth === 0 || redirect) return false;
        position++;
        return true;
      }
      const whitespace = /^[ \t\r]+/u.exec(rest)?.[0];
      if (whitespace !== undefined) {
        position += whitespace.length;
        continue;
      }
      if (rest.startsWith("#")) {
        const newline = command.indexOf("\n", position);
        position = newline < 0 ? command.length : newline;
        continue;
      }
      const redirection = /^(?:\d+)?(?:&>>?|<>|>&|<&|>\||>>?|<)/u.exec(
        rest,
      )?.[0];
      if (redirection !== undefined) {
        // Heredoc bodies and process substitutions need a full shell grammar.
        if (
          /^(?:\d+)?<</u.test(rest) ||
          rest.startsWith("<(") ||
          rest.startsWith(">(")
        )
          return false;
        if (redirect) return false;
        position += redirection.length;
        redirect = true;
        continue;
      }
      const separator = /^(?:&&|\|\||\|&|[;|&\n])/u.exec(rest)?.[0];
      if (separator !== undefined) {
        if (redirect) return false;
        position += separator.length;
        executable = true;
        flags = true;
        continue;
      }
      const start = position;
      while (
        position < command.length &&
        !/[\s;&|<>()]/u.test(command[position] ?? "")
      ) {
        const character = command[position];
        if (character === "'" || character === '"') {
          if (!quote(character, depth)) return false;
        } else if (command.startsWith("$(", position)) {
          if (!substitution(depth)) return false;
        } else if (character === "\\") {
          position += 2;
        } else {
          if (character === "`" || command.startsWith("${", position))
            return false;
          position++;
        }
      }
      if (position === start || position > command.length) return false;
      const raw = command.slice(start, position);
      if (redirect) {
        redirect = false;
        continue;
      }
      if (executable) {
        if (/^[A-Za-z_]\w*=/u.test(raw)) continue;
        if (reserved.has(raw)) return false;
        executable = false;
        if (/^[\w./-]+$/u.test(raw))
          styles.push({ raw, start, role: "syntaxFunction" });
      } else if (flags) {
        if (raw === "--") flags = false;
        const flag = /^--?(?:[A-Za-z][\w-]*|\d+)(?==|$)/u.exec(raw)?.[0];
        if (flag !== undefined)
          styles.push({ raw: flag, start, role: "syntaxKeyword" });
      }
    }
    return depth === 0 && !redirect;
  }
  return sequence(0) ? styles.sort((a, b) => a.start - b.start) : undefined;
}

function highlightShellCommand(command: string, theme: Theme): string {
  const highlighted = highlightCode(command, "bash");
  const styles = shellHeaderStyles(command);
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
  const parsed = commandArgs.safeParse(args);
  const words =
    tool === "bash" && parsed.success
      ? simpleCommand(parsed.data.command).map(({ raw }) =>
          raw.startsWith("'") || raw.startsWith('"') ? raw.slice(1, -1) : raw,
        )
      : [];
  const [command, option, script, file] = words;

  // The native shell renderer owns the truncation footer and exit-status text.
  const footer =
    /\n\n\[(?:Showing[^\n]*Full output:|Command exited with code)[\s\S]*$/u.exec(
      output,
    );
  const text = footer === null ? output : output.slice(0, footer.index);

  if (
    command === "sed" &&
    option === "-n" &&
    words.length === 4 &&
    script !== undefined &&
    /^\d+(?:,(?:\d+|\$))?p$/u.test(script) &&
    file !== undefined
  ) {
    const language = getLanguageFromPath(file);
    if (language !== undefined)
      return highlight(text, language).join("\n") + (footer?.[0] ?? "");
  }

  if (tool !== "grep" && command !== "rg") return output;
  if (
    command === "rg" &&
    words.some((arg) =>
      /^--(?:json|count(?:-matches)?|files(?:-with(?:out)?-matches)?|replace)(?:=|$)/u.test(
        arg,
      ),
    )
  )
    return output;
  const last = words.at(-1);
  const singleFile =
    command === "rg" &&
    ((words.length === 3 && option?.startsWith("-") === false) ||
      (words.length === 4 &&
        (option === "-n" || option === "--line-number"))) &&
    last !== undefined &&
    !/^[~-]|[*?]/u.test(last)
      ? getLanguageFromPath(last)
      : undefined;
  return (
    text
      .split("\n")
      .map((line) => {
        const match = /^(.+?)([:-])(\d+)\2(.*)$/u.exec(line);
        const filePath = match?.[1];
        const code = match?.[4];
        const language =
          filePath === undefined ? undefined : getLanguageFromPath(filePath);
        if (language !== undefined && code !== undefined) {
          const prefix = line.slice(0, line.length - code.length);
          return prefix + highlight(code, language).join("\n");
        }
        if (singleFile !== undefined) {
          const numbered = /^(\d+[:-])(.*)$/u.exec(line);
          const source = numbered?.[2];
          if (source !== undefined)
            return (
              (numbered?.[1] ?? "") + highlight(source, singleFile).join("\n")
            );
          if (words.length === 3 && line !== "" && !line.startsWith("rg:"))
            return highlight(line, singleFile).join("\n");
        }
        return line;
      })
      .join("\n") + (footer?.[0] ?? "")
  );
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

        const component: Component = {
          invalidate() {},
          render(width) {
            const rows = wrapTextWithAnsi(
              highlighted.trimEnd(),
              Math.max(1, width),
            );
            const limit = name === "bash" ? 5 : 15;
            if (options.expanded || rows.length <= limit) return ["", ...rows];
            const hidden = rows.length - limit;
            const hint = theme.fg("muted", `… ${hidden.toString()} more lines`);
            return name === "bash"
              ? ["", hint, ...rows.slice(-limit)]
              : ["", ...rows.slice(0, limit), hint];
          },
        };
        painted.add(component);
        return component;
      },
    };
  });
}
