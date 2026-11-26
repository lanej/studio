import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { stateDirectory } from "../attempts.ts";
import { randomUUID } from "node:crypto";
import { processStart } from "../process.ts";
import { activationAdmissionBlocked } from "../activation.ts";
import { isEntry, PiEntryType } from "../runtime.ts";
import { PromptLoop } from "./controller.ts";
import { LoopStore, type LoopRecord } from "./store.ts";
import { z } from "zod";

const forkPoints = new Map<string, string | null>();
const childWorkType = "studio:loop-child-work";
const childWorkSchema = z.object({ session: z.string() });
const relationshipType = "studio:session-fork";
const relationshipSchema = z.object({
  session: z.string(),
  parent: z.string(),
  branchPoint: z.string().nullable(),
});

/** Installed before discovery so the native branch point is captured before child isolation markers. */
export function registerSessionForks(pi: ExtensionAPI): void {
  pi.on("session_before_fork", (event, ctx) => {
    const path = ctx.sessionManager.getSessionFile();
    if (path !== undefined)
      forkPoints.set(
        path,
        event.position === "at" ? event.entryId : (ctx.sessionManager.getEntry(event.entryId)?.parentId ?? null),
      );
  });
  pi.on("session_start", (event, ctx) => {
    if (event.reason === "fork" && event.previousSessionFile !== undefined)
      pi.appendEntry(relationshipType, {
        session: ctx.sessionManager.getSessionId(),
        parent: event.previousSessionFile,
        branchPoint: forkPoints.has(event.previousSessionFile)
          ? forkPoints.get(event.previousSessionFile)
          : ctx.sessionManager.getLeafId(),
      });
    if (event.previousSessionFile !== undefined) forkPoints.delete(event.previousSessionFile);
    const relationship = ctx.sessionManager.getEntries().findLast((entry) => {
      if (!isEntry(entry, PiEntryType.Custom) || entry.customType !== relationshipType) return false;
      const parsed = relationshipSchema.safeParse(entry.data);
      return parsed.success && parsed.data.session === ctx.sessionManager.getSessionId();
    });
    const parent = ctx.sessionManager.getHeader()?.parentSession;
    if (parent !== undefined) {
      const parsed = relationshipSchema.safeParse(
        relationship && isEntry(relationship, PiEntryType.Custom) ? relationship.data : undefined,
      );
      ctx.ui.setWidget("studio-fork", [
        `Fork parent: ${parent}`,
        `Branch point: ${parsed.success ? (parsed.data.branchPoint ?? "beginning") : "native history"} · /resume returns to original`,
      ]);
    }
  });
}

export function registerPromptLoops(pi: ExtensionAPI, blocked: (ctx: ExtensionContext) => boolean): void {
  let removeTerminalInput: (() => void) | undefined;
  let controller: PromptLoop | undefined;
  let store: LoopStore | undefined;
  let context: ExtensionContext | undefined;
  let dialogs = 0;
  const uncertainChildren = (ctx: ExtensionContext): boolean =>
    ctx.sessionManager.getEntries().some((entry) => {
      if (!isEntry(entry, PiEntryType.Custom) || entry.customType !== childWorkType) return false;
      const marker = childWorkSchema.safeParse(entry.data);
      return marker.success && marker.data.session === ctx.sessionManager.getSessionId();
    });
  let inspected: number | undefined;
  const eligible = (ctx: ExtensionContext, command = false): boolean =>
    ctx.mode === "tui" &&
    ctx.sessionManager.getSessionFile() !== undefined &&
    !blocked(ctx) &&
    !uncertainChildren(ctx) &&
    (command || !activationAdmissionBlocked());
  const display = (record: LoopRecord): void => {
    context?.ui.setStatus(
      "studio-loop",
      `Loop ${record.state} · ${String(record.count)} · ${String(record.cadenceMs / 1000)}s`,
    );
    context?.ui.setWidget("studio-loop", [
      `Loop ${record.state} · ${String(record.count)} settled · cadence ${String(record.cadenceMs / 1000)}s after settlement`,
      `Prompt: ${record.prompt.replace(/\p{Cc}/gu, " ")}`,
      `Target: ${record.session}`,
      record.intent === null
        ? record.reason
        : `Uncertain/pending #${String(record.intent.ordinal)}: ${record.intent.id}`,
      "/loop status · /loop stop · /loop resume inspected",
    ]);
  };
  const release = (): void => {
    removeTerminalInput?.();
    removeTerminalInput = undefined;
    controller?.release();
    controller = undefined;
    store?.close();
    store = undefined;
    inspected = undefined;
  };
  const claim = async (
    ctx: ExtensionContext,
    definition?: { prompt: string; cadenceMs: number },
  ): Promise<PromptLoop> => {
    if (!eligible(ctx, true))
      throw new Error(
        "Loops require an ordinary foreground persistent Studio conversation without active task or activation fences",
      );
    if (controller) return controller;
    const storage = store ?? new LoopStore();
    store = storage;
    const session = ctx.sessionManager.getSessionId();
    const previous = storage.get(session);
    if (previous?.owner !== null && previous?.owner) {
      let live = true;
      try {
        live = (await processStart(previous.owner.pid)) === previous.owner.started;
      } catch (error) {
        try {
          process.kill(previous.owner.pid, 0);
        } catch (cause) {
          if (z.object({ code: z.literal("ESRCH") }).safeParse(cause).success) live = false;
          else throw error;
        }
      }
      if (live)
        throw new Error(`Loop already owned by live process ${String(previous.owner.pid)}; stop it there first`);
    }
    const identity = {
      pid: process.pid,
      started: await processStart(process.pid),
      token: randomUUID(),
    };
    const record =
      previous ??
      (!definition
        ? undefined
        : {
            session,
            revision: 0,
            prompt: definition.prompt,
            cadenceMs: definition.cadenceMs,
            state: "paused" as const,
            count: 0,
            attempts: 0,
            needsInspection: true,
            intent: null,
            lastSettled: null,
            reason: "Configured",
            owner: null,
          });
    if (!record) throw new Error("Configure first: /loop configure SECONDS PROMPT");
    const claimed = storage.save(
      {
        ...record,
        owner: identity,
        state: "paused",
        needsInspection: true,
        reason:
          record.intent === null
            ? "Restored paused; explicit start or resume required"
            : "Uncertain iteration; inspect /loop status before resume",
      },
      previous?.revision,
    );
    context = ctx;
    controller = new PromptLoop(storage, claimed, identity, {
      snapshot: () => ({
        session: ctx.sessionManager.getSessionId(),
        eligible: eligible(ctx),
        settled: ctx.isIdle(),
        pendingInput: ctx.hasPendingMessages(),
        editorText: ctx.ui.getEditorText(),
        dialogs,
      }),
      dispatch: (prompt) => {
        pi.sendUserMessage(prompt, { expandPromptTemplates: false });
      },
      changed: display,
      schedule: (callback, milliseconds) => {
        const timer = setTimeout(callback, milliseconds);
        timer.unref();
        return () => {
          clearTimeout(timer);
        };
      },
    });
    display(claimed);
    return controller;
  };
  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    dialogs = 0;
    ctx.ui.setStatus("studio-loop", undefined);
    if (ctx.mode !== "tui" || blocked(ctx)) return;
    removeTerminalInput = ctx.ui.onTerminalInput(() => {
      // Pi's built-in selectors expose no public prompt lifecycle. Pause before
      // any native input handler can replace the editor, including remapped keys.
      if (controller?.current.state === "running")
        controller.pause("Paused for session interaction; inspect /loop status and resume");
      return undefined;
    });
    if (!existsSync(join(stateDirectory(), "prompt-loops.sqlite"))) return;
    // A fresh extension runtime must never revive persisted running authority.
    const storage = new LoopStore();
    try {
      const record = storage.get(ctx.sessionManager.getSessionId());
      if (record) {
        display(record);
        if (!blocked(ctx)) await claim(ctx);
      }
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
    } finally {
      storage.close();
    }
  });
  pi.on("session_shutdown", release);
  pi.on("session_before_switch", () => {
    controller?.pause("Session navigation; explicit resume required");
  });
  pi.on("session_before_fork", (_event, ctx) => {
    controller?.pause("Fork navigation; explicit resume required");
    const saved = store?.get(ctx.sessionManager.getSessionId());
    return !ctx.isIdle() ||
      ctx.hasPendingMessages() ||
      dialogs > 0 ||
      blocked(ctx) ||
      uncertainChildren(ctx) ||
      (saved?.intent !== null && saved?.intent) ||
      (saved?.owner !== null && saved?.owner && !controller) ||
      (controller?.current.intent !== null && controller?.current.intent)
      ? { cancel: true }
      : undefined;
  });
  pi.on("session_before_tree", () => {
    controller?.pause("Branch navigation; explicit resume required");
  });
  pi.on("session_tree", (_event, ctx) => {
    context = ctx;
  });
  pi.on("tool_execution_start", (event, ctx) => {
    if (/subagent|delegate|spawn_agent/u.test(event.toolName)) {
      // Bind uncertainty before the tool effect to its origin, even when the
      // operator later switches sessions or navigates before this marker.
      if (!uncertainChildren(ctx))
        pi.appendEntry(childWorkType, {
          session: ctx.sessionManager.getSessionId(),
        });
      controller?.pause("Child work may remain active; start a new session before looping");
    }
  });
  pi.on("input", (event) => {
    controller?.input(event.source === "extension", event.text);
  });
  pi.on("before_agent_start", (event) => {
    controller?.started(event.messageType === "user");
  });
  pi.on("agent_settled", (event) => {
    controller?.settled(event.aborted);
  });
  pi.on("ui_prompt_start", () => {
    dialogs++;
  });
  pi.on("ui_prompt_end", () => {
    dialogs = Math.max(0, dialogs - 1);
  });
  pi.registerCommand("loop", {
    description: "/loop configure SECONDS PROMPT | start | status | stop | resume inspected",
    async handler(argument, ctx) {
      const text = argument.trim();
      if (text === "status" || text === "") {
        const record = controller?.current ?? store?.get(ctx.sessionManager.getSessionId());
        if (!record) {
          ctx.ui.notify("No loop configured. /loop configure SECONDS PROMPT", "info");
          return;
        }
        inspected = record.revision;
        ctx.ui.notify(
          `Loop ${record.state}\nPrompt: ${record.prompt}\nTarget: ${record.session}\nCadence: ${String(record.cadenceMs / 1000)}s after settlement\nSettled iterations: ${String(record.count)}\n${record.reason}\n${record.intent === null ? "No uncertain iteration" : `Uncertain/pending iteration #${String(record.intent.ordinal)}: ${record.intent.id}; inspection does not prove provider completion`}\n/loop start · /loop stop · /loop resume inspected`,
          "info",
        );
        return;
      }
      const configuration = /^configure\s+(\S+)\s+([\s\S]+)$/u.exec(text);
      if (configuration !== null) {
        const cadenceMs = Number(configuration[1]) * 1000;
        const prompt = configuration[2]?.trim() ?? "";
        if (!Number.isSafeInteger(cadenceMs) || cadenceMs <= 0 || cadenceMs > 2_147_483_647 || prompt.length === 0)
          throw new Error("Use a nonempty prompt and positive cadence in seconds (maximum 2147483)");
        const loop = await claim(ctx, { prompt, cadenceMs });
        loop.configure(prompt, cadenceMs);
        return;
      }
      if (text === "stop" && controller) {
        controller.stop();
        return;
      }
      const loop = await claim(ctx);
      if (text === "start") loop.start();
      else if (text === "resume inspected") {
        if (loop.current.intent !== null && (!ctx.isIdle() || ctx.hasPendingMessages() || dialogs > 0))
          throw new Error("Wait for current work and queued input to settle before inspecting and resuming");
        if (inspected !== loop.current.revision)
          throw new Error("Read /loop status immediately before /loop resume inspected");
        loop.resume();
        inspected = undefined;
      } else throw new Error("Use /loop configure SECONDS PROMPT | start | status | stop | resume inspected");
    },
  });
}
