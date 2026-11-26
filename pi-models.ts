import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DefaultProvider } from "./config.ts";

// The API declarations are the same source used by Pi's model catalog:
// https://github.com/anomalyco/models.dev/blob/dev/packages/core/src/schema-v2.ts
export const modelsDevUrl = "https://models.dev/experimental/v2.0/api.json";
const capabilitiesSchema = z.object({
  tools: z.object({ strict: z.boolean().optional() }).optional(),
  reasoning: z
    .object({
      effort: z.array(z.string().nullable()).optional(),
      budget: z.object({ min: z.number().optional(), max: z.number().optional() }).optional(),
    })
    .optional(),
  temperature: z.boolean().optional(),
});
const sourceSchema = z.object({
  "amazon-bedrock": z.object({
    models: z.record(
      z.string(),
      z.object({
        id: z.string(),
        capabilities: capabilitiesSchema.optional(),
        api: z.record(
          z.string(),
          z.object({
            base_url: z.string(),
            capabilities: capabilitiesSchema.optional(),
          }),
        ),
      }),
    ),
  }),
});
type PiModel = ReturnType<ModelRuntime["getModels"]>[number];
const protocols = [
  { source: "responses", pi: "openai-responses" },
  { source: "messages", pi: "anthropic-messages" },
  { source: "chat-completions", pi: "openai-completions" },
];

export function mantleModels(models: readonly PiModel[], catalog: unknown, region: string) {
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/u.test(region))
    throw new Error("Specify a valid AWS region with --region or AWS_REGION");
  const source = sourceSchema.parse(catalog)["amazon-bedrock"].models;
  const definitions = [];
  for (const model of models) {
    if (model.provider !== "amazon-bedrock") continue;
    const entry = source[model.id];
    if (!entry) continue;
    if (entry.id !== model.id) throw new Error(`Catalog ID mismatch for ${model.id}`);
    for (const protocol of protocols) {
      const declaration = entry.api[protocol.source];
      if (!declaration) continue;
      const baseUrl = declaration.base_url.replaceAll(/\$\{AWS_REGION\}/gu, region);
      const url = new URL(baseUrl);
      if (url.hostname !== `bedrock-mantle.${region}.api.aws`) continue;
      if (
        url.protocol !== "https:" ||
        url.port !== "" ||
        url.username !== "" ||
        url.password !== "" ||
        url.search !== "" ||
        url.hash !== ""
      )
        throw new Error(`Invalid Mantle endpoint for ${model.id}`);
      const strict = declaration.capabilities?.tools?.strict ?? false;
      const reasoning = declaration.capabilities?.reasoning ?? entry.capabilities?.reasoning;
      const temperature = declaration.capabilities?.temperature ?? entry.capabilities?.temperature;
      const compat =
        protocol.source === "messages"
          ? {
              supportsStrictTools: strict,
              forceAdaptiveThinking: (reasoning?.effort?.length ?? 0) > 0 && reasoning?.budget === undefined,
              ...(temperature === undefined ? {} : { supportsTemperature: temperature }),
            }
          : { supportsStrictMode: strict };
      definitions.push({
        ...model,
        provider: undefined,
        headers: undefined,
        api: protocol.pi,
        compat,
        // Anthropic's SDK appends /v1/messages; the source declares the API root.
        baseUrl: protocol.source === "messages" ? baseUrl.replace(/\/v1\/?$/u, "") : baseUrl,
      });
      break;
    }
  }
  if (definitions.length === 0) throw new Error("Pi's catalog contains no models with supported Mantle APIs");
  return {
    providers: {
      [DefaultProvider.BedrockMantle]: {
        apiKey: "$AWS_BEARER_TOKEN_BEDROCK",
        models: definitions,
      },
    },
  };
}

export async function generatePiModels(
  region = process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"],
  catalogPath?: string,
) {
  if (region === undefined || region === "")
    throw new Error("Set --region, AWS_REGION or AWS_DEFAULT_REGION for --pi-models");
  const temporary = await mkdtemp(join(tmpdir(), "studio-models-"));
  try {
    // Use Pi's bundled/cached metadata without loading user models or credentials.
    const registry = await ModelRuntime.create({
      authPath: join(temporary, "auth.json"),
      modelsPath: join(temporary, "models.json"),
      modelsStorePath: join(getAgentDir(), "models-store.json"),
      allowModelNetwork: false,
    });
    let catalog: unknown;
    if (catalogPath !== undefined) {
      catalog = JSON.parse(await readFile(catalogPath, "utf8"));
    } else {
      const response = await fetch(modelsDevUrl, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Cannot read model API declarations: HTTP ${String(response.status)}`);
      catalog = await response.json();
    }
    return mantleModels(registry.getModels("amazon-bedrock"), catalog, region);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
