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
import type { CodingOperation } from "./policy.ts";

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

const nativeRenderers = {
  read: () => defineTool(createReadToolDefinition(".")),
  write: () => defineTool(createWriteToolDefinition(".")),
  replace: () => defineTool(createEditToolDefinition(".")),
  shell: () => defineTool(createBashToolDefinition(".")),
};

export interface ToolDisplay {
  // The TUI can ask for a preview before all arguments arrive.
  arguments: (raw: unknown, cwd: string) => unknown;
  resultText?: (modelText: string) => string;
}

// Pi renders the model call, not the nested canonical call. Reuse the same
// renderer chain and tool result, translating only what the operator sees.
export function modelToolRenderers(
  pi: RendererHost,
  { operation, display }: { operation: CodingOperation; display?: ToolDisplay },
): ToolRenderers {
  if (operation === "patch") return {};
  const native = nativeRenderers[operation]();
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
            const mapped = display?.arguments(args, ctx.cwd) ?? args;
            return call(mapped, theme, { ...ctx, args: mapped });
          },
        }),
    ...(result === undefined
      ? {}
      : {
          renderResult(outcome, options, theme, ctx) {
            const mapped = display?.arguments(ctx.args, ctx.cwd) ?? ctx.args;
            const [first] = outcome.content;
            const formatText = display?.resultText;
            const displayResult =
              formatText !== undefined &&
              !ctx.isError &&
              outcome.isError !== true &&
              outcome.content.length === 1 &&
              first?.type === "text"
                ? {
                    ...outcome,
                    content: [
                      {
                        type: "text" as const,
                        text: formatText(first.text),
                      },
                    ],
                  }
                : outcome;
            return result(displayResult, options, theme, {
              ...ctx,
              args: mapped,
            });
          },
        }),
  };
}
