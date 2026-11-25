import {
  createAgentSessionRuntime,
  getAgentDir,
  InteractiveMode,
  SessionManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AgentRole } from "../config.ts";
import { createRoleSession } from "./child-session.ts";
import { processFailure, processStart } from "../process.ts";
import { currentPaneId, requireInteractivePane } from "./interactive-target.ts";
import { ExecutionPhase, ExecutionStore, VerificationPhase } from "./store.ts";
import { executeAssignment, type InteractiveWorker } from "./worker.ts";

const [id, token] = z.tuple([z.uuid(), z.uuid()]).parse(process.argv.slice(2));
const store = new ExecutionStore();
const agentDir = getAgentDir();
let mode: InteractiveMode | undefined;
const controller = new AbortController();
const stop = () => {
  controller.abort();
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
process.once("SIGHUP", stop);

const runWorker: InteractiveWorker = async ({
  cwd,
  directory,
  selection,
  tools,
  prompt,
  check,
  signal,
}) => {
  if (mode !== undefined)
    throw new Error("This attempt already used its native worker");
  await check();
  const sessionManager = SessionManager.create(cwd, directory, { id });
  let turn = 0;
  const runtime = await createAgentSessionRuntime(
    async ({ sessionManager: current }) => {
      if (current !== sessionManager)
        throw new Error("The assigned session cannot change");
      return await createRoleSession({
        role: AgentRole.Worker,
        sessionManager: current,
        model: { provider: selection.provider, id: selection.model },
        thinkingLevel: selection.reasoning,
        tools,
        extension(pi) {
          pi.on("input", async (event, ctx) => {
            if (event.source === "extension") return;
            if (event.streamingBehavior !== undefined) {
              try {
                await check();
                return;
              } catch (error) {
                ctx.ui.notify(processFailure(error).message, "error");
              }
            }
            return { action: "handled" };
          });
          pi.on("turn_start", (_event, ctx) => {
            if (++turn > 32) ctx.abort();
          });
          pi.on("session_before_switch", () => ({ cancel: true }));
          pi.on("session_before_fork", () => ({ cancel: true }));
          pi.on("session_before_tree", () => ({ cancel: true }));
        },
      });
    },
    { cwd, agentDir, sessionManager },
  );
  mode = new InteractiveMode(runtime, {
    assignmentInput: true,
    initialThemeSetting: "dotfiles",
  });
  if (
    !mode.assignmentInputEnabled ||
    typeof mode.runAssignmentTurn !== "function"
  )
    throw new Error("The installed Pi host lacks restricted assignment input");
  const file = sessionManager.getSessionFile();
  if (file === undefined)
    throw new Error("The assigned worker needs a retained transcript");
  store.change(id, (row) => {
    if (
      row.launchToken !== token ||
      row.pid !== process.pid ||
      row.phase !== ExecutionPhase.Running
    )
      throw new Error("The attempt lost its worker fence before starting Pi");
    row.workerSessionFile = file;
    row.sessions.push(file);
  });
  signal.throwIfAborted();
  const abortTurn = () => {
    runtime.session.abort().catch((error: unknown) => {
      console.error(processFailure(error).message);
    });
  };
  signal.addEventListener("abort", abortTurn, { once: true });
  try {
    await mode.runAssignmentTurn(prompt);
    signal.throwIfAborted();
    const last = runtime.session.messages.findLast(
      (message) => message.role === "assistant",
    );
    const response = runtime.session.getLastAssistantText();
    if (
      last?.role !== "assistant" ||
      last.stopReason !== "stop" ||
      response === undefined
    )
      throw new Error(
        "Native worker stopped before producing a complete result",
      );
    return response;
  } finally {
    signal.removeEventListener("abort", abortTurn);
  }
};

try {
  const record = store.attempt(id);
  const project = store.project(record.project);
  if (
    record.launchToken !== token ||
    record.interactive === undefined ||
    record.controller === undefined ||
    realpathSync(process.cwd()) !== project.root ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY
  )
    throw new Error("This process is outside the admitted interactive launch");
  const pane = currentPaneId();
  await requireInteractivePane(record.interactive, pane, token, project.root);
  const started = await processStart(process.pid);
  store.change(id, (row) => {
    if (
      row.launchToken !== token ||
      (row.phase !== ExecutionPhase.Launching &&
        row.phase !== ExecutionPhase.Uncertain) ||
      row.pid !== undefined ||
      (row.pane !== undefined && row.pane !== pane)
    )
      throw new Error("The interactive launch was already owned or retired");
    row.pid = process.pid;
    row.started = started;
    row.pane = pane;
    row.phase = ExecutionPhase.Launching;
    row.message = "Registered the admitted native Pi pane";
  });
  const directory = join(store.directory, "runtime-sessions", id, "controller");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let context: ExtensionContext | undefined;
  const host = await createRoleSession({
    role: AgentRole.Lead,
    sessionManager: SessionManager.create(project.root, directory),
    model: {
      provider: record.controller.provider,
      id: record.controller.model,
    },
    thinkingLevel: record.controller.reasoning,
    tools: [],
    extension(pi) {
      pi.on("session_start", (_event, ctx) => {
        context = ctx;
      });
    },
  });
  try {
    await host.session.bindExtensions({ mode: "rpc" });
    if (context === undefined)
      throw new Error("The native controller context failed to bind");
    await executeAssignment(context, id, controller.signal, token, runWorker);
  } finally {
    host.session.dispose();
  }
} catch (error) {
  const message = processFailure(error).message;
  store.change(id, (row) => {
    if (
      row.launchToken !== token ||
      row.pid !== process.pid ||
      row.phase === ExecutionPhase.Complete
    )
      return;
    row.launchSettled =
      row.verifier === undefined ||
      row.verifier.phase === VerificationPhase.Complete;
    row.phase = row.launchSettled
      ? ExecutionPhase.Parked
      : ExecutionPhase.Uncertain;
    row.message = `Interactive attempt retained. Inspect its transcript and checkout. ${message}`;
  });
  console.error(message);
  process.exitCode = 1;
} finally {
  store.change(id, (row) => {
    if (
      row.launchToken === token &&
      row.pid === process.pid &&
      row.phase === ExecutionPhase.Complete
    )
      row.launchSettled = true;
  });
  store.close();
  if (
    mode?.assignmentInputEnabled === true &&
    typeof mode.closeAssignment === "function"
  )
    await mode.closeAssignment();
}
