import { parse } from "smol-toml";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  defaultPaneKeybindings,
  paneKeybindingsSchema,
} from "./pane-keybindings-config.ts";

export enum StudioProfile {
  Work = "work",
  Personal = "personal",
}
export const studioProfileSchema = z.enum(StudioProfile);

export enum AgentRole {
  Lead = "lead",
  Worker = "worker",
  Reviewer = "reviewer",
  Explorer = "explorer",
}

export enum DefaultProvider {
  BedrockMantle = "bedrock-mantle",
  ChatGPTSubscription = "openai-codex",
}

export enum ReasoningLevel {
  Off = "off",
  Minimal = "minimal",
  Low = "low",
  Medium = "medium",
  High = "high",
  ExtraHigh = "xhigh",
}
export enum ModelCapability {
  Fast = "fast",
  Standard = "standard",
  Advanced = "advanced",
}
export function knownProvider(value: string): DefaultProvider | undefined {
  const parsed = z.enum(DefaultProvider).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const modelIdentity = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
});
export const selection = modelIdentity.extend({
  reasoning: z.enum(ReasoningLevel),
});
export type ModelSelection = z.infer<typeof selection>;
export const taskAssignmentSchema = z.strictObject({
  capability: z.enum(ModelCapability),
  reasoning: z.enum(ReasoningLevel),
});
export type TaskAssignment = z.infer<typeof taskAssignmentSchema>;
const profile = z
  .object({
    [AgentRole.Lead]: selection,
    [AgentRole.Worker]: selection,
    [AgentRole.Reviewer]: selection,
    [AgentRole.Explorer]: selection,
    workerModels: z
      .strictObject({
        [ModelCapability.Fast]: modelIdentity.optional(),
        [ModelCapability.Advanced]: modelIdentity.optional(),
      })
      .default({}),
  })
  .strict();
const optionalIntegration = (executable: string) =>
  z
    .object({
      enabled: z.boolean().default(false),
      executable: z
        .string()
        .min(1)
        .refine(
          (value) => !value.includes("/") || isAbsolute(value),
          "Use an executable name or absolute path",
        )
        .default(executable),
    })
    .strict()
    .prefault({});
export const defaultMinSplitColumns = 40;

export const serviceSchema = z
  .object({
    url: z.url(),
    projectId: z.uuid(),
    reviewOnly: z.boolean().optional(),
    tokenFile: z.string().refine(isAbsolute).optional(),
  })
  .strict();
export const runtimeProjectSchema = z
  .object({
    root: z.string().refine(isAbsolute),
    source: serviceSchema,
    profile: studioProfileSchema,
    base: z.string().min(1),
    merge: z.boolean().default(false),
    beadsWorkspace: z.string().refine(isAbsolute),
    beadsExecutable: z.string().min(1).default("bd"),
    beadsDatabase: z.string().min(1),
    verificationReadPaths: z.array(z.string().refine(isAbsolute)).default([]),
  })
  .strict();

export const configSchema = z
  .object({
    keybindings: paneKeybindingsSchema,
    runtime: z
      .object({
        enabled: z.boolean().default(false),
        concurrency: z.number().int().min(1).max(3).default(2),
        pollMs: z.number().int().min(1000).max(60000).default(5000),
        projects: z.array(runtimeProjectSchema).default([]),
      })
      .strict()
      .default({ enabled: false, concurrency: 2, pollMs: 5000, projects: [] }),
    integrations: z
      .object({
        zellij: optionalIntegration("zellij"),
        neovim: optionalIntegration("nvim"),
        worktrees: optionalIntegration("worktree"),
        octo: optionalIntegration("octo-manager"),
      })
      .strict()
      .prefault({}),
    display: z
      .strictObject({
        min_split_columns: z
          .number()
          .int()
          .positive()
          .default(defaultMinSplitColumns),
        inline_diagnostics: z.boolean().default(true),
        added_background: z
          .string()
          .regex(/^#[0-9a-f]{6}$/iu)
          .optional(),
        removed_background: z
          .string()
          .regex(/^#[0-9a-f]{6}$/iu)
          .optional(),
      })
      .default({
        min_split_columns: defaultMinSplitColumns,
        inline_diagnostics: true,
      }),
    lsp: z
      .object({ enabled: z.boolean().default(true) })
      .strict()
      .default({ enabled: true }),
    delegation: z
      .object({ enabled: z.boolean().default(true) })
      .strict()
      .prefault({}),
    archives: z
      .object({
        database: z
          .string()
          .refine(isAbsolute, "Use an absolute archive database path")
          .optional(),
      })
      .strict()
      .default({}),
    idleCompaction: z
      .object({
        enabled: z.boolean().default(true),
        idleMs: z.number().int().min(1000).max(86_400_000).default(300_000),
        minimumContextPercent: z.number().min(1).max(100).default(60),
      })
      .strict()
      .default({ enabled: true, idleMs: 300_000, minimumContextPercent: 60 }),
    beads: z
      .object({
        workspace: z
          .string()
          .refine(isAbsolute, "Use an absolute Beads workspace path"),
        database: z.string().min(1),
        branch: z.string().min(1),
        executable: z.string().min(1).default("bd"),
      })
      .strict()
      .optional(),
    beadsService: z
      .object({
        url: z.url(),
        projectId: z.uuid(),
        reviewOnly: z.boolean().optional(),
        tokenFile: z
          .string()
          .refine(isAbsolute, "Use an absolute token-file path")
          .optional(),
      })
      .strict()
      .optional(),
    profiles: z
      .object({
        [StudioProfile.Work]: profile.optional(),
        [StudioProfile.Personal]: profile.optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type StudioConfig = z.infer<typeof configSchema>;

export function workerForTask(
  roles: z.infer<typeof profile>,
  assignment?: TaskAssignment,
): ModelSelection {
  if (assignment === undefined) return roles.worker;
  const model =
    assignment.capability === ModelCapability.Standard
      ? roles.worker
      : roles.workerModels[assignment.capability];
  if (model === undefined)
    throw new Error(
      `Configure the ${assignment.capability} worker model first`,
    );
  return { ...model, reasoning: assignment.reasoning };
}

export function configPath(): string {
  const explicit = process.env["STUDIO_CONFIG"];
  if (explicit !== undefined) return explicit;
  const directory = join(
    process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"),
    "studio",
  );
  const toml = join(directory, "config.toml");
  const json = join(directory, "config.json");
  return existsSync(toml) || !existsSync(json) ? toml : json;
}

export async function loadConfig(path = configPath()): Promise<StudioConfig> {
  try {
    const contents = await readFile(path, "utf8");
    return configSchema.parse(
      extname(path) === ".toml" ? parse(contents) : JSON.parse(contents),
    );
  } catch (error) {
    if (
      z.object({ code: z.literal("ENOENT") }).safeParse(error).success &&
      path === configPath() &&
      process.env["STUDIO_CONFIG"] === undefined
    ) {
      return configSchema.parse({});
    }
    throw new Error(
      `Cannot load Studio configuration ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const roles = (provider: string, model: string) => ({
  [AgentRole.Lead]: {
    provider,
    model,
    reasoning: ReasoningLevel.High,
  },
  [AgentRole.Worker]: {
    provider,
    model,
    reasoning: ReasoningLevel.Medium,
  },
  [AgentRole.Reviewer]: {
    provider,
    model,
    reasoning: ReasoningLevel.Medium,
  },
  [AgentRole.Explorer]: {
    provider,
    model,
    reasoning: ReasoningLevel.Low,
  },
});

export const exampleConfig = {
  keybindings: defaultPaneKeybindings,
  runtime: { enabled: false, concurrency: 2, pollMs: 5000, projects: [] },
  display: {
    min_split_columns: defaultMinSplitColumns,
    inline_diagnostics: true,
  },
  lsp: { enabled: true },
  integrations: {
    zellij: { enabled: true, executable: "zellij" },
    neovim: { enabled: false, executable: "nvim" },
    worktrees: { enabled: true, executable: "worktree" },
    octo: { enabled: true, executable: "octo-manager" },
  },
  delegation: { enabled: true },
  idleCompaction: { enabled: true, idleMs: 300_000, minimumContextPercent: 60 },
  beadsService: {
    url: "http://127.0.0.1:8790",
    projectId: "11111111-1111-4111-8111-111111111111",
  },
  profiles: {
    [StudioProfile.Work]: roles(
      DefaultProvider.BedrockMantle,
      "openai.gpt-6.1-sol",
    ),
    [StudioProfile.Personal]: roles(
      DefaultProvider.ChatGPTSubscription,
      "gpt-6.1-sol",
    ),
  },
};
