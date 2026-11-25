import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  initTheme,
  ToolExecutionComponent,
  type ExtensionAPI,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  ProcessTerminal,
  stripTerminalSequences,
  TuiMainScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { registerCodeIntelligence } from "../code-intelligence/extension.ts";
import { registerModelTools } from "../model-tools/extension.ts";
import { applyPatch, replaceText } from "../model-tools/operations.ts";

async function patchSession(
  cwd: string,
  t: TestContext,
  tools: string[],
  register: (pi: ExtensionAPI) => void,
) {
  const services = await createAgentSessionServices({
    cwd,
    agentDir: cwd,
    settingsManager: SettingsManager.inMemory({}),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [register],
    },
  });
  const { session } = await createAgentSessionFromServices({
    services,
    tools,
    sessionManager: SessionManager.inMemory(cwd),
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
  return {
    session,
    ctx: session.extensionRunner.createToolContext("codex", undefined),
  };
}

// Each case launches real Pi shell tools and Bun subprocesses.
const processDeadline = { timeout: 30_000 };

await test(
  "Codex patches use the session Bash hooks, preserve literal input, and report failed hunks",
  processDeadline,
  async (t) => {
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
    const { ctx } = await patchSession(cwd, t, ["bash"], (pi) => {
      pi.on("tool_call", (event) => {
        if (blocked && event.toolName === "bash")
          return { block: true, reason: "Bash is blocked in this session" };
        return undefined;
      });
    });
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
  },
);

async function conversationFixture(t: TestContext) {
  initTheme("dark", false);
  const cwd = await mkdtemp(join(tmpdir(), "studio-patch-rendering-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { ctx, session } = await patchSession(
    cwd,
    t,
    ["read", "edit", "write", "bash"],
    (pi) => {
      registerCodeIntelligence(pi);
      registerModelTools(pi);
    },
  );
  const ui = new TuiMainScreen(new ProcessTerminal());
  const component = (name: string, args: object) => {
    const renderers = session.extensionRunner.resolveToolRenderers(name, () =>
      session.extensionRunner.getToolDefinition(name),
    );
    assert.ok(renderers !== undefined, name);
    return new ToolExecutionComponent(
      name,
      randomUUID(),
      args,
      { showImages: false },
      renderers,
      ui,
      cwd,
    );
  };
  return { cwd, ctx, component };
}

function plain(component: ToolExecutionComponent, width: number) {
  return stripTerminalSequences(component.render(width).join("\n"));
}

await test(
  "the conversation shows the same contextual edit for a Codex patch and Claude Edit",
  processDeadline,
  async (t) => {
    const { cwd, ctx, component } = await conversationFixture(t);
    const path = "rates.ts";
    const before = "  value += 25;";
    const after = "  value += 50;";
    const original = [
      "export function computeRate(value: number) {",
      ...Array.from({ length: 7 }, (_, i) => `  value += ${String(i + 1)};`),
      before,
      "  return value;",
      "}",
      "",
    ].join("\n");
    const file = join(cwd, path);
    await writeFile(file, original);
    const claude = component("Edit", {
      file_path: path,
      old_string: before,
      new_string: after,
    });
    const edit = await replaceText(ctx, {
      path,
      oldText: before,
      newText: after,
      replaceAll: false,
      reason: "Update the rate.",
    });
    assert.equal(edit.isError, false);
    claude.setArgsComplete();
    claude.updateResult(edit);
    assert.equal(await readFile(file, "utf8"), original.replace(before, after));
    await writeFile(file, original);
    const patch = [
      "*** Begin Patch",
      `*** Update File: ${path}`,
      "@@",
      `-${before}`,
      `+${after}`,
      "*** End Patch",
    ].join("\n");
    const codex = component("apply_patch", {
      patch: "*** Begin Patch\n*** Update File: rates.ts\n@@",
    });
    codex.setExpanded(true);
    const preview = plain(codex, 62);
    assert.match(preview, /rates\.ts/u);
    assert.doesNotMatch(preview, /\*\*\* (?:Begin Patch|Update File)|25 → 50/u);
    codex.updateArgs({ patch });
    codex.setArgsComplete();
    const patched = await applyPatch(ctx, patch);
    assert.equal(patched.isError, false);
    assert.equal(await readFile(file, "utf8"), original.replace(before, after));
    // Rendering a retained transcript must use the change that ran even after the file disappears.
    await rm(file);
    codex.updateResult(patched);
    for (const expanded of [false, true]) {
      claude.setExpanded(expanded);
      codex.setExpanded(expanded);
      for (const width of [62, 132]) {
        const view = plain(codex, width);
        const canonical = plain(claude, width);
        const sourceRows = (text: string) =>
          text
            .split("\n")
            .map((row) => row.trim())
            .filter((line) => /computeRate|value \+=|return value/u.test(line));
        assert.match(canonical, /╭ function computeRate/u);
        assert.match(canonical, /~\s*9 .*25 → 50/u);
        assert.match(canonical, /10 +return value/u);
        assert.deepEqual(sourceRows(view), sourceRows(canonical));
        assert.ok(
          codex.render(width).every((row) => visibleWidth(row) <= width),
        );
        assert.match(view, /edit rates\.ts/u);
        assert.doesNotMatch(
          view,
          /\*\*\* (?:Begin Patch|Update File|End Patch)|apply_patch/u,
        );
      }
    }

    const issue = {
      path: file,
      state: "received",
      diagnostics: [
        {
          line: 9,
          column: 12,
          endLine: 9,
          endColumn: 14,
          severity: "warning",
          message: "Rate exceeds limit",
        },
      ],
    };
    const annotation = JSON.stringify({
      lsp: { files: [issue], omittedFiles: 0 },
    });
    const diagnostic = component("apply_patch", { patch });
    diagnostic.setArgsComplete();
    diagnostic.updateResult({
      ...patched,
      content: [...patched.content, { type: "text", text: annotation }],
      details: {
        ...patched.details,
        studioPatchDiagnostics: {
          files: [issue],
          contentIndex: patched.content.length,
          omittedFiles: 0,
        },
      },
    });
    const annotated = plain(diagnostic, 100);
    assert.equal(annotated.match(/Rate exceeds limit/gu)?.length, 1);
    assert.match(
      annotated,
      /value \+= 50;[\s\S]*Rate exceeds limit[\s\S]*return value/u,
    );
    assert.doesNotMatch(annotated, /"lsp":/u);
  },
);

await test(
  "multi-file patch rendering shows added and deleted source and preserves preflight errors",
  processDeadline,
  async (t) => {
    const { cwd, ctx, component } = await conversationFixture(t);
    const multiFile = [
      "*** Begin Patch",
      "*** Add File: active.ts",
      "+export const active = true;",
      "*** Delete File: archived.ts",
      "*** End Patch",
    ].join("\n");
    await writeFile(
      join(cwd, "archived.ts"),
      "export const archived = false;\n",
    );
    const multi = component("apply_patch", { patch: multiFile });
    multi.setArgsComplete();
    multi.setExpanded(true);
    const multiple = await applyPatch(ctx, multiFile);
    assert.equal(multiple.isError, false);
    assert.doesNotMatch(
      JSON.stringify(multiple.content),
      /export const archived/u,
    );
    multi.updateResult(multiple);
    const applied = plain(multi, 100);
    assert.match(applied, /active\.ts/u);
    assert.match(applied, /archived\.ts/u);
    assert.match(applied, /export const active = true/u);
    assert.match(applied, /export const archived = false/u);
    assert.doesNotMatch(applied, /\*\*\* (?:Add File|Delete File|End Patch)/u);

    // Replay the request after the deletion. Its failed preflight must stay visible.
    const failed = await applyPatch(ctx, multiFile);
    assert.equal(failed.isError, true);
    const error = component("apply_patch", { patch: multiFile });
    error.setArgsComplete();
    error.updateResult(failed);
    const failure = plain(error, 100);
    assert.match(failure, /Cannot delete missing file 'archived\.ts'/u);
    assert.doesNotMatch(
      failure,
      /Success\. Updated|export const archived = false/u,
    );
  },
);
