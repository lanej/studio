import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyPatch } from "../model-tools/operations.ts";

await test("Codex patches use the session Bash hooks, preserve literal input, and report failed hunks", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "studio-codex-'"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const added = join(cwd, "large.txt");
  const moved = join(cwd, "moved.txt");
  const deleted = join(cwd, "obsolete.txt");
  await writeFile(deleted, "old\n");
  await writeFile(
    join(cwd, "bunfig.toml"),
    'preload = ["./fixture-preload.mjs"]',
  );
  await writeFile(
    join(cwd, "fixture-preload.mjs"),
    'throw new Error("unexpected checkout preload")',
  );
  let blocked = true;
  const services = await createAgentSessionServices({
    cwd,
    agentDir: cwd,
    settingsManager: SettingsManager.inMemory({}),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        (pi) => {
          pi.on("tool_call", (event) => {
            if (blocked && event.toolName === "bash")
              return { block: true, reason: "Bash is blocked in this session" };
            return undefined;
          });
        },
      ],
    },
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(cwd),
    tools: ["bash"],
  });
  t.after(() => {
    session.dispose();
  });
  await session.bindExtensions({ mode: "rpc" });
  session.agent.state.messages.push({
    role: "assistant",
    content: [
      { type: "toolCall", id: "codex", name: "apply_patch", arguments: {} },
    ],
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    stopReason: "toolUse",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const ctx = session.extensionRunner.createToolContext("codex", undefined);
  const apply = (patch: string) => applyPatch(ctx, patch);
  const literal = [`'\`$(exit 17)' `, "x".repeat(160_000)].join("");
  const add = `*** Begin Patch\n*** Add File: large.txt\n+${literal}\n*** Delete File: obsolete.txt\n*** End Patch`;
  const denied = await apply(add);
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied.content), /Bash is blocked/u);
  await assert.rejects(readFile(added), { code: "ENOENT" });
  assert.equal(await readFile(deleted, "utf8"), "old\n");

  blocked = false;
  const first = await apply(add);
  assert.equal(first.isError, false, JSON.stringify(first.content));
  assert.equal(await readFile(added, "utf8"), `${literal}\n`);
  await assert.rejects(readFile(deleted), { code: "ENOENT" });

  const invalid = await apply(
    "*** Begin Patch\n*** Delete File: large.txt\n*** Update File: missing.txt\n@@\n-old\n+new\n*** End Patch",
  );
  assert.equal(invalid.isError, true);
  assert.match(JSON.stringify(invalid.content), /missing\.txt/u);
  assert.equal(await readFile(added, "utf8"), `${literal}\n`);

  const last = await apply(
    `*** Begin Patch\n*** Update File: large.txt\n*** Move to: moved.txt\n@@\n-${literal}\n+complete\n*** End Patch`,
  );
  assert.equal(last.isError, false, JSON.stringify(last.content));
  assert.equal(await readFile(moved, "utf8"), "complete\n");
  await assert.rejects(readFile(added), { code: "ENOENT" });
});
