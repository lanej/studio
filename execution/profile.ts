import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { AgentRole, StudioProfile, type StudioConfig } from "../config.ts";
export async function assertRuntimeProfile(
  config: StudioConfig,
  profile: StudioProfile,
): Promise<void> {
  const root = getAgentDir();
  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: join(root, "models.json"),
  });
  for (const role of [AgentRole.Lead, AgentRole.Worker, AgentRole.Reviewer]) {
    const selection = config.profiles[profile]?.[role];
    const model =
      selection === undefined
        ? undefined
        : runtime.getModel(selection.provider, selection.model);
    if (
      model === undefined ||
      !runtime.hasConfiguredAuth(model.provider) ||
      (profile === StudioProfile.Personal &&
        model.provider !== "openai-codex") ||
      (profile === StudioProfile.Work &&
        !/^https:\/\/bedrock-mantle\.[a-z0-9-]+\.api\.aws(?:\/|$)/u.test(
          model.baseUrl,
        ))
    )
      throw new Error(
        `Configure and authenticate ${profile} ${role} before enabling execution`,
      );
  }
}
