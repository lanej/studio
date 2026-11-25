import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { isStudioEdit } from "../code-intelligence/edit-tool.ts";
import { claudeTools } from "./claude.ts";
import { codexPatchTool } from "./codex.ts";
import { modelToolRenderers } from "./rendering.ts";
import { shellCommand } from "./shell.ts";

type Dialect = "claude" | "codex";

// Catalog IDs keep the model vendor even on Bedrock regional and OpenRouter routes.
// An OpenAI-compatible endpoint alone says nothing about the model behind it.
export function toolDialect(modelId: string | undefined): Dialect | undefined {
  if (modelId === undefined) return undefined;
  if (/^(?:(?:[a-z]{2}|global)\.)?(?:anthropic[./])?claude-/iu.test(modelId))
    return "claude";
  if (
    /^(?:(?:[a-z]{2}|global)\.)?(?:openai[./])?(?:gpt-\d|codex(?:-|$)|o[134](?:-|$))/iu.test(
      modelId,
    )
  )
    return "codex";
  return undefined;
}

interface ModelTool {
  tool: ToolDefinition;
  dialect: Dialect;
  requires: string[];
  hides: string[];
}

const modelTools: ModelTool[] = [
  ...claudeTools.map((tool) => ({
    tool,
    dialect: "claude" as const,
    requires: [tool.name.toLowerCase()],
    hides: [tool.name.toLowerCase()],
  })),
  { tool: shellCommand, dialect: "codex", requires: ["bash"], hides: ["bash"] },
  // The patch format includes file moves and deletes. Offer it only in a local
  // coding session that already admits shell, reads, and both mutation tools.
  {
    tool: codexPatchTool(),
    dialect: "codex",
    requires: ["read", "edit", "write", "bash"],
    hides: ["edit", "write"],
  },
];

function admitted(
  entry: ModelTool,
  dialect: Dialect | undefined,
  selected: ReadonlySet<string>,
  tools: readonly ToolInfo[],
): boolean {
  return (
    dialect === entry.dialect &&
    entry.requires.every((name) => {
      if (!selected.has(name)) return false;
      const tool = tools.find((info) => info.name === name);
      if (tool === undefined || tool.exposure !== "direct") return false;
      if (name === "edit" && isStudioEdit(tool)) return true;
      if (entry.tool.name === "Edit") return false;
      // SDK base-tool overrides also report builtin:<name>, but omit Pi's native prompt guidelines.
      return (
        tool.sourceInfo.path === `builtin:${name}` &&
        tool.promptGuidelines !== undefined
      );
    })
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
      if (admitted(entry, dialect, active, tools)) next.add(entry.tool.name);
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
        ...modelToolRenderers(pi, tool.name),
        exposure: "model-only",
        defaultActive: false,
        prepareLoadout(loadout) {
          const active = new Set(loadout.declared.map((item) => item.name));
          return {
            hiddenDeclarations: admitted(
              entry,
              dialect,
              active,
              pi.getAllTools(),
            )
              ? entry.hides
              : [tool.name],
          };
        },
        async execute(id, args, signal, update, context) {
          if (
            !admitted(
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
