import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { join } from "node:path";
import {
  AgentRole,
  DefaultProvider,
  knownProvider,
  StudioProfile,
  type ModelSelection,
  type StudioConfig,
} from "../config.ts";
import type { PlanWorkers } from "../planning/plan.ts";

export function runtimeModelAllowed(profile: StudioProfile, model: { provider: string; baseUrl: string }): boolean {
  return profile === StudioProfile.Personal
    ? knownProvider(model.provider) === DefaultProvider.ChatGPTSubscription
    : /^https:\/\/bedrock-mantle\.[a-z0-9-]+\.api\.aws(?:\/|$)/u.test(model.baseUrl);
}

export async function assertRuntimeProfile(
  config: StudioConfig,
  profile: StudioProfile,
  workers: PlanWorkers = {},
): Promise<void> {
  const root = getAgentDir();
  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: join(root, "models.json"),
  });
  const roles = config.profiles[profile];
  const validate = (label: string, selection: ModelSelection | undefined) => {
    const model = !selection ? undefined : runtime.getModel(selection.provider, selection.model);
    if (!model || !runtime.hasConfiguredAuth(model.provider) || !runtimeModelAllowed(profile, model))
      throw new Error(`Configure and authenticate ${profile} ${label} before enabling execution`);
    return model;
  };
  for (const role of [AgentRole.Lead, AgentRole.Worker, AgentRole.Reviewer]) {
    validate(role, roles?.[role]);
  }
  for (const [task, worker] of Object.entries(workers)) {
    const model = validate(`worker for task ${task}`, worker);
    if (!getSupportedThinkingLevels(model).includes(worker.reasoning))
      throw new Error(
        `Task ${task}: ${worker.provider}/${worker.model} does not support ${worker.reasoning} reasoning`,
      );
  }
}
