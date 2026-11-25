import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
  claudeDiagramTool,
  diagramDefinition,
  diagramTool,
} from "../diagram/extension.ts";
import {
  claudeMermaidTool,
  mermaidDefinition,
  mermaidTool,
} from "../diagram/mermaid-tool.ts";
import { claudeDialect } from "./dialects/claude.ts";
import { codexDialect } from "./dialects/codex.ts";
import {
  type CodingOperation,
  operationAvailable,
  replacedTools,
} from "./policy.ts";
import { modelToolRenderers, type ToolDisplay } from "./rendering.ts";

type Dialect = "claude" | "codex";
interface Binding {
  operation: CodingOperation;
  tool: ToolDefinition;
  display?: ToolDisplay;
}

const dialects: {
  name: Dialect;
  matches: RegExp;
  tools: readonly Binding[];
}[] = [
  { name: "claude", ...claudeDialect },
  { name: "codex", ...codexDialect },
];

// Catalog IDs identify the model even when the provider is a Bedrock or OpenRouter route.
export function toolDialect(modelId: string | undefined): Dialect | undefined {
  return modelId === undefined
    ? undefined
    : dialects.find((dialect) => dialect.matches.test(modelId))?.name;
}

interface DiagramAlias {
  dialect: "claude";
  operation: "diagram";
  canonical: string;
  tool: ToolDefinition;
}

const diagramAliases: readonly DiagramAlias[] = [
  {
    dialect: "claude",
    operation: "diagram",
    canonical: diagramTool,
    tool: diagramDefinition(claudeDiagramTool),
  },
  {
    dialect: "claude",
    operation: "diagram",
    canonical: mermaidTool,
    tool: mermaidDefinition(claudeMermaidTool),
  },
];
type ModelTool = (Binding & { dialect: Dialect }) | DiagramAlias;
const codingTools: ModelTool[] = dialects.flatMap((dialect) =>
  dialect.tools.map((binding) => ({ ...binding, dialect: dialect.name })),
);

function diagramSource(entry: DiagramAlias, tools: readonly ToolInfo[]) {
  return tools.find(
    (info) =>
      info.name === entry.canonical &&
      info.exposure === "model-only" &&
      info.parameters === entry.tool.parameters,
  );
}

function ownsDiagramAlias(
  entry: DiagramAlias,
  tools: readonly ToolInfo[],
): boolean {
  const base = diagramSource(entry, tools);
  const alias = tools.find((info) => info.name === entry.tool.name);
  return (
    base !== undefined &&
    alias?.parameters === base.parameters &&
    alias.sourceInfo === base.sourceInfo
  );
}

// A managed lead admits a dialect spelling only for the same Studio-owned capability.
export function admittedDiagramAlias(
  pi: ExtensionAPI,
  name: string,
  modelId: string | undefined,
): string | undefined {
  const entry = diagramAliases.find((alias) => alias.tool.name === name);
  return entry !== undefined &&
    entry.dialect === toolDialect(modelId) &&
    ownsDiagramAlias(entry, pi.getAllTools())
    ? entry.canonical
    : undefined;
}

function available(
  entry: ModelTool,
  dialect: Dialect | undefined,
  active: ReadonlySet<string>,
  tools: readonly ToolInfo[],
): boolean {
  return (
    entry.dialect === dialect &&
    (entry.operation === "diagram"
      ? active.has(entry.canonical) && ownsDiagramAlias(entry, tools)
      : operationAvailable(entry.operation, active, tools))
  );
}

export function registerModelTools(
  pi: ExtensionAPI,
  { coding = true } = {},
): void {
  const modelTools = coding
    ? [...codingTools, ...diagramAliases]
    : diagramAliases;
  let dialect: Dialect | undefined;
  const owned = new Map<string, ToolInfo["sourceInfo"]>();
  const select = (model: ExtensionContext["model"]) => {
    dialect = toolDialect(model?.id);
    const tools = pi.getAllTools();
    const active = new Set(pi.getActiveTools());
    const next = new Set(active);
    for (const entry of modelTools) {
      // Respect an existing extension that owns this spelling.
      const info = tools.find((item) => item.name === entry.tool.name);
      if (
        info === undefined ||
        info.sourceInfo !== owned.get(entry.tool.name) ||
        info.parameters !== entry.tool.parameters
      )
        continue;
      if (available(entry, dialect, active, tools)) next.add(entry.tool.name);
      else next.delete(entry.tool.name);
    }
    if (
      next.size !== active.size ||
      [...next].some((name) => !active.has(name))
    )
      pi.setActiveTools([...next]);
  };

  pi.on("session_start", (_event, ctx) => {
    const existing = new Set(pi.getAllTools().map((tool) => tool.name));
    for (const entry of modelTools) {
      const { tool } = entry;
      if (
        existing.has(tool.name) ||
        (entry.operation === "diagram" &&
          diagramSource(entry, pi.getAllTools()) === undefined)
      )
        continue;
      pi.registerTool({
        ...tool,
        ...(entry.operation === "diagram" ? {} : modelToolRenderers(pi, entry)),
        exposure: "model-only",
        defaultActive: false,
        prepareLoadout(loadout) {
          const active = new Set(loadout.declared.map((item) => item.name));
          return {
            hiddenDeclarations: available(
              entry,
              dialect,
              active,
              pi.getAllTools(),
            )
              ? entry.operation === "diagram"
                ? [entry.canonical]
                : [...replacedTools[entry.operation]]
              : [tool.name],
          };
        },
        async execute(id, args, signal, update, context) {
          if (
            !available(
              entry,
              toolDialect(context.model?.id),
              new Set(pi.getActiveTools()),
              pi.getAllTools(),
            )
          )
            throw new Error(
              `${tool.name} is unavailable for the current model and active tools.`,
            );
          return tool.execute(id, args, signal, update, context);
        },
      });
      const registered = pi
        .getAllTools()
        .find((info) => info.name === tool.name);
      if (registered !== undefined && registered.parameters === tool.parameters)
        owned.set(tool.name, registered.sourceInfo);
    }
    select(ctx.model);
  });
  // A hidden declaration stays active in Pi. Reject a stale canonical call while its alias is selected.
  pi.on("tool_call", (event, ctx) => {
    const entry = diagramAliases.find(
      (alias) => alias.canonical === event.toolName,
    );
    if (entry === undefined || !pi.getActiveTools().includes(entry.tool.name))
      return;
    if (
      admittedDiagramAlias(pi, entry.tool.name, ctx.model?.id) ===
      entry.canonical
    )
      return {
        block: true,
        reason: `Use ${entry.tool.name} for the current model.`,
      };
    return;
  });
  pi.on("model_select", (event) => {
    select(event.model);
  });
  pi.on("session_tree", (_event, ctx) => {
    select(ctx.model);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    select(ctx.model);
  });
}
