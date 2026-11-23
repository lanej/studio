import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { Type } from "typebox";
import { z } from "zod";
import { loadConfig } from "../config.ts";
import { ExecutionStore } from "./store.ts";

export async function mergePolicy(project: string) {
  const config = await loadConfig();
  const configured = config.runtime.projects.find(
    (item) => item.source.projectId === project,
  );
  const store = new ExecutionStore();
  try {
    const override = store.override(project);
    return {
      project,
      enabled:
        configured !== undefined && (override?.enabled ?? configured.merge),
      origin: override === undefined ? "configuration" : "lead override",
      override: override ?? null,
    };
  } finally {
    store.close();
  }
}
export function registerProjectPolicy(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "studio_project_merge_policy",
    label: "Project merge policy",
    description:
      "Inspect or override this project's automatic-merge default. Only the lead can change this project-scoped policy; mandatory independent review and current-head checks remain required. Supply a reason for a change.",
    parameters: Type.Object({
      merge: Type.Optional(
        Type.Union([
          Type.Literal("on"),
          Type.Literal("off"),
          Type.Literal("default"),
        ]),
      ),
      reason: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const parsed = z
        .object({
          merge: z.enum(["on", "off", "default"]).optional(),
          reason: z.string().trim().min(1).optional(),
        })
        .parse(params);
      const config = await loadConfig();
      const project = config.runtime.projects.find(
        (item) => realpathSync(item.root) === realpathSync(ctx.cwd),
      );
      if (project === undefined)
        throw new Error(
          "Configure this runtime project before changing merge policy",
        );
      if (parsed.merge !== undefined) {
        if (parsed.reason === undefined)
          throw new Error(
            "Explain why this project's merge default is being overridden or restored",
          );
        const store = new ExecutionStore();
        try {
          store.setOverride(
            project.source.projectId,
            parsed.merge === "default"
              ? undefined
              : {
                  enabled: parsed.merge === "on",
                  actor: ctx.sessionManager.getSessionId(),
                  reason: parsed.reason,
                  at: new Date().toISOString(),
                },
            { actor: ctx.sessionManager.getSessionId(), reason: parsed.reason },
          );
        } finally {
          store.close();
        }
      }
      const policy = await mergePolicy(project.source.projectId);
      return {
        content: [{ type: "text", text: JSON.stringify(policy) }],
        details: policy,
      };
    },
  });
}
