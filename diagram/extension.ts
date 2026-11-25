import {
  defineTool,
  keyText,
  type ExtensionAPI,
  type SessionEntry,
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
export const claudeDiagramTool = "ShowDiagram";

type DiagramReceipt =
  | { status: "displayed" | "unavailable" | "dismissed" }
  | { status: "selected"; nodeId: string };

function latestDiagram(entries: SessionEntry[]) {
  const finished = new Map<string, string>();
  for (const entry of [...entries].reverse()) {
    if (!isEntry(entry, PiEntryType.Message)) continue;
    const message = entry.message;
    if (
      isMessageRole(message, PiMessageRole.ToolResult) &&
      (message.toolName === diagramTool ||
        message.toolName === claudeDiagramTool) &&
      !message.isError
    )
      finished.set(message.toolCallId, message.toolName);
    if (!isMessageRole(message, PiMessageRole.Assistant)) continue;
    for (const part of [...message.content].reverse()) {
      if (part.type !== "toolCall" || finished.get(part.id) !== part.name)
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

export function diagramDefinition(name = diagramTool) {
  return defineTool<typeof diagramParameters, DiagramReceipt | undefined>({
    name,
    label: "Show architecture",
    description:
      "Explain system design or interoperability with an inspectable C4 architecture diagram. Model one focal software system, its users and external systems. Add applications and data stores as containers to enable zoom. Label directed relationships with responsibilities or exchanged information and supply known protocols on concrete connections. Use context for the landscape and container for internal design. Only include a question to ask for a selection.",
    promptSnippet:
      "Show a C4 system context or container diagram and explore architecture boundaries or interfaces.",
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
              text:
                diagram.question === undefined
                  ? "The diagram viewer is unavailable in this session. Describe the relevant system relationship in your reply."
                  : "The diagram viewer is unavailable in this session. Explain the diagram in your reply and ask the selection question in text.",
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
          // Previously recorded tool calls may predate the architecture schema.
          if (!context.isPartial && !context.isError) {
            const shortcut = keyText("app.tools.expand");
            const content = context.expanded
              ? selectorText(JSON.stringify(args, null, 2))
              : [
                  "Recorded diagram",
                  shortcut.length === 0 ? "" : `${shortcut} to inspect input`,
                ]
                  .filter(Boolean)
                  .join(" · ");
            return new Text(theme.fg("muted", content), 0, 0);
          }
        }
      }
      return new Text(theme.fg("toolTitle", theme.bold("Architecture")), 0, 0);
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
}

export function registerDiagrams(pi: ExtensionAPI): void {
  pi.registerTool(diagramDefinition());
  pi.registerCommand("diagram", {
    description: "Explore the latest C4 architecture in this conversation",
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
