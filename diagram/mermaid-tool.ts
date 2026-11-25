import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink, Text } from "@earendil-works/pi-tui";
import { selectorText } from "@lanej/pi-components";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { stateDirectory } from "../attempts.ts";
import {
  mermaidSourceLimit,
  renderMermaidArtifact,
  type MermaidArtifact,
} from "./mermaid-artifact.ts";

export const mermaidTool = "render_mermaid";
export const claudeMermaidTool = "RenderMermaid";

const parameters = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 120 }),
    source: Type.String({
      minLength: 1,
      maxLength: mermaidSourceLimit,
      description: "Complete Mermaid source without a Markdown code fence.",
    }),
  },
  { additionalProperties: false },
);

function files(artifact: MermaidArtifact) {
  const source = { label: "Mermaid source", path: artifact.sourcePath };
  return artifact.status === "rendered"
    ? [
        source,
        { label: "SVG", path: artifact.svgPath },
        { label: "PNG", path: artifact.pngPath },
      ]
    : [source];
}

async function inlinePreview(path: string) {
  const png = await readFile(path);
  // Keep the original for ordinary diagrams and bound larger images in conversation history.
  if (
    png.length <= 1024 * 1024 &&
    png.readUInt32BE(16) <= 2000 &&
    png.readUInt32BE(20) <= 2000
  )
    return {
      type: "image" as const,
      mimeType: "image/png",
      data: png.toString("base64"),
    };
  const { PhotonImage, resize, SamplingFilter } = await import(
    "@silvia-odwyer/photon-node"
  );
  const original = PhotonImage.new_from_byteslice(png);
  let preview: InstanceType<typeof PhotonImage> | undefined;
  try {
    const scale = Math.min(
      1,
      1400 / Math.max(original.get_width(), original.get_height()),
    );
    preview = resize(
      original,
      Math.max(1, Math.round(original.get_width() * scale)),
      Math.max(1, Math.round(original.get_height() * scale)),
      SamplingFilter.Lanczos3,
    );
    const bytes = preview.get_bytes();
    if (bytes.length > 3 * 1024 * 1024) return undefined;
    return {
      type: "image" as const,
      mimeType: "image/png",
      data: Buffer.from(bytes).toString("base64"),
    };
  } finally {
    preview?.free();
    original.free();
  }
}

export function mermaidDefinition(name = mermaidTool) {
  return defineTool<typeof parameters, MermaidArtifact | undefined>({
    name,
    label: "Render Mermaid",
    description:
      "Render Mermaid source as a reusable diagram. Saves the editable .mmd, a scalable SVG and a PNG preview in Studio's artifact directory. Use when event order, acknowledgments, or failure paths would clarify a design decision, or when the user wants an artifact to edit or share. If rendering fails, returns the source file and diagnostic.",
    promptSnippet: "Render a reusable Mermaid artifact and display its image.",
    promptGuidelines: [
      "Use the interactive C4 diagram for ownership and boundaries. Render a sequence when timing matters to the decision. Keep ordinary drafting lightweight.",
      "Use self-contained Mermaid source unless the user supplies an external asset for the diagram.",
    ],
    exposure: "model-only",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    parameters,
    async execute(_call, args, signal) {
      const artifact = await renderMermaidArtifact(
        join(stateDirectory(), "artifacts", "mermaid"),
        args.source,
        signal === undefined ? {} : { signal },
      );
      const image =
        artifact.status === "rendered"
          ? await inlinePreview(artifact.pngPath).catch(() => undefined)
          : undefined;
      signal?.throwIfAborted();
      const message = [
        artifact.status === "rendered"
          ? "Rendered Mermaid diagram."
          : artifact.reason,
        ...(artifact.status === "rendered" && image === undefined
          ? ["Open the PNG file to view this diagram."]
          : []),
        ...files(artifact).map((file) => `${file.label}: ${file.path}`),
      ].join("\n");
      return {
        content: [
          { type: "text", text: message },
          ...(image === undefined ? [] : [image]),
        ],
        details: artifact,
      };
    },
    renderCall(args, theme, context) {
      const title =
        context.argsComplete || !context.isPartial
          ? selectorText(args.title).replace(/\s+/gu, " ").trim()
          : "";
      return new Text(
        theme.fg(
          "toolTitle",
          theme.bold(title.length > 0 ? title : "Mermaid diagram"),
        ),
        0,
        0,
      );
    },
    renderResult(result, options, theme, ctx) {
      const receipt = result.details;
      if (receipt === undefined || ctx.isError) {
        const text = result.content.flatMap((part) =>
          part.type === "text" ? [selectorText(part.text)] : [],
        );
        return new Text(theme.fg("error", text.join("\n")), 0, 0);
      }
      const links = getCapabilities().hyperlinks && !options.expanded;
      const paths = files(receipt).map(({ label, path }) =>
        links
          ? hyperlink(label, pathToFileURL(path).href)
          : `${label}: ${selectorText(path)}`,
      );
      const text = paths.join(links ? "  ·  " : "\n");
      return new Text(
        [
          ...(receipt.status === "source-only"
            ? [theme.fg("warning", selectorText(receipt.reason))]
            : result.content.some((part) => part.type === "image")
              ? []
              : ["Open the PNG file to view this diagram."]),
          theme.fg("muted", text),
        ].join("\n"),
        0,
        0,
      );
    },
  });
}

export function registerMermaidTool(pi: ExtensionAPI): void {
  pi.registerTool(mermaidDefinition());
}
