import {
  createBashToolDefinition,
  defineTool,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  type ToolRendererResolver,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { shellCommandText } from "./shell.ts";

type RendererHost = Pick<ExtensionAPI, "registerToolRenderer">;
const studioRenderers = new WeakMap<RendererHost, ToolRendererResolver[]>();

export function registerCodingRenderer(
  pi: RendererHost,
  renderer: ToolRendererResolver,
) {
  pi.registerToolRenderer(renderer);
  const existing = studioRenderers.get(pi) ?? [];
  existing.push(renderer);
  studioRenderers.set(pi, existing);
}

function builtin(name: string) {
  switch (name) {
    case "Read":
      return defineTool(createReadToolDefinition("."));
    case "Write":
      return defineTool(createWriteToolDefinition("."));
    case "Edit":
      return defineTool(createEditToolDefinition("."));
    case "Bash":
    case "shell_command":
      return defineTool(createBashToolDefinition("."));
    default:
      return undefined;
  }
}

const streamedArgs = z.looseObject({
  file_path: z.string().optional(),
  old_string: z.string().optional(),
  new_string: z.string().optional(),
  replace_all: z.boolean().optional(),
  command: z.string().optional(),
  workdir: z.string().optional(),
  timeout: z.number().optional(),
  timeout_ms: z.number().optional(),
});

function displayArgs(name: string, args: unknown, cwd: string) {
  const parsed = streamedArgs.safeParse(args);
  if (!parsed.success) return {};
  const input = parsed.data;
  switch (name) {
    case "Bash":
      return {
        command: input.command,
        timeout:
          input.timeout === undefined
            ? undefined
            : Math.min(input.timeout, 600000) / 1000,
      };
    case "shell_command":
      return {
        command:
          input.command === undefined
            ? undefined
            : shellCommandText(cwd, input.command, input.workdir),
        timeout:
          input.timeout_ms === undefined ? undefined : input.timeout_ms / 1000,
      };
    case "Edit":
      // A single-match preview is inaccurate for replace_all. The settled diff covers every replacement.
      return {
        path: input.file_path,
        ...(input.replace_all === true
          ? {}
          : { oldText: input.old_string, newText: input.new_string }),
      };
    default:
      return { ...input, path: input.file_path };
  }
}

// Pi renders the model call, not the nested canonical call. Reuse the same
// renderer chain and tool result, translating only what the operator sees.
export function modelToolRenderers(
  pi: RendererHost,
  name: string,
): ToolRenderers {
  const native = builtin(name);
  if (native === undefined) return {};
  const base: ToolRenderers = native;
  const chain = studioRenderers.get(pi) ?? [];
  const renderer = chain.reduceRight<ToolRenderers>(
    (next, resolve) => resolve(native.name, () => next) ?? next,
    base,
  );
  const call = renderer.renderCall;
  const result = renderer.renderResult;
  return {
    ...(renderer.renderShell === undefined
      ? {}
      : { renderShell: renderer.renderShell }),
    ...(call === undefined
      ? {}
      : {
          renderCall(args, theme, ctx) {
            const mapped = displayArgs(name, args, ctx.cwd);
            return call(mapped, theme, { ...ctx, args: mapped });
          },
        }),
    ...(result === undefined
      ? {}
      : {
          renderResult(outcome, options, theme, ctx) {
            const mapped = displayArgs(name, ctx.args, ctx.cwd);
            const [first] = outcome.content;
            const numbered =
              name === "Read" &&
              !ctx.isError &&
              outcome.isError !== true &&
              outcome.content.length === 1 &&
              first?.type === "text";
            const display = numbered
              ? {
                  ...outcome,
                  content: [
                    {
                      type: "text" as const,
                      text: first.text.replaceAll(/^\d+\t/gmu, ""),
                    },
                  ],
                }
              : outcome;
            return result(display, options, theme, { ...ctx, args: mapped });
          },
        }),
  };
}
