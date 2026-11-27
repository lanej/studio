import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  AgentRole,
  DefaultProvider,
  knownProvider,
  requireProfile,
  StudioProfile,
  type ModelSelection,
  type StudioConfig,
} from "../config.ts";
import type { PlanWorkers } from "../planning/plan.ts";

export function runtimeModelAllowed(
  profile: StudioProfile | undefined,
  model: { provider: string; baseUrl: string },
): boolean {
  const provider = knownProvider(model.provider);
  if (profile === StudioProfile.Personal) return provider === DefaultProvider.ChatGPTSubscription;
  if (profile === StudioProfile.Work || provider === DefaultProvider.BedrockMantle)
    return /^https:\/\/bedrock-mantle\.[a-z0-9-]+\.api\.aws(?:\/|$)/u.test(model.baseUrl);
  return true;
}

export function profileDigest(config: StudioConfig): string | undefined {
  return !config.profile ? undefined : createHash("sha256").update(JSON.stringify(config.profile)).digest("hex");
}

export async function assertRuntimeProfile(
  config: StudioConfig,
  workers: PlanWorkers = {},
  legacyProfile?: StudioProfile,
): Promise<void> {
  const root = getAgentDir();
  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: join(root, "models.json"),
  });
  const roles = requireProfile(config);
  const validate = (label: string, selection: ModelSelection | undefined) => {
    const model = !selection ? undefined : runtime.getModel(selection.provider, selection.model);
    if (!model || !runtime.hasConfiguredAuth(model.provider) || !runtimeModelAllowed(legacyProfile, model))
      throw new Error(`Configure and authenticate the global profile's ${label} model before enabling execution`);
    return model;
  };
  for (const role of [AgentRole.Lead, AgentRole.Worker, AgentRole.Reviewer]) {
    validate(role, roles[role]);
  }
  for (const [task, worker] of Object.entries(workers)) {
    const model = validate(`worker for task ${task}`, worker);
    if (!getSupportedThinkingLevels(model).includes(worker.reasoning))
      throw new Error(
        `Task ${task}: ${worker.provider}/${worker.model} does not support ${worker.reasoning} reasoning`,
      );
  }
}
