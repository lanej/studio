import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
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

type ModelTool = Binding & { dialect: Dialect };
const modelTools: ModelTool[] = dialects.flatMap((dialect) =>
  dialect.tools.map((binding) => ({ ...binding, dialect: dialect.name })),
);

function available(
  entry: ModelTool,
  dialect: Dialect | undefined,
  active: ReadonlySet<string>,
  tools: readonly ToolInfo[],
): boolean {
  return (
    entry.dialect === dialect &&
    operationAvailable(entry.operation, active, tools)
  );
}

export function registerModelTools(pi: ExtensionAPI): void {
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
      if (existing.has(tool.name)) continue;
      pi.registerTool({
        ...tool,
        ...modelToolRenderers(pi, entry),
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
              ? [...replacedTools[entry.operation]]
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
      if (registered?.parameters === tool.parameters)
        owned.set(tool.name, registered.sourceInfo);
    }
    select(ctx.model);
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
