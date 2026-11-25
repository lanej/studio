import type {
  ExtensionAPI,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { selectorText } from "@lanej/pi-components";
import {
  isEntry,
  isMessageRole,
  PiEntryType,
  PiMessageRole,
} from "../runtime.ts";
import { inspectDiagram } from "./inspector.ts";
import { diagramParameters, parseDiagram } from "./model.ts";
import { renderDiagram } from "./render.ts";

export const diagramTool = "show_diagram";

type DiagramReceipt =
  | { status: "displayed" | "unavailable" | "dismissed" }
  | { status: "selected"; nodeId: string };

function latestDiagram(entries: SessionEntry[]) {
  const finished = new Set<string>();
  for (const entry of [...entries].reverse()) {
    if (!isEntry(entry, PiEntryType.Message)) continue;
    const message = entry.message;
    if (
      isMessageRole(message, PiMessageRole.ToolResult) &&
      message.toolName === diagramTool &&
      !message.isError
    )
      finished.add(message.toolCallId);
    if (!isMessageRole(message, PiMessageRole.Assistant)) continue;
    for (const part of [...message.content].reverse()) {
      if (
        part.type !== "toolCall" ||
        part.name !== diagramTool ||
        !finished.has(part.id)
      )
        continue;
      try {
        return parseDiagram(part.arguments);
      } catch {
        // Older or malformed calls can coexist with an inspectable diagram on this branch.
      }
    }
  }
  return undefined;
}

export function registerDiagrams(pi: ExtensionAPI): void {
  pi.registerTool<typeof diagramParameters, DiagramReceipt | undefined>({
    name: diagramTool,
    label: "Show diagram",
    description:
      "Show a directed graph in the conversation. Use short labels, optional node details, and labeled edges for branches or loops. Include a question only when you need the user to choose a node. A selection is a conversational answer.",
    promptSnippet:
      "Show an inspectable diagram or ask the user to choose a node.",
    exposure: "model-only",
    annotations: { readOnlyHint: true },
    executionMode: "sequential",
    parameters: diagramParameters,
    async execute(_call, args, signal, _update, ctx) {
      const diagram = parseDiagram(args);
      if (ctx.mode !== "tui" || !ctx.hasUI)
        return {
          content: [
            {
              type: "text",
              text: "The diagram viewer is unavailable in this session. Explain the diagram in your reply and ask any question in text.",
            },
          ],
          details: { status: "unavailable" },
        };
      if (diagram.question === undefined)
        return {
          content: [{ type: "text", text: "Diagram shown." }],
          details: { status: "displayed" },
        };

      const nodeId = await inspectDiagram(ctx, diagram, signal);
      const selected = diagram.nodes.find((node) => node.id === nodeId);
      if (selected === undefined || signal?.aborted === true)
        return {
          content: [
            {
              type: "text",
              text: "The question was dismissed without a selection.",
            },
          ],
          details: { status: "dismissed" },
        };
      return {
        content: [
          {
            type: "text",
            text: `User selected ${selected.label} (node ID: ${selected.id}).`,
          },
        ],
        details: { status: "selected", nodeId: selected.id },
      };
    },
    renderCall(args, theme, context) {
      if (!context.isPartial || context.argsComplete) {
        try {
          const diagram = parseDiagram(args);
          const graph = renderDiagram(diagram, theme, context.expanded);
          if (diagram.question === undefined || context.isPartial) return graph;
          const card = new Container();
          card.addChild(graph);
          card.addChild(new Text(theme.bold(diagram.question), 0, 0));
          return card;
        } catch {
          // The execution result carries the validation error.
        }
      }
      return new Text(theme.fg("toolTitle", theme.bold("Diagram")), 0, 0);
    },
    renderResult(result, _options, theme, context) {
      if (!context.isError && result.details?.status === "displayed")
        return new Text("", 0, 0);
      const text = result.content
        .flatMap((item) =>
          item.type === "text" ? [selectorText(item.text)] : [],
        )
        .join("\n");
      return new Text(
        theme.fg(context.isError ? "error" : "muted", text),
        0,
        0,
      );
    },
  });

  pi.registerCommand("diagram", {
    description: "Inspect the latest diagram in this conversation",
    async handler(_args, ctx) {
      if (ctx.mode !== "tui") return;
      const diagram = latestDiagram(ctx.sessionManager.getBranch());
      if (diagram === undefined) {
        ctx.ui.notify("No diagram on this conversation branch.", "info");
        return;
      }
      // Reopening a question is inspection; only its original tool call can take an answer.
      delete diagram.question;
      await inspectDiagram(ctx, diagram);
    },
  });
}
