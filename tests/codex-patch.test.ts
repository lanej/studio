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
    const add = `*** Begin Patch\n*** Add File: large.txt\n*** Reason: Preserve the original input.\n+${literal}\n*** Delete File: obsolete.txt\n*** Reason: Remove the obsolete copy.\n*** End Patch`;
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
      "*** Begin Patch\n*** Delete File: large.txt\n*** Reason: Remove the duplicate.\n*** Update File: missing.txt\n*** Reason: Refresh the example.\n@@\n-old\n+new\n*** End Patch",
    );
    assert.equal(invalid.isError, true);
    assert.match(JSON.stringify(invalid.content), /missing\.txt/u);
    assert.equal(await readFile(added, "utf8"), `${literal}\n`);

    const last = await apply(
      `*** Begin Patch\n*** Update File: large.txt\n*** Reason: Publish the final text.\n*** Move to: moved.txt\n@@\n-${literal}\n+complete\n*** End Patch`,
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

await test("dialect tools keep their invoked names in conversation headings", async (t) => {
  const { component } = await conversationFixture(t);
  const path = "README.md";
  const command = "pwd";
  const cases = [
    { name: "Read", args: { file_path: path }, subject: path },
    {
      name: "Write",
      args: { file_path: path, content: "sample" },
      subject: path,
    },
    { name: "Bash", args: { command }, subject: command },
    { name: "shell_command", args: { command }, subject: command },
  ];
  for (const { name, args, subject } of cases) {
    const call = component(name, args);
    call.setArgsComplete();
    const heading = plain(call, 80).trimStart();
    assert.ok(heading.startsWith(name), heading);
    assert.ok(heading.includes(subject), heading);
  }
});

// Compare the colored rows so this also covers syntax/token colors and gutter alignment.
function codeRows(component: ToolExecutionComponent, width: number) {
  return component
    .render(width)
    .filter((row) =>
      /computeRate|value \+=|return value/u.test(stripTerminalSequences(row)),
    );
}

function assertPatchTitle(view: string) {
  assert.match(view.trimStart(), /^apply_patch\b/u);
  assert.equal(view.match(/\bapply_patch\b/gu)?.length, 1);
  assert.doesNotMatch(view, /^\s*(?:edit|Edit)\s/mu);
}

await test(
  "apply_patch and Edit show the invoked name above the same contextual diff",
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
    const replacement = {
      file_path: path,
      old_string: before,
      new_string: after,
      reason: "Apply the new rate.",
    };
    const claude = component("Edit", replacement);
    const edit = await replaceText(ctx, {
      path,
      oldText: before,
      newText: after,
      replaceAll: false,
      reason: replacement.reason,
    });
    assert.equal(edit.isError, false);
    claude.setArgsComplete();
    claude.updateResult(edit);
    assert.equal(await readFile(file, "utf8"), original.replace(before, after));
    await writeFile(file, original);
    const patch = [
      "*** Begin Patch",
      `*** Update File: ${path}`,
      `*** Reason: ${replacement.reason}`,
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
    assertPatchTitle(preview);
    assert.match(preview, /rates\.ts/u);
    assert.doesNotMatch(preview, /\*\*\* (?:Begin Patch|Update File)|25 → 50/u);
    codex.updateArgs({ patch });
    assert.match(plain(codex, 62), /rates\.ts[^\n]+Apply the new rate\./u);
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
        assertPatchTitle(view);
        assert.match(view, /rates\.ts[^\n]+Apply the new rate\./u);
        assert.match(canonical.trimStart(), /^Edit\s+rates\.ts/u);
        assert.match(canonical, /rates\.ts[^\n]+Apply the new rate\./u);
        assert.match(canonical, /╭ function computeRate/u);
        assert.match(canonical, /~\s*9 .*25 → 50/u);
        assert.match(canonical, /10 +return value/u);
        assert.deepEqual(codeRows(codex, width), codeRows(claude, width));
        assert.ok(
          codex.render(width).every((row) => visibleWidth(row) <= width),
        );
        assert.doesNotMatch(
          view,
          /\*\*\* (?:Begin Patch|Update File|End Patch)/u,
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
    const editDetails: unknown = edit.details;
    assert.ok(typeof editDetails === "object" && editDetails !== null);
    const annotatedEdit = component("Edit", replacement);
    annotatedEdit.setArgsComplete();
    annotatedEdit.updateResult({
      ...edit,
      content: [...edit.content, { type: "text", text: annotation }],
      details: {
        ...editDetails,
        studioDiagnostics: {
          snapshot: issue,
          contentIndex: edit.content.length,
        },
      },
    });
    for (const width of [62, 132]) {
      assert.deepEqual(
        codeRows(diagnostic, width),
        codeRows(annotatedEdit, width),
      );
    }
    assert.match(plain(diagnostic, 132), /-\s*9 .*25;.*│.*\+\s*9 .*50;/u);
    assert.doesNotMatch(plain(diagnostic, 62), /│/u);
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
      "*** Reason: Enable the active flag.",
      "+export const active = true;",
      "*** Delete File: archived.ts",
      "*** Reason: Retire the archived flag.",
      "*** End Patch",
    ].join("\n");
    await writeFile(
      join(cwd, "archived.ts"),
      "export const archived = false;\n",
    );
    const multi = component("apply_patch", { patch: multiFile });
    assert.match(
      plain(multi, 100),
      /\+\s+active\.ts[^\n]+Enable the active flag\./u,
    );
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
    assertPatchTitle(applied);
    assert.match(
      applied,
      /2 files *\n *\n *\+ active\.ts[^\n]+Enable the active flag\./u,
    );
    assert.match(applied, /export const active = true; *\n *\n *archived\.ts/u);
    assert.match(applied, /^ *archived\.ts[^\n]+Retire the archived flag\./mu);
    assert.match(applied, /^ +1 +export const active = true/mu);
    assert.doesNotMatch(applied, /Added file|\+\s*1 +export const active/u);
    assert.match(applied, /export const archived = false/u);
    assert.doesNotMatch(applied, /\*\*\* (?:Add File|Delete File|End Patch)/u);

    const legacy = component("apply_patch", {
      patch: multiFile.replaceAll(/^\*\*\* Reason: .*\n/gmu, ""),
    });
    legacy.setArgsComplete();
    legacy.updateResult({ ...multiple, details: undefined });
    const replay = plain(legacy, 100);
    assertPatchTitle(replay);
    assert.match(replay, /\+\s+active\.ts/u);
    assert.doesNotMatch(replay, /Enable the active flag|\*\*\* Reason/u);

    // Replay the request after the deletion. Its failed preflight must stay visible.
    const failed = await applyPatch(ctx, multiFile);
    assert.equal(failed.isError, true);
    const error = component("apply_patch", { patch: multiFile });
    error.setArgsComplete();
    error.updateResult(failed);
    const failure = plain(error, 100);
    assertPatchTitle(failure);
    assert.match(failure, /archived\.ts[^\n]+Retire the archived flag\./u);
    assert.match(failure, /Cannot delete missing file 'archived\.ts'/u);
    assert.doesNotMatch(
      failure,
      /Success\. Updated|export const archived = false/u,
    );
  },
);

await test(
  "the creation glyph follows the committed change, including edits without a preview",
  processDeadline,
  async (t) => {
    const { cwd, ctx, component } = await conversationFixture(t);
    await writeFile(join(cwd, "existing.txt"), "retained\n");
    const patch = [
      "*** Begin Patch",
      "*** Add File: generated.txt",
      "*** Reason: Store the generated sample.",
      `+${"x".repeat(70_000)}`,
      "*** Add File: existing.txt",
      "*** Reason: Include the missing example.",
      "+retained",
      "+example",
      "*** End Patch",
    ].join("\n");
    const output = await applyPatch(ctx, patch);
    assert.equal(output.isError, false, JSON.stringify(output.content));
    const card = component("apply_patch", { patch });
    card.setArgsComplete();
    card.updateResult(output);
    const view = plain(card, 100);
    assert.match(view, /^ +existing\.txt[^\n]+Include the missing example\./mu);
    assert.doesNotMatch(view, /\+\s+existing\.txt/u);
    assert.match(view, /\+\s*2 +example/u);
    assert.match(
      view,
      /^ +\+ generated\.txt[^\n]+Store the generated sample\./mu,
    );
    assert.match(view, /2 files *\n *\n *\+ generated\.txt/u);
    assert.match(view, /Diff unavailable *\n *\n *existing\.txt/u);
    assert.doesNotMatch(view, /Added file/u);
  },
);
