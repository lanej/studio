import {
  registerSessionForks,
  registerPromptLoops,
} from "./sessions/extension.ts";
import { basename } from "node:path";
import { selectorText } from "@lanej/pi-components";
import { ExtensionInputComponent } from "@earendil-works/pi-coding-agent";
import { registerModelTools } from "./model-tools/extension.ts";
import { registerHistoryBindings } from "./keybindings.ts";
import { TaskPanel } from "./tasks/panel.ts";
import { readTaskEvidence } from "./tasks/evidence.ts";
import { answerDecision } from "./execution/decisions.ts";
import { pendingDecision, ExecutionPhase } from "./execution/store.ts";
import { retryAttempt } from "./execution/cli.ts";
import { safeGit } from "./execution/git.ts";
import { retryWriterFence } from "./execution/recovery.ts";
import { registerProjectPolicy } from "./execution/policy.ts";
import { registerDiscovery } from "./discovery/extension.ts";
import {
  registerActivation,
  registerActivationAdmission,
} from "./activation.ts";
import { registerCodeIntelligence } from "./code-intelligence/extension.ts";
import { inspectIntegrations } from "./integrations.ts";
import { registerDiagrams } from "./diagram/extension.ts";
import { registerMermaidPreview } from "./diagram/mermaid-preview.ts";
import { registerMermaidTool } from "./diagram/mermaid-tool.ts";
import { registerSearchRendering } from "./search-renderer.ts";
import { registerSkillRendering } from "./skill-renderer.ts";
import { installFooter } from "./footer.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { registerArchives } from "./archives.ts";
import { directoryProfileType, registerDirectory } from "./directory.ts";
import {
  BeadsReader,
  knownTaskStatus,
  TaskStatus,
  taskSchema,
} from "./beads.ts";
import { delegateTool, registerDelegation } from "./delegation.ts";
import { TaskBeads } from "./task-service.ts";
import { dispatchGate } from "./capabilities.ts";
import {
  AgentRole,
  DefaultProvider,
  StudioProfile,
  studioProfileSchema,
  knownProvider,
  loadConfig,
} from "./config.ts";
import { IdleSession, type IdleSessionHost } from "./idle.ts";
import {
  isEntry,
  PiEntryType,
  PiEvent,
  PiMode,
  piModeSchema,
} from "./runtime.ts";
import { focusTaskPane, taskPaneBeads } from "./task-run.ts";
import { hasInteractivePane } from "./execution/interactive-target.ts";

const attemptType = "studio:idle-attempt";
const attemptSchema = z.object({ historyId: z.string() });

export default function studioExtension(
  pi: ExtensionAPI,
  managed?: {
    profile: StudioProfile;
    approvalPending: () => boolean;
    activationBlocked?: () => boolean;
    trackedPullRequest: () => string | undefined;
  },
): void {
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

  const discovery =
    managed === undefined
      ? registerDiscovery(
          pi,
          () => selectedProfile,
          () => {
            tasks.close();
          },
        )
      : undefined;
  if (discovery !== undefined)
    registerProjectPolicy(pi, (ctx) => discovery.runtimeHandoff(ctx)?.target);
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
      discovery?.pending() === true ||
      managed?.approvalPending() === true ||
      managed?.activationBlocked?.() === true ||
      delegation.blocks(ctx.sessionManager.getSessionId()),
  );
  registerPromptLoops(
    pi,
    (ctx) =>
      managed !== undefined ||
      discovery?.pending() === true ||
      delegation.blocks(ctx.sessionManager.getSessionId()),
  );
  registerArchives(pi);
  registerDirectory(
    pi,
    (sessionId) =>
      delegation.blocks(sessionId) || discovery?.pending() === true,
    () => selectedProfile,
  );
  registerDiagrams(pi);
  registerMermaidPreview(pi);
  registerMermaidTool(pi);
  registerSearchRendering(pi);
  registerSkillRendering(pi);
  if (managed !== undefined)
    pi.on("session_start", () => {
      delegation.syncTool();
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
      if (mode === PiMode.Tui)
        installFooter(
          ctx,
          () => pi.getThinkingLevel(),
          managed?.trackedPullRequest,
        );
      if (!config.idleCompaction.enabled || mode !== PiMode.Tui) return;
      const entries = () => ctx.sessionManager.getBranch();
      const history = () =>
        [...entries()]
          .reverse()
          .find((entry) => isEntry(entry, PiEntryType.Message))?.id ?? null;
      const host: IdleSessionHost = {
        snapshot: () => ({
          sessionId: ctx.sessionManager.getSessionId(),
          // The controller compares this leaf within its idle window; persisted markers use message identity.
          branchId: ctx.sessionManager.getLeafId(),
          historyId: history(),
          settled: ctx.isIdle(),
          pendingInput:
            ctx.hasPendingMessages() ||
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
          ctx.ui.notify(
            `Idle compaction failed: ${error.message}. Use /compact to retry.`,
            "error",
          );
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
        .find(
          (entry) =>
            isEntry(entry, PiEntryType.Custom) &&
            entry.customType === attemptType,
        );
      const markedHistory = attemptSchema.safeParse(
        marker !== undefined && isEntry(marker, PiEntryType.Custom)
          ? marker.data
          : undefined,
      );
      // Native/manual compaction also satisfies the current history; metadata entries must not retrigger it.
      const lastCompact = [...entries()]
        .reverse()
        .findIndex((entry) => isEntry(entry, PiEntryType.Compaction));
      const lastMessage = [...entries()]
        .reverse()
        .findIndex((entry) => isEntry(entry, PiEntryType.Message));
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
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
    }
  };

  pi.on(PiEvent.SessionStart, async (_event, ctx) => {
    tasks.close();
    idle.newSession();
    selectedProfile = managed?.profile;
    if (managed === undefined) {
      const marker = ctx.sessionManager
        .getBranch()
        .findLast(
          (entry) =>
            isEntry(entry, PiEntryType.Custom) &&
            entry.customType === directoryProfileType,
        );
      if (marker !== undefined && isEntry(marker, PiEntryType.Custom)) {
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
  pi.on(PiEvent.ModelSelect, () => {
    selectedProfile = managed?.profile;
    delegation.syncTool();
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

  pi.registerShortcut("alt+t", {
    description: "Focus the open task panel; Escape returns to the lead",
    handler: () => {
      tasks.focus();
    },
  });
  pi.registerCommand("tasks", {
    description:
      "Show live Beads tasks without taking focus; use /tasks close to dismiss",
    handler: async (argument, ctx) => {
      if (argument.trim() === "close") {
        tasks.close();
        return;
      }
      const handoff = discovery?.runtimeHandoff(ctx);
      if (discovery !== undefined && handoff === undefined) {
        ctx.ui.notify(
          "Approve a Socrates plan to open its task runtime.",
          "info",
        );
        return;
      }
      const generation = lifecycle;
      const config = await loadConfig();
      if (
        generation !== lifecycle ||
        discovery?.runtimeHandoff(ctx)?.operation !== handoff?.operation
      )
        return;
      const source = handoff?.target.source ?? config.beadsService;
      if (config.beads === undefined && source === undefined) {
        ctx.ui.notify(
          "Configure a Beads service or read-only workspace in your Studio configuration. Run studio config --example for a service example.",
          "warning",
        );
        return;
      }
      const service = source === undefined ? undefined : new TaskBeads(source);
      const reader =
        service !== undefined
          ? {
              list: async () =>
                z.array(taskSchema).parse((await service.list()).items),
              show: async (id: string) =>
                taskSchema.parse(await service.get(id)),
            }
          : config.beads === undefined
            ? undefined
            : new BeadsReader(config.beads);
      if (reader === undefined) return;
      const projectId = source?.projectId;
      const project = config.runtime.projects.find(
        (item) =>
          item.source.projectId === projectId &&
          item.source.url === source?.url,
      );
      await tasks.open(
        ctx,
        {
          key: JSON.stringify([
            ctx.sessionManager.getSessionId(),
            ctx.cwd,
            source,
            config.beads,
          ]),
          focusPane: async (id) => {
            if (source !== undefined) await focusTaskPane(source, id);
          },
          label:
            project === undefined
              ? source === undefined
                ? basename(config.beads?.workspace ?? ctx.cwd)
                : "Beads"
              : basename(project.root),
          identity: projectId ?? config.beads?.database ?? "",
          emptyHint: "Tasks added in Beads will appear here.",
          show: (id) => reader.show(id),
          ...(project === undefined
            ? {}
            : {
                retry: retryAttempt,
                answer: async (
                  id: string,
                  request: string,
                  question: string,
                ) => {
                  const text = await ctx.ui.custom<string | undefined>(
                    (tui, _theme, _keys, done) =>
                      new ExtensionInputComponent(
                        "Answer operator decision",
                        undefined,
                        done,
                        () => {
                          done(undefined);
                        },
                        {
                          tui,
                          description: selectorText(question).replace(
                            /\p{Cc}/gu,
                            " ",
                          ),
                        },
                      ),
                  );
                  if (text === undefined) return false;
                  await answerDecision(id, request, text);
                  return true;
                },
                diff: async (
                  attempt: import("./execution/store.ts").Execution,
                ) => {
                  if (
                    attempt.checkout === undefined ||
                    attempt.base === undefined
                  )
                    throw new Error(
                      "Retained checkout or base receipt is unavailable.",
                    );
                  const diff = await safeGit(
                    project.root,
                    attempt.checkout.path,
                    [
                      "diff",
                      "--no-ext-diff",
                      "--no-textconv",
                      attempt.base,
                      "--",
                    ],
                  );
                  return `${diff}\nTracked diff only; untracked files are not included.`;
                },
              }),
          load: async () => {
            const tasks = await reader.list();
            const evidence = readTaskEvidence(projectId);
            const retryBlocked = new Map<string, string>();
            const answerBlocked = new Map<string, string>();
            for (const attempt of evidence.attempts) {
              if (pendingDecision(attempt) === undefined) continue;
              if (
                attempt.phase !== ExecutionPhase.AwaitingDecision ||
                attempt.interactive !== undefined ||
                attempt.bead === undefined ||
                attempt.revision === undefined
              )
                answerBlocked.set(
                  attempt.id,
                  "the admitted request is not in a settled background decision wait",
                );
              else
                try {
                  if (await retryWriterFence(attempt))
                    answerBlocked.set(
                      attempt.id,
                      "the prior host/verifier is live or uncertain; wait for positive settlement",
                    );
                } catch {
                  answerBlocked.set(
                    attempt.id,
                    "writer state could not be confirmed",
                  );
                }
            }
            for (const attempt of evidence.attempts) {
              if (!["needs-review", "uncertain"].includes(attempt.phase))
                continue;
              if (attempt.interactive !== undefined) {
                retryBlocked.set(
                  attempt.id,
                  "interactive attempts retain their original pane binding; inspect the transcript and checkout. Automatic replacement is unavailable.",
                );
                continue;
              }
              try {
                if (await retryWriterFence(attempt))
                  retryBlocked.set(
                    attempt.id,
                    "the prior writer may still exist or its launch receipt is incomplete; reconcile it first.",
                  );
              } catch {
                retryBlocked.set(
                  attempt.id,
                  "writer state could not be confirmed; inspect the retained execution.",
                );
              }
            }
            const live =
              projectId === undefined
                ? new Set<string>()
                : await taskPaneBeads(projectId);
            return {
              tasks,
              ...evidence,
              retryBlocked,
              answerBlocked,
              observedAt: new Date().toLocaleTimeString(),
              focusable: new Set(
                tasks
                  .filter(
                    (task) =>
                      knownTaskStatus(task.status) === TaskStatus.InProgress &&
                      (live.has(task.id) ||
                        evidence.attempts.some(
                          (attempt) =>
                            attempt.bead?.id === task.id &&
                            attempt.bead.assignee === task.assignee &&
                            hasInteractivePane(attempt),
                        )),
                  )
                  .map((task) => task.id),
              ),
              limitReached: tasks.length === 1000,
            };
          },
        },
        argument.trim().length === 0 ? undefined : argument.trim(),
      );
    },
  });

  async function selectProfile(
    argument: string,
    ctx: ExtensionContext,
    restoring = false,
  ): Promise<void> {
    if (process.env["STUDIO_ATTEMPT"] !== undefined) {
      ctx.ui.notify("Set the profile on studio start.", "warning");
      return;
    }
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      ctx.ui.notify(
        "Wait for the conversation and queued messages to settle before changing profiles",
        "warning",
      );
      return;
    }
    const config = await loadConfig();
    const parsedName = studioProfileSchema.safeParse(argument.trim());
    if (!parsedName.success) {
      ctx.ui.notify(
        "Use /studio-profile work or /studio-profile personal",
        "warning",
      );
      return;
    }
    const name = parsedName.data;
    const profile = config.profiles[name];
    if (profile === undefined) {
      ctx.ui.notify(
        `Configure the ${name} profile first; studio config --example shows the role selections`,
        "warning",
      );
      return;
    }
    const models = Object.values(profile).map((role) =>
      ctx.modelRegistry.find(role.provider, role.model),
    );
    if (models.some((model) => model === undefined)) {
      ctx.ui.notify(
        "A configured role model is missing from Pi's registry; no model was changed",
        "error",
      );
      return;
    }
    if (
      name === StudioProfile.Personal &&
      Object.values(profile).some(
        (role) =>
          knownProvider(role.provider) !== DefaultProvider.ChatGPTSubscription,
      )
    ) {
      ctx.ui.notify(
        "The personal profile must use Pi's openai-codex subscription provider",
        "error",
      );
      return;
    }
    if (
      name === StudioProfile.Work &&
      models.some(
        (model) =>
          model === undefined ||
          !/^https:\/\/bedrock-mantle\.[a-z0-9-]+\.api\.aws(?:\/|$)/.test(
            model.baseUrl,
          ),
      )
    ) {
      ctx.ui.notify(
        "The work profile must resolve to an explicit HTTPS Bedrock Mantle endpoint",
        "error",
      );
      return;
    }
    const leadSelection = profile[AgentRole.Lead];
    const lead = ctx.modelRegistry.find(
      leadSelection.provider,
      leadSelection.model,
    );
    if (lead === undefined) return;
    if (
      restoring &&
      (ctx.model?.provider !== lead.provider || ctx.model.id !== lead.id)
    ) {
      ctx.ui.notify(
        "The driver profile no longer matches the current model. Select /studio-profile again to enable delegation.",
        "warning",
      );
      return;
    }
    const reasoning = restoring
      ? pi.getThinkingLevel()
      : leadSelection.reasoning;
    if (!(await pi.setModel(lead))) {
      ctx.ui.notify(
        `Cannot switch to ${name}. Authenticate with ${leadSelection.provider} and retry. The current model is still active.`,
        "error",
      );
      return;
    }
    pi.setThinkingLevel(reasoning);
    selectedProfile = name;
    delegation.syncTool();
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
        .map(
          ([name, state]) =>
            `${name}: ${state.available ? "available" : state.reason}`,
        )
        .join("\n");
      ctx.ui.notify(
        `${summary}\n${dispatchGate.reason}\n${intelligence.status()}`,
        "info",
      );
    },
  });
}
