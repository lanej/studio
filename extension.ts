import { defaultPaneKeybindings, type PaneKeybindings } from "./pane-keybindings.ts";
import { registerSessionForks, registerPromptLoops } from "./sessions/extension.ts";
import { registerModelTools } from "./model-tools/extension.ts";
import { registerHistoryBindings } from "./keybindings.ts";
import { TaskPanel, type OpenTasks } from "./tasks/panel.ts";
import { createTaskPanelSource } from "./tasks/source.ts";
import { isDeepStrictEqual } from "node:util";
import { registerProjectPolicy } from "./execution/policy.ts";
import { registerDiscovery } from "./discovery/extension.ts";
import { registerActivation, registerActivationAdmission } from "./activation.ts";
import { registerCodeIntelligence } from "./code-intelligence/extension.ts";
import { inspectIntegrations } from "./integrations.ts";
import { registerDiagrams } from "./diagram/extension.ts";
import { registerMermaidPreview } from "./diagram/mermaid-preview.ts";
import { registerMermaidTool } from "./diagram/mermaid-tool.ts";
import { registerSearchRendering } from "./search-renderer.ts";
import { registerSkillRendering } from "./skill-renderer.ts";
import { installFooter } from "./footer.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { registerArchives } from "./archives.ts";
import { directoryProfileType, registerDirectory } from "./directory.ts";
import { delegateTool, registerDelegation } from "./delegation.ts";
import { dispatchGate } from "./capabilities.ts";
import {
  AgentRole,
  DefaultProvider,
  StudioProfile,
  studioProfileSchema,
  type StudioConfig,
  knownProvider,
  loadConfig,
} from "./config.ts";
import { IdleSession, type IdleSessionHost } from "./idle.ts";
import { isEntry, PiEntryType, PiEvent, PiMode, piModeSchema } from "./runtime.ts";
import { registerDocumentWorkspace } from "./documents/workspace.ts";
import { registerPlanningDocuments, getPlanningDocuments } from "./planning/documents.ts";

const attemptType = "studio:idle-attempt";
const attemptSchema = z.object({ historyId: z.string() });

interface ManagedLead {
  profile: StudioProfile;
  approvalPending: () => boolean;
  activationBlocked?: () => boolean;
  trackedPullRequest: () => string | undefined;
}

// Pi collects extension shortcuts during loading. Invalid configuration is reported
// by session initialization; a managed lead must still install its other controls.
export async function loadLeadKeybindings(): Promise<PaneKeybindings> {
  try {
    return (await loadConfig()).keybindings;
  } catch {
    return defaultPaneKeybindings;
  }
}

export default async function studioExtension(pi: ExtensionAPI, managed?: ManagedLead): Promise<void> {
  registerStudio(pi, managed, await loadLeadKeybindings());
}

export function registerStudio(
  pi: ExtensionAPI,
  managed: ManagedLead | undefined,
  keybindings: PaneKeybindings,
): OpenTasks {
  registerPlanningDocuments(pi);
  registerHistoryBindings(pi);
  registerActivationAdmission(pi);
  registerSessionForks(pi);
  const intelligence = registerCodeIntelligence(pi);
  registerModelTools(pi, { coding: managed === undefined });
  const idle = new IdleSession();
  const tasks = new TaskPanel();
  let removeInputListener: (() => void) | undefined;
  let lifecycle = 0;
  let selectedProfile = managed?.profile;

  const discovery = !managed
    ? registerDiscovery(
        pi,
        () => selectedProfile,
        () => {
          tasks.close();
        },
        openTasks,
        keybindings,
      )
    : undefined;
  if (discovery) registerProjectPolicy(pi, (ctx) => discovery.runtimeHandoff(ctx)?.target);
  registerDocumentWorkspace(pi);
  const documentPending = () => getPlanningDocuments(pi)?.pending() === true;
  pi.on("session_before_switch", () => (documentPending() ? { cancel: true } : undefined));
  pi.on("session_before_fork", () => (documentPending() ? { cancel: true } : undefined));
  pi.on("session_before_tree", () => (documentPending() ? { cancel: true } : undefined));
  const delegation = registerDelegation(
    pi,
    () => selectedProfile,
    () => {
      idle.terminalInput();
    },
  );
  registerActivation(
    pi,
    (ctx) =>
      documentPending() ||
      discovery?.pending() === true ||
      managed?.approvalPending() === true ||
      managed?.activationBlocked?.() === true ||
      delegation.blocks(ctx.sessionManager.getSessionId()),
  );
  registerPromptLoops(
    pi,
    (ctx) =>
      managed !== undefined ||
      documentPending() ||
      discovery?.pending() === true ||
      delegation.blocks(ctx.sessionManager.getSessionId()),
  );
  registerArchives(pi);
  registerDirectory(
    pi,
    (sessionId) => documentPending() || delegation.blocks(sessionId) || discovery?.pending() === true,
    () => selectedProfile,
  );
  registerDiagrams(pi);
  registerMermaidPreview(pi);
  registerMermaidTool(pi);
  registerSearchRendering(pi);
  registerSkillRendering(pi);
  if (managed)
    pi.on("session_start", (_event, ctx) => {
      delegation.syncTool(ctx);
    });

  const release = () => {
    lifecycle++;
    idle.stop();
    removeInputListener?.();
    removeInputListener = undefined;
  };

  const initialize = async (ctx: ExtensionContext) => {
    release();
    const generation = lifecycle;
    try {
      ctx.ui.setStatus("studio", undefined);
      const config = await loadConfig();
      if (generation !== lifecycle) return;
      const mode = piModeSchema.parse(ctx.mode);
      if (mode === PiMode.Tui) installFooter(ctx, () => pi.getThinkingLevel(), managed?.trackedPullRequest);
      if (!config.idleCompaction.enabled || mode !== PiMode.Tui) return;
      const entries = () => ctx.sessionManager.getBranch();
      const history = () => [...entries()].reverse().find((entry) => isEntry(entry, PiEntryType.Message))?.id ?? null;
      const host: IdleSessionHost = {
        snapshot: () => ({
          sessionId: ctx.sessionManager.getSessionId(),
          // The controller compares this leaf within its idle window; persisted markers use message identity.
          branchId: ctx.sessionManager.getLeafId(),
          historyId: history(),
          settled: ctx.isIdle(),
          pendingInput:
            ctx.hasPendingMessages() ||
            documentPending() ||
            managed?.approvalPending() === true ||
            discovery?.pending() === true ||
            delegation.blocks(ctx.sessionManager.getSessionId()),
          editorText: ctx.ui.getEditorText(),
          percent: ctx.getContextUsage()?.percent ?? null,
        }),
        compact: (callbacks) => {
          ctx.compact({
            customInstructions:
              "Preserve task and workspace identity, accepted scope and criteria, worktree and source references, delegated findings, outstanding decisions, and pending or uncertain external effects. Keep observed task text distinct from accepted authorization.",
            onComplete: () => {
              callbacks.complete();
            },
            onError: (error) => {
              callbacks.error(error);
            },
          });
        },
        recordAttempt: (historyId) => {
          pi.appendEntry(attemptType, { historyId });
        },
        notify: (error) => {
          ctx.ui.notify(`Idle compaction failed: ${error.message}. Use /compact to retry.`, "error");
        },
        schedule: (callback, delay) => {
          const timer = setTimeout(callback, delay);
          timer.unref();
          return () => {
            clearTimeout(timer);
          };
        },
      };
      const marker = [...entries()]
        .reverse()
        .find((entry) => isEntry(entry, PiEntryType.Custom) && entry.customType === attemptType);
      const markedHistory = attemptSchema.safeParse(
        marker && isEntry(marker, PiEntryType.Custom) ? marker.data : undefined,
      );
      // Native/manual compaction also satisfies the current history; metadata entries must not retrigger it.
      const lastCompact = [...entries()].reverse().findIndex((entry) => isEntry(entry, PiEntryType.Compaction));
      const lastMessage = [...entries()].reverse().findIndex((entry) => isEntry(entry, PiEntryType.Message));
      idle.initialize(
        host,
        config.idleCompaction.idleMs,
        config.idleCompaction.minimumContextPercent,
        lastCompact >= 0 && lastCompact < lastMessage
          ? history()
          : markedHistory.success
            ? markedHistory.data.historyId
            : null,
      );
      removeInputListener = ctx.ui.onTerminalInput(() => {
        idle.terminalInput();
        return undefined;
      });
    } catch (error) {
      if (generation === lifecycle && ctx.hasUI)
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  };

  pi.on(PiEvent.SessionStart, async (_event, ctx) => {
    tasks.close();
    idle.newSession();
    selectedProfile = managed?.profile;
    if (!managed) {
      const marker = ctx.sessionManager
        .getBranch()
        .findLast((entry) => isEntry(entry, PiEntryType.Custom) && entry.customType === directoryProfileType);
      if (marker && isEntry(marker, PiEntryType.Custom)) {
        const profile = studioProfileSchema.safeParse(marker.data);
        if (profile.success) {
          // Consume the handoff before revalidation so a later resume does not
          // override a model or profile the user selected after this switch.
          pi.appendEntry(directoryProfileType, null);
          await selectProfile(profile.data, ctx, true);
        }
      }
    }
    await initialize(ctx);
  });
  pi.on(PiEvent.SessionShutdown, () => {
    tasks.close();
    release();
  });
  pi.on(PiEvent.SessionTree, async (_event, ctx) => {
    tasks.close();
    await initialize(ctx);
  });
  pi.on(PiEvent.SessionCompact, async (_event, ctx) => initialize(ctx));
  pi.on(PiEvent.ModelSelect, (_event, ctx) => {
    selectedProfile = managed?.profile;
    delegation.syncTool(ctx);
  });
  pi.on(PiEvent.Input, () => {
    idle.activity();
  });
  pi.on(PiEvent.AgentStart, () => {
    idle.agentStart();
  });
  pi.on(PiEvent.AgentSettled, () => {
    idle.agentSettled();
  });
  pi.on(PiEvent.PromptStart, () => {
    idle.promptStart();
  });
  pi.on(PiEvent.PromptEnd, () => {
    idle.promptEnd();
  });
  pi.on(PiEvent.ToolStart, (event) => {
    if (event.toolName === delegateTool) idle.activity();
    else idle.toolStart(event.toolName);
  });

  pi.registerCommand("tasks", {
    description: "Open the task browser or inspect a Beads task by ID",
    handler: async (argument, ctx) => {
      const beadId = argument.trim();
      if (beadId === "close") {
        tasks.close();
        return;
      }
      await openTasks(ctx, beadId.length === 0 ? undefined : beadId);
    },
  });
  async function openTasks(
    ctx: ExtensionContext,
    beadId?: string,
    authority?: StudioConfig["beadsService"],
  ): Promise<void> {
    const handoff = discovery?.runtimeHandoff(ctx);
    if (authority && discovery && !isDeepStrictEqual(authority, handoff?.target.source)) return;
    if (discovery && !handoff) {
      ctx.ui.notify("Approve a Socrates plan to open its task runtime.", "info");
      return;
    }
    const generation = lifecycle;
    await tasks.open(
      ctx,
      async (current) => {
        const config = await loadConfig();
        if (!current() || generation !== lifecycle || discovery?.runtimeHandoff(ctx)?.operation !== handoff?.operation)
          return;
        const source = createTaskPanelSource(config, {
          authority: authority ?? handoff?.target.source,
          cwd: ctx.cwd,
          editAnswer: (question, taskTitle) => tasks.editAnswer(ctx, question, taskTitle),
        });
        if (!source)
          ctx.ui.notify(
            "Configure a Beads service or read-only workspace in your Studio configuration. Run studio config --example for a service example.",
            "warning",
          );
        return source;
      },
      beadId,
      keybindings,
    );
  }

  async function selectProfile(argument: string, ctx: ExtensionContext, restoring = false): Promise<void> {
    if (process.env["STUDIO_ATTEMPT"] !== undefined) {
      ctx.ui.notify("Set the profile on studio start.", "warning");
      return;
    }
    if (!ctx.isIdle() || ctx.hasPendingMessages() || documentPending()) {
      ctx.ui.notify("Wait for the conversation and queued messages to settle before changing profiles", "warning");
      return;
    }
    const config = await loadConfig();
    const parsedName = studioProfileSchema.safeParse(argument.trim());
    if (!parsedName.success) {
      ctx.ui.notify("Use /studio-profile work or /studio-profile personal", "warning");
      return;
    }
    const name = parsedName.data;
    const profile = config.profiles[name];
    if (!profile) {
      ctx.ui.notify(
        `Configure the ${name} profile first; studio config --example shows the role selections`,
        "warning",
      );
      return;
    }
    const roles = Object.values(AgentRole).map((role) => profile[role]);
    const models = roles.map((role) => ctx.modelRegistry.find(role.provider, role.model));
    if (models.some((model) => model === undefined)) {
      ctx.ui.notify("A configured role model is missing from Pi's registry; no model was changed", "error");
      return;
    }
    if (
      name === StudioProfile.Personal &&
      roles.some((role) => knownProvider(role.provider) !== DefaultProvider.ChatGPTSubscription)
    ) {
      ctx.ui.notify("The personal profile must use Pi's openai-codex subscription provider", "error");
      return;
    }
    if (
      name === StudioProfile.Work &&
      models.some(
        (model) =>
          model === undefined || !/^https:\/\/bedrock-mantle\.[a-z0-9-]+\.api\.aws(?:\/|$)/.test(model.baseUrl),
      )
    ) {
      ctx.ui.notify("The work profile must resolve to an explicit HTTPS Bedrock Mantle endpoint", "error");
      return;
    }
    const leadSelection = profile[AgentRole.Lead];
    const lead = ctx.modelRegistry.find(leadSelection.provider, leadSelection.model);
    if (!lead) return;
    if (restoring && (ctx.model?.provider !== lead.provider || ctx.model.id !== lead.id)) {
      ctx.ui.notify(
        "The driver profile no longer matches the current model. Select /studio-profile again to enable delegation.",
        "warning",
      );
      return;
    }
    const reasoning = restoring ? pi.getThinkingLevel() : leadSelection.reasoning;
    if (!(await pi.setModel(lead))) {
      ctx.ui.notify(
        `Cannot switch to ${name}. Authenticate with ${leadSelection.provider} and retry. The current model is still active.`,
        "error",
      );
      return;
    }
    pi.setThinkingLevel(reasoning);
    selectedProfile = name;
    delegation.syncTool(ctx);
  }
  pi.registerCommand("studio-profile", {
    description: "Explicitly select the work or personal lead model",
    handler: (argument, ctx) => selectProfile(argument, ctx),
  });

  pi.registerCommand("studio-status", {
    description: "Inspect the Studio capability boundary",
    handler: async (_argument, ctx) => {
      const integrations = await inspectIntegrations(await loadConfig());
      const summary = Object.entries(integrations)
        .map(([name, state]) => `${name}: ${state.available ? "available" : state.reason}`)
        .join("\n");
      ctx.ui.notify(`${summary}\n${dispatchGate.reason}\n${intelligence.status()}`, "info");
    },
  });
  return openTasks;
}
