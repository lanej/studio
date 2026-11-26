import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { z } from "zod";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
  ProjectTrustStore,
  initTheme,
  keyText,
  keyHint,
} from "@earendil-works/pi-coding-agent";
import { registerCodeIntelligence, lspTool, renameTool } from "../code-intelligence/extension.ts";

initTheme("dark", false);
const root = await realpath(await mkdtemp(join(tmpdir(), "pi-lsp-native-")));
const previousConfigHome = process.env["XDG_CONFIG_HOME"];
process.env["XDG_CONFIG_HOME"] = join(root, "config");
await mkdir(join(root, "config/studio"), { recursive: true });
await writeFile(
  join(root, "config/studio/config.toml"),
  '[display]\nmin_split_columns = 50\nadded_background = "#304639"\nremoved_background = "#47343f"\n',
);
const agentDir = join(root, "agent");
await mkdir(agentDir);
const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
process.env["PI_CODING_AGENT_DIR"] = agentDir;
new ProjectTrustStore(agentDir).set(root, true);
await mkdir(join(root, "node_modules"));
await symlink(
  fileURLToPath(new URL("../node_modules/typescript", import.meta.url)),
  join(root, "node_modules/typescript"),
);
await writeFile(
  join(root, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
    files: ["a.ts", "b.ts"],
  }),
);
await writeFile(join(root, "a.ts"), "export function greet(name: string): string { return name; }\n");
const valid = 'import { greet } from "./a";\nexport const answer: string = greet("hello");\n';
await writeFile(join(root, "b.ts"), valid);
let blockWrites = false;
const services = await createAgentSessionServices({
  cwd: root,
  agentDir,
  settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
  resourceLoaderOptions: {
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      (pi) => {
        registerCodeIntelligence(pi);
        pi.on("tool_call", (event) => {
          if (
            blockWrites &&
            event.toolName === "write" &&
            typeof event.input["path"] === "string" &&
            event.input["path"].endsWith("b.ts")
          )
            return { block: true, reason: "Fixture approval revoked" };
          return undefined;
        });
      },
    ],
  },
});
const { session } = await createAgentSessionFromServices({
  services,
  sessionManager: SessionManager.inMemory(root),
});
await session.bindExtensions({ mode: "rpc" });
session.sessionManager.appendMessage({
  role: "assistant",
  content: [{ type: "toolCall", id: "acceptance", name: "acceptance", arguments: {} }],
  api: "openai-completions",
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
session.refreshContext();
const tool = session.extensionRunner.createToolContext("acceptance", undefined);
let lastOutcome: Awaited<ReturnType<typeof tool.executeTool>> | undefined;
const call = async (name: string, args: unknown) => {
  const outcome = await tool.executeTool(name, args);
  lastOutcome = outcome;
  assert.equal(outcome.isError, false, JSON.stringify(outcome.result));
  return outcome.result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
};

async function eventually(operation: () => Promise<string>, expected: RegExp): Promise<void> {
  const deadline = Date.now() + 30_000;
  let observed = "";
  do {
    observed = await operation();
    if (expected.test(observed)) return;
    await delay(100);
  } while (Date.now() < deadline);
  assert.match(observed, expected, "Language-server result did not settle before the acceptance deadline");
}

try {
  // Initialization can precede project indexing; assert the semantic result when it settles.
  await eventually(
    () =>
      call(lspTool, {
        action: "definition",
        path: "b.ts",
        line: 2,
        column: 31,
      }),
    /a\.ts/u,
  );
  const references = await call(lspTool, {
    action: "references",
    path: "a.ts",
    line: 1,
    column: 18,
  });
  assert.match(references, /b\.ts/u);
  const editArgs = {
    path: "b.ts",
    reason: "Check the inferred type of the greeting.",
    edits: [{ oldText: "answer: string", newText: "answer: number" }],
  };
  const introduced = await call("edit", editArgs);
  // The real tool renderer must show diagnostics without a model-issued diagnostics query.
  assert.match(introduced, /lsp/u);
  assert.ok(lastOutcome !== undefined);
  const written = lastOutcome;
  const native = session.getToolDefinition("edit");
  const rendered = session.extensionRunner.resolveToolRenderers("edit", () => native);
  assert.ok(rendered?.renderResult !== undefined);
  const renderOptions = { expanded: false, isPartial: false };
  const renderContext = {
    keyText,
    keyHint,
    ...renderOptions,
    args: editArgs,
    toolCallId: written.toolCall.id,
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: root,
    executionStarted: true,
    argsComplete: true,
    showImages: false,
    isError: false,
    durationMs: 0,
    outputPad: 0,
  };
  assert.ok(rendered.renderCall !== undefined);
  const theme = session.extensionRunner.getUIContext().theme;
  const callComponent = rendered.renderCall(renderContext.args, theme, renderContext);
  const component = rendered.renderResult(written.result, renderOptions, theme, renderContext);
  await eventually(() => Promise.resolve(callComponent.render(100).join("\n")), /Type 'string' is not assignable/u);
  assert.doesNotMatch(component.render(100).join("\n"), /"lsp"|"diagnostics"/u);
  assert.doesNotMatch(component.render(60).join("\n"), /not assignable/u);
  assert.match(callComponent.render(100).join("\n"), /answer.*number/u);
  for (const width of [100, 120]) {
    const rows = callComponent.render(width);
    assert.ok(rows.some((row) => row.includes("×") && row.includes("not assignable")));
    assert.ok(rows.some((row) => row.includes("\x1b[4:3m")));
  }
  // The type diagnostic needs the updated source line for its range and inlay.
  const splitText = stripTerminalSequences(callComponent.render(120).join("\n"));
  assert.doesNotMatch(splitText, /Original.*Updated/u);
  assert.match(splitText, /answer: string.*│.*answer: number/u);
  assert.doesNotMatch(callComponent.render(100).join("\n"), /Original.*Updated| │ /u);
  for (const width of [100, 120]) {
    const output = callComponent.render(width).join("\n");
    assert.ok(output.includes("\x1b[48;2;48;70;57m"));
    assert.ok(output.includes("\x1b[48;2;71;52;63m"));
  }
  const policySource = [
    "export class Policy {",
    "  retryDelay(attempt: number, baseMs: number): number {",
    "    if (attempt < 0) {",
    "      return baseMs;",
    "    }",
    "    const capMs = 1500;",
    "    const exponent = Math.min(attempt, 8);",
    "    const factor = 2;",
    "    return Math.min(capMs, baseMs * factor ** exponent);",
    "  }",
    "}",
  ].join("\n");
  await writeFile(join(root, "policy.ts"), policySource);
  const policyArgs = {
    path: "policy.ts",
    reason: "Increase the retry delay for later attempts.",
    edits: [{ oldText: "factor = 2", newText: "factor = 4" }],
  };
  const policy = await tool.executeTool("edit", policyArgs);
  assert.equal(policy.isError, false);
  const policyContext = {
    ...renderContext,
    args: policyArgs,
    toolCallId: policy.toolCall.id,
    state: {},
  };
  const policyCall = rendered.renderCall(policyArgs, theme, policyContext);
  rendered.renderResult(policy.result, renderOptions, theme, policyContext);
  const nativeDiff = z.object({ diff: z.string() }).parse(policy.result.details).diff;
  assert.doesNotMatch(nativeDiff, /retryDelay/u);
  for (const width of [72, 120]) {
    const policyText = stripTerminalSequences(policyCall.render(width).join("\n"));
    assert.match(policyText, /retryDelay\(attempt: number, baseMs: number\)/u);
    assert.equal(policyText.match(/retryDelay/gu)?.length, 1);
    assert.equal(policyText.split(policyArgs.reason).length, 2);
    assert.ok(policyText.indexOf(policyArgs.reason) < policyText.indexOf("retryDelay"));
    assert.match(policyText, /factor = 2 → 4/u);
    assert.doesNotMatch(policyText, /Original|Updated| │ /u);
  }
  await eventually(() => call(lspTool, { action: "diagnostics", path: "b.ts" }), /2322/u);
  await call("write", { path: "b.ts", content: valid });
  await eventually(() => call(lspTool, { action: "diagnostics", path: "b.ts" }), /"total": 0/u);
  const preview = z
    .object({
      token: z.string(),
      files: z.array(z.object({ path: z.string() })),
    })
    .parse(
      JSON.parse(
        await call(renameTool, {
          action: "preview",
          path: "a.ts",
          line: 1,
          column: 18,
          newName: "welcome",
        }),
      ),
    );
  assert.equal(preview.files.length, 2);
  await writeFile(join(root, "b.ts"), `${valid}// operator edit\n`);
  const stale = await tool.executeTool(renameTool, {
    action: "apply",
    token: preview.token,
  });
  assert.equal(stale.isError, true);
  assert.match(JSON.stringify(stale.result), /stale/u);
  assert.match(await readFile(join(root, "a.ts"), "utf8"), /function greet/u);
  await call("write", { path: "b.ts", content: valid });
  const blockedPreview = z.object({ token: z.string() }).parse(
    JSON.parse(
      await call(renameTool, {
        action: "preview",
        path: "a.ts",
        line: 1,
        column: 18,
        newName: "welcome",
      }),
    ),
  );
  blockWrites = true;
  const blocked = await tool.executeTool(renameTool, {
    action: "apply",
    token: blockedPreview.token,
  });
  assert.equal(blocked.isError, true, "nested rename writes must honor Pi's tool hooks");
  assert.match(JSON.stringify(blocked.result), /Fixture approval revoked/u);
  assert.match(await readFile(join(root, "b.ts"), "utf8"), /greet/u);
  assert.ok(
    session.sessionManager
      .getBranch()
      .some((entry) => entry.type === "custom" && entry.customType === "studio:rename-recovery"),
  );
  blockWrites = false;
  await call("write", {
    path: "a.ts",
    content: "export function greet(name: string): string { return name; }\n",
  });
  const finalPreview = z.object({ token: z.string() }).parse(
    JSON.parse(
      await call(renameTool, {
        action: "preview",
        path: "a.ts",
        line: 1,
        column: 18,
        newName: "welcome",
      }),
    ),
  );
  await call(renameTool, { action: "apply", token: finalPreview.token });
  assert.match(await readFile(join(root, "a.ts"), "utf8"), /function welcome/u);
  assert.match(await readFile(join(root, "b.ts"), "utf8"), /welcome\("hello"\)/u);
  await promisify(execFile)(
    process.execPath,
    [
      fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)),
      "--project",
      join(root, "tsconfig.json"),
    ],
    { timeout: 15_000 },
  );
  session.sessionManager.appendCustomMessageEntry("studio:diagnostics", "Late diagnostic", false, {
    toolCallId: written.toolCall.id,
    snapshot: {
      path: join(root, "b.ts"),
      state: "received",
      version: 99,
      freshness: "versioned",
      total: 1,
      diagnostics: [
        {
          line: 2,
          column: 1,
          severity: "error",
          message: "Retained late diagnostic",
          source: "ts",
          code: 2322,
        },
      ],
    },
  });
  await writeFile(
    join(root, "config/studio/config.toml"),
    "[display]\ninline_diagnostics = false\n[lsp]\nenabled = false\n",
  );
  await session.extensionRunner.emit({
    type: "session_start",
    reason: "reload",
  });
  const restored = rendered.renderResult(
    written.result,
    { expanded: false, isPartial: false },
    session.extensionRunner.getUIContext().theme,
    renderContext,
  );
  assert.match(restored.render(100).join("\n"), /Retained late diagnostic/u);
  assert.doesNotMatch(callComponent.render(100).join("\n"), /×|Retained late diagnostic/u);
  // Sessions saved before Tree-sitter keep their original LSP labels.
  const legacyContext = {
    ...policyContext,
    toolCallId: "historical-policy",
    state: {},
  };
  const historicalLabel = "HistoricPolicy › retryDelay(attempt, baseMs)";
  const legacyCall = rendered.renderCall(policyArgs, theme, legacyContext);
  rendered.renderResult(
    {
      ...policy.result,
      details: {
        diff: nativeDiff,
        studioDiffScopes: [{ row: 1, label: historicalLabel }],
      },
    },
    renderOptions,
    theme,
    legacyContext,
  );
  assert.match(stripTerminalSequences(legacyCall.render(120).join("\n")), /HistoricPolicy › retryDelay/u);

  // An edit uses Tree-sitter with LSP disabled, preserves the native BOM/CRLF, and
  // replays after the source file has been removed. A number inside a comment stays split.
  const pythonPath = join(root, "retry.py");
  const pythonSource = [
    "class Policy:",
    "    def retry_delay(self, attempt: int) -> int:",
    "        if attempt < 0:",
    "            return 0",
    "        if attempt > 8:",
    "            return 1500",
    "        base = 100",
    "        # retry factor: 2",
    "        factor = 2",
    "        return base * factor ** attempt",
    "",
  ].join("\r\n");
  await writeFile(pythonPath, `\uFEFF${pythonSource}`);
  for (const oldText of ["factor = 2", "# retry factor: 2"]) {
    const args = {
      path: "retry.py",
      reason: "Increase the retry factor.",
      edits: [{ oldText, newText: oldText.replace("2", "4") }],
    };
    const outcome = await tool.executeTool("edit", args);
    assert.equal(outcome.isError, false);
    const syntax = z
      .object({
        studioDiagnostics: z.undefined().optional(),
        studioSyntax: z.object({
          replacements: z.array(z.unknown()),
          scopes: z.array(z.unknown()),
        }),
      })
      .parse(outcome.result.details).studioSyntax;
    const isCode = oldText === "factor = 2";
    assert.equal(syntax.replacements.length, isCode ? 1 : 0);
    assert.ok(syntax.scopes.length > 0);
    if (!isCode) {
      assert.equal(
        await readFile(pythonPath, "utf8"),
        `\uFEFF${pythonSource.replace("factor = 2", "factor = 4").replace("# retry factor: 2", "# retry factor: 4")}`,
      );
      await rm(pythonPath);
    }
    const context = {
      ...renderContext,
      args,
      toolCallId: outcome.toolCall.id,
      state: {},
    };
    const call = rendered.renderCall(args, theme, context);
    rendered.renderResult(outcome.result, renderOptions, theme, context);
    const text = stripTerminalSequences(call.render(120).join("\n"));
    assert.match(text, /retry_delay\(self, attempt: int\)/u);
    if (isCode) assert.match(text, /factor = 2 → 4/u);
    else {
      assert.match(text, /# retry factor: 2.*│.*# retry factor: 4/u);
      assert.doesNotMatch(text, /→/u);
    }
  }
  console.log(
    "Native Pi: Tree-sitter with LSP disabled, edit diagnostics, semantic navigation, rename and compiler verification passed.",
  );
} finally {
  await session.extensionRunner.emit({
    type: "session_shutdown",
    reason: "quit",
  });
  session.dispose();
  if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
  else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
  if (previousConfigHome === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = previousConfigHome;
  await rm(root, { recursive: true, force: true });
}
