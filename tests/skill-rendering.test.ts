import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createReadTool,
  SessionManager,
  SettingsManager,
  initTheme,
  ToolExecutionComponent,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, visibleWidth, ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { claudeTools } from "../model-tools/dialects/claude.ts";
import { modelToolRenderers } from "../model-tools/rendering.ts";
import { registerSkillRendering } from "../skill-renderer.ts";

const document =
  "# Skill heading\n\n- first item\n- **second item**\n\n[Documentation](https://example.com/skill)\n\n```ts\nconst answer = 42;\n```\n";
type Resolver = Parameters<ExtensionAPI["registerToolRenderer"]>[0];

await test("skill read middleware composes without changing other tools or call renderers", () => {
  let resolver: Resolver | undefined;
  registerSkillRendering({
    registerToolRenderer(value: Resolver) {
      resolver = value;
    },
  });
  assert.ok(resolver !== undefined);
  const base = {
    renderCall: () => new Text("native call", 0, 0),
    renderResult: () => new Text("downstream result", 0, 0),
  };
  let nextCalls = 0;
  const result = resolver("read", () => {
    nextCalls++;
    return base;
  });
  assert.equal(nextCalls, 1);
  assert.equal(result?.renderCall, base.renderCall);
  for (const name of ["skill", "bash", "grep", "write"])
    assert.equal(
      resolver(name, () => base),
      base,
    );
  assert.equal(
    resolver("read", () => undefined),
    undefined,
  );
  const callOnly = { renderCall: () => new Text("original header", 0, 0) };
  assert.equal(
    resolver("read", () => callOnly),
    callOnly,
  );
});

await test("registered renderer formats actual builtin skill reads and retains native fallbacks and bytes", async (t) => {
  initTheme("dark", false);
  const cwd = await mkdtemp(join(tmpdir(), "studio-skill-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "example"));
  await writeFile(join(cwd, "example/SKILL.md"), document);
  const created = await createAgentSessionFromServices({
    services: await createAgentSessionServices({
      cwd,
      agentDir: cwd,
      settingsManager: SettingsManager.inMemory({}),
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [registerSkillRendering],
      },
    }),
    sessionManager: SessionManager.inMemory(cwd),
    tools: ["read"],
  });
  try {
    const session = created.session;
    await session.bindExtensions({ mode: "rpc" });
    const native = session.getToolDefinition("read");
    assert.ok(native !== undefined);
    const rendered = session.extensionRunner.resolveToolRenderers("read", () => native);
    assert.ok(rendered !== undefined);
    const rawResult = await createReadTool(cwd).execute("fixture", {
      path: "example/SKILL.md",
    });
    assert.deepEqual(rawResult.content, [{ type: "text", text: document }]);
    const outcome = { result: rawResult, isError: false };
    const result = { ...rawResult, isError: false };
    const before = JSON.stringify(outcome.result);
    const ui = new TuiMainScreen(new ProcessTerminal());
    const component = (args: object, renderers = rendered) =>
      new ToolExecutionComponent("read", "fixture", args, { showImages: false }, renderers, ui, cwd);
    for (const args of [{ path: "example/SKILL.md" }, { file_path: "example/SKILL.md" }]) {
      const actual = component(args);
      const original = component(args, native);
      actual.updateResult(result);
      original.updateResult(result);
      assert.deepEqual(actual.render(100), original.render(100));
      assert.match(stripTerminalSequences(actual.render(100).join("\n")), /\[skill\] example/u);
      actual.setExpanded(true);
      original.setExpanded(true);
      assert.match(stripTerminalSequences(original.render(100).join("\n")), /# Skill heading/u);
      for (const width of [100, 60, 40, 100]) {
        const rows = actual.render(width);
        const plain = stripTerminalSequences(rows.join("\n"));
        assert.match(plain, /Skill heading/u);
        assert.match(plain, /first item/u);
        assert.match(plain, /Documentation/u);
        assert.match(plain, /const answer = 42/u);
        assert.doesNotMatch(plain, /# Skill heading|\*\*second item\*\*/u);
        assert.ok(rows.every((row) => visibleWidth(row) <= width));
      }
      actual.setExpanded(false);
      original.setExpanded(false);
      assert.deepEqual(actual.render(60), original.render(60));
    }
    for (const args of [
      { path: "ordinary.md" },
      { path: "SKILL.md.bak" },
      { path: "example/skill.md" },
      { path: "example/SKILL.md", offset: 2 },
      { path: "example/SKILL.md", limit: 2 },
    ]) {
      const actual = component(args);
      const original = component(args, native);
      actual.updateResult(result);
      original.updateResult(result);
      actual.setExpanded(true);
      original.setExpanded(true);
      assert.deepEqual(actual.render(60), original.render(60));
    }
    const actual = component({ path: "example/SKILL.md" });
    const original = component({ path: "example/SKILL.md" }, native);
    actual.setExpanded(true);
    original.setExpanded(true);
    const fallbackResults = [
      { ...result, isError: true },
      {
        ...result,
        details: {
          truncation: {
            truncated: true,
            truncatedBy: "lines",
            outputLines: 4,
            totalLines: 12,
          },
        },
      },
      { ...result, details: { imageUnsupportedByModel: "fixture" } },
      { ...result, details: { unknownMetadata: true } },
      {
        ...result,
        content: [{ type: "text" as const, text: "\x1b[31mraw" }],
      },
      { ...result, content: [{ type: "text" as const, text: "" }] },
      { ...result, content: [] },
      {
        ...result,
        content: [...outcome.result.content, ...outcome.result.content],
      },
      {
        ...result,
        content: [{ type: "image" as const, mimeType: "image/png", data: "" }],
      },
    ];
    for (const fallback of fallbackResults) {
      actual.updateResult(result);
      actual.render(60); // Transition from our Markdown to native Text.
      actual.updateResult(fallback);
      original.updateResult(fallback);
      assert.deepEqual(actual.render(60), original.render(60));
    }
    actual.updateResult(result, true);
    original.updateResult(result, true);
    assert.deepEqual(actual.render(60), original.render(60));
    assert.equal(JSON.stringify(outcome.result), before);
  } finally {
    created.session.dispose();
  }
});

await test("Claude's numbered Read renders the same expanded skill Markdown as a Pi read", () => {
  initTheme("dark", false);
  let canonical: Resolver | undefined;
  const host = {
    registerToolRenderer(renderer: Resolver) {
      canonical = renderer;
    },
  };
  registerSkillRendering(host);
  assert.ok(canonical !== undefined);
  const ui = new TuiMainScreen(new ProcessTerminal());
  const binding = claudeTools.find(({ operation }) => operation === "read");
  assert.ok(binding !== undefined);
  const read = new ToolExecutionComponent(
    "Read",
    "skill",
    { file_path: "example/SKILL.md" },
    { showImages: false },
    modelToolRenderers(host, binding),
    ui,
    process.cwd(),
  );
  const numbered = document
    .split("\n")
    .map((line, i, lines) => (i === lines.length - 1 ? line : `${String(i + 1)}\t${line}`))
    .join("\n");
  read.updateResult({
    content: [{ type: "text", text: numbered }],
    details: undefined,
    isError: false,
  });
  read.setExpanded(true);
  const plain = stripTerminalSequences(read.render(80).join("\n"));
  assert.match(plain, /Skill heading/u);
  assert.match(plain, /second item/u);
  assert.doesNotMatch(plain, /# Skill heading|\*\*second item\*\*|1\t/u);
});
