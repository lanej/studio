import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type ExtensionUIContext,
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { registerPromptLoops } from "../sessions/extension.ts";
import { registerActivationAdmission } from "../activation.ts";
import { LoopStore } from "../sessions/store.ts";

await test("actual SDK commands preserve live loop ownership, activation gates, and inspected restart recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-loop-sdk-"));
  const previous = process.env["STUDIO_STATE_DIR"];
  const state = join(directory, "state");
  process.env["STUDIO_STATE_DIR"] = state;
  const admission = globalThis.studioActivationAdmissionState;
  assert.ok(admission !== undefined);
  const originalFence = admission.fenced;
  const session = SessionManager.create(directory, join(directory, "sessions"));
  session.appendMessage({
    role: "user",
    content: "Persistent conversation",
    timestamp: Date.now(),
  });
  let requests = 0;
  let blocked = false;
  const runners: ExtensionRunner[] = [];
  const fixture = async () => {
    const agentDir = join(directory, "agent");
    await mkdir(agentDir, { recursive: true });
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir,
      settingsManager: SettingsManager.inMemory(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        (pi) => {
          registerActivationAdmission(pi);
          registerPromptLoops(pi, () => blocked);
        },
      ],
    });
    await loader.reload();
    const { errors, extensions, runtime } = loader.getExtensions();
    assert.deepEqual(errors, []);
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const runner = new ExtensionRunner(
      extensions,
      runtime,
      directory,
      session,
      new ModelRegistry(modelRuntime),
    );
    runners.push(runner);
    runtime.getThinkingLevel = () => "off";
    runtime.sendUserMessage = () => {
      requests++;
    };
    let input: Parameters<ExtensionUIContext["onTerminalInput"]>[0] | undefined;
    runner.setUIContext(
      {
        ...runner.getUIContext(),
        onTerminalInput: (handler) => {
          input = handler;
          return () => {
            input = undefined;
          };
        },
      },
      "tui",
    );
    await runner.emit({ type: "session_start", reason: "startup" });
    const command = runner.getCommand("loop");
    assert.ok(command !== undefined);
    return {
      runner,
      input: (data: string) => input?.(data),
      command: (text: string) =>
        command.handler(text, runner.createCommandContext()),
    };
  };
  let store: LoopStore | undefined;
  try {
    const first = await fixture();
    assert.equal(
      existsSync(join(state, "prompt-loops.sqlite")),
      false,
      "Opening an unconfigured session must not create loop state",
    );
    store = new LoopStore(state);
    for (const invalid of [
      "configure 0 prompt",
      "configure NaN prompt",
      "configure -1 prompt",
      "configure 0.0001 prompt",
      "configure 99999999 prompt",
    ])
      await assert.rejects(first.command(invalid));
    blocked = true;
    await assert.rejects(
      first.command("configure 0.01 Check progress"),
      /ordinary foreground/u,
    );
    blocked = false;
    await first.command("configure 0.01 Check progress");
    await first.command("start");
    first.input("\x1b[97;5u");
    assert.equal(store.get(session.getSessionId())?.state, "paused");
    await delay(35);
    assert.equal(requests, 0);
    await first.command("status");
    await first.command("resume inspected");
    const second = await fixture();
    await assert.rejects(second.command("start"), /owned by live process/u);
    admission.fenced = () => true;
    await delay(35);
    assert.equal(requests, 0);
    assert.equal(store.get(session.getSessionId())?.state, "paused");
    admission.fenced = () => false;
    await first.command("status");
    await first.command("resume inspected");
    admission.pending++;
    await delay(35);
    assert.equal(requests, 0);
    admission.pending--;
    await first.command("status");
    await first.command("resume inspected");
    await delay(35);
    assert.equal(requests, 1);
    const intent = store.get(session.getSessionId())?.intent;
    assert.ok(intent !== undefined && intent !== null);
    await first.runner.emit({ type: "session_shutdown", reason: "reload" });
    const third = await fixture();
    await third.runner.emit({ type: "session_start", reason: "reload" });
    assert.deepEqual(store.get(session.getSessionId())?.intent, intent);
    assert.equal(store.get(session.getSessionId())?.state, "paused");
    const countBeforeManual = store.get(session.getSessionId())?.count;
    await third.runner.emitInput(
      "Manual recovery inspection",
      undefined,
      "interactive",
    );
    await third.runner.emitBeforeAgentStart(
      { messageType: "user", prompt: "Manual recovery inspection" },
      { cwd: directory },
    );
    await third.runner.emit({ type: "agent_settled", aborted: false });
    assert.deepEqual(store.get(session.getSessionId())?.intent, intent);
    assert.equal(store.get(session.getSessionId())?.count, countBeforeManual);
    assert.equal(
      store.iterations(session.getSessionId())[0]?.state,
      "uncertain",
    );
    assert.equal(
      store.iterations(session.getSessionId())[0]?.acknowledgedAt,
      undefined,
    );
    await delay(35);
    assert.equal(requests, 1);
    await assert.rejects(third.command("start"), /Inspect/u);
    await assert.rejects(
      third.command("resume inspected"),
      /Read \/loop status/u,
    );
    await third.command("status");
    await third.command("resume inspected");
    await delay(35);
    assert.equal(requests, 2);
    assert.deepEqual(
      store.iterations(session.getSessionId()).map((row) => row.state),
      ["uncertain", "pending"],
    );
    assert.ok(
      store.iterations(session.getSessionId())[0]?.acknowledgedAt !== undefined,
    );
    assert.notEqual(store.get(session.getSessionId())?.intent?.id, intent.id);
    await third.runner.emitInput("Check progress", undefined, "extension");
    await third.runner.emitBeforeAgentStart(
      { messageType: "user", prompt: "Check progress" },
      { cwd: directory },
    );
    await third.command("stop");
    await third.runner.emit({ type: "agent_settled", aborted: false });
    assert.equal(store.get(session.getSessionId())?.state, "stopped");
    assert.equal(store.get(session.getSessionId())?.count, 1);
  } finally {
    admission.fenced = originalFence;
    for (const runner of runners)
      await runner.emit({ type: "session_shutdown", reason: "quit" });
    store?.close();
    if (previous === undefined) delete process.env["STUDIO_STATE_DIR"];
    else process.env["STUDIO_STATE_DIR"] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
