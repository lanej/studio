import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { z } from "zod";
import { readFile, replaceText, runShell, writeFile } from "../operations.ts";
import { piShellArguments, type ShellRequest } from "../shell.ts";

export function claudeShellRequest(
  command: string,
  timeout?: number,
): ShellRequest {
  return { command, timeoutMs: Math.min(timeout ?? 120_000, 600_000) };
}

const filePath = Type.String({
  minLength: 1,
  description: "Path to the file, preferably absolute.",
});

const truncation = z.object({
  truncation: z.object({ outputLines: z.number() }),
});

const read = defineTool({
  name: "Read",
  label: "Read",
  description:
    "Read numbered lines of a text file or view an image. Use offset and limit to select lines. Omit the line-number prefix when editing.",
  parameters: Type.Object(
    {
      file_path: filePath,
      offset: Type.Optional(
        Type.Integer({ minimum: 0, description: "First line, starting at 1." }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, description: "Maximum number of lines." }),
      ),
    },
    { additionalProperties: false },
  ),
  async execute(_id, { file_path, offset, limit }, _signal, _update, ctx) {
    const result = await readFile(ctx, { path: file_path, offset, limit });
    const [first] = result.content;
    if (result.isError || result.content.length !== 1 || first?.type !== "text")
      return result;
    if (first.text === "")
      return {
        ...result,
        content: [
          {
            type: "text",
            text: "The file exists, but this range contains no text.",
          },
        ],
      };

    // The native read may append a pagination notice. Only number source lines.
    const range = truncation.safeParse(result.details);
    const count = range.success ? range.data.truncation.outputLines : limit;
    const start = Math.max(1, offset ?? 1);
    const lines = first.text.split("\n");
    const text = lines
      .map((line, i) =>
        (count !== undefined && i >= count) ||
        (i === lines.length - 1 && line === "")
          ? line
          : `${String(start + i)}\t${line}`,
      )
      .join("\n");
    return {
      ...result,
      content: [{ type: "text", text }],
      structuredContent: text,
    };
  },
});

const write = defineTool({
  name: "Write",
  label: "Write",
  description: "Create or overwrite a text file with the provided content.",
  parameters: Type.Object(
    { file_path: filePath, content: Type.String() },
    { additionalProperties: false },
  ),
  execute(_id, { file_path, content }, _signal, onUpdate, ctx) {
    return writeFile(ctx, file_path, content, onUpdate);
  },
});

const edit = defineTool({
  name: "Edit",
  label: "Edit",
  description:
    "Replace exact text in a file. old_string must match once unless replace_all is true. Use additional surrounding text to distinguish repeated matches.",
  parameters: Type.Object(
    {
      file_path: filePath,
      old_string: Type.String({ minLength: 1 }),
      new_string: Type.String(),
      replace_all: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  execute(_id, args, _signal, onUpdate, ctx) {
    return replaceText(
      ctx,
      {
        path: args.file_path,
        oldText: args.old_string,
        newText: args.new_string,
        replaceAll: args.replace_all === true,
        reason: "No rationale supplied with this Edit.",
      },
      onUpdate,
    );
  },
});

const bash = defineTool({
  name: "Bash",
  label: "Bash",
  description:
    "Run a foreground shell command in the session working directory. Set timeout in milliseconds. Each call starts a fresh shell.",
  parameters: Type.Object(
    {
      command: Type.String({ minLength: 1 }),
      description: Type.Optional(
        Type.String({ description: "Short description of the command." }),
      ),
      timeout: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "Foreground timeout in milliseconds (maximum 600000).",
        }),
      ),
      run_in_background: Type.Optional(Type.Literal(false)),
    },
    { additionalProperties: false },
  ),
  execute(_id, { command, timeout }, _signal, onUpdate, ctx) {
    return runShell(ctx, claudeShellRequest(command, timeout), onUpdate);
  },
});

// Pi can render an in-progress tool call before the model supplies all required fields.
const streamedFile = z
  .looseObject({
    file_path: z.string(),
    old_string: z.string(),
    new_string: z.string(),
    replace_all: z.boolean(),
  })
  .partial()
  .catch({});
const streamedShell = z
  .object({ command: z.string(), timeout: z.number() })
  .partial()
  .catch({});

function fileArguments(raw: unknown) {
  const input = streamedFile.parse(raw);
  return { ...input, path: input.file_path };
}

export const claudeTools = [
  {
    operation: "read",
    tool: read,
    display: {
      arguments: fileArguments,
      resultText: (text: string) => text.replaceAll(/^\d+\t/gmu, ""),
    },
  },
  { operation: "write", tool: write, display: { arguments: fileArguments } },
  {
    operation: "replace",
    tool: edit,
    display: {
      arguments(raw: unknown) {
        const input = streamedFile.parse(raw);
        // A single-match preview is inaccurate for replace_all. The settled diff covers every replacement.
        return {
          path: input.file_path,
          ...(input.replace_all === true
            ? {}
            : { oldText: input.old_string, newText: input.new_string }),
        };
      },
    },
  },
  {
    operation: "shell",
    tool: bash,
    display: {
      arguments(raw: unknown, cwd: string) {
        const { command, timeout } = streamedShell.parse(raw);
        const shell = piShellArguments(
          cwd,
          claudeShellRequest(command ?? "", timeout),
        );
        return {
          command,
          timeout: timeout === undefined ? undefined : shell.timeout,
        };
      },
    },
  },
] as const;

export const claudeDialect = {
  matches: /^(?:(?:[a-z]{2}|global)\.)?(?:anthropic[./])?claude-/iu,
  tools: claudeTools,
};
