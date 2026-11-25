import { registerCodingRenderer } from "./model-tools/rendering.ts";
import { basename } from "node:path";
import { z } from "zod";
import {
  type ExtensionAPI,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { type Component, Markdown } from "@earendil-works/pi-tui";

const readArgs = z.looseObject({
  path: z.string().optional(),
  file_path: z.string().optional(),
  offset: z.number().optional(),
  limit: z.number().optional(),
});
const noDetails = z.strictObject({});

/** Pi labels reads of SKILL.md as skills; only their complete expanded text changes presentation. */
export function registerSkillRendering(
  pi: Pick<ExtensionAPI, "registerToolRenderer">,
): void {
  const painted = new WeakSet<Component>();
  registerCodingRenderer(pi, (name, next) => {
    const base = next();
    if (name !== "read") return base;
    const render = base?.renderResult;
    if (render === undefined) return base;
    return {
      ...base,
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
        const args = readArgs.safeParse(context.args);
        const path = args.success
          ? (args.data.file_path ?? args.data.path)
          : undefined;
        const block = result.content[0];
        if (
          !options.expanded ||
          options.isPartial ||
          context.isError ||
          result.isError === true ||
          !args.success ||
          path === undefined ||
          basename(path) !== "SKILL.md" ||
          args.data.offset !== undefined ||
          args.data.limit !== undefined ||
          (result.details !== undefined &&
            !noDetails.safeParse(result.details).success) ||
          result.content.length !== 1 ||
          block?.type !== "text" ||
          block.text.trim() === "" ||
          /[^\P{Cc}\n\r\t]/u.test(block.text)
        )
          return fallback();
        const component = new Markdown(block.text, 0, 0, getMarkdownTheme());
        painted.add(component);
        return component;
      },
    };
  });
}
