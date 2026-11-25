import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  initTheme,
  keyText,
  keyHint,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Text,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  highlightSearchOutput,
  registerSearchRendering,
} from "../search-renderer.ts";
import { prepareShellSyntax } from "../shell-syntax.ts";

await test("registered Bash renderer styles compound command positions without changing native layout or output detection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-shell-render-"));
  const services = await createAgentSessionServices({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [registerSearchRendering],
    },
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(directory),
  });
  try {
    await session.bindExtensions({ mode: "rpc" });
    initTheme("dark", false);
    const runner = session.extensionRunner;
    const native = session.getToolDefinition("bash");
    assert.ok(native?.renderCall !== undefined);
    const renderer = runner.resolveToolRenderers("bash", () => native);
    assert.ok(renderer?.renderCall !== undefined);
    const theme = runner.getUIContext().theme;
    const cases: {
      command: string;
      commands: string[];
      flags: string[];
      plainCommands?: string[];
    }[] = [
      {
        command:
          "gh pr checks 15 --repo lanej/studio --watch --fail-fast --interval 10",
        commands: ["gh"],
        flags: ["--repo", "--watch", "--fail-fast", "--interval"],
      },
      {
        command:
          'expected=729c3fa; gh pr checks 15 --repo lanej/studio --watch --fail-fast --interval 15 > /tmp/checks.log 2>&1 && test "$expected" = "$(gh pr view 15 --json headRefOid --jq .headRefOid)"; tail -15 /tmp/checks.log',
        commands: ["gh", "test", "tail"],
        flags: [
          "--repo",
          "--watch",
          "--fail-fast",
          "--interval",
          "--json",
          "--jq",
          "-15",
        ],
      },
      {
        command:
          "gh run list --limit 15 --json databaseId --jq '.[].databaseId' | tail -15 || gh run view --log",
        commands: ["gh", "tail"],
        flags: ["--limit", "--json", "--jq", "-15", "--log"],
      },
      {
        command:
          "VALUE='--assignment' > --redirect gh --repo=lanej/studio; echo 'gh --quoted' \"tail --double\"; cat < gh",
        commands: ["gh", "echo", "cat"],
        flags: ["--repo"],
      },
      {
        command: "echo -- --literal; gh --help",
        commands: ["echo", "gh"],
        flags: ["--help"],
      },
      {
        command: "result=$(gh run list --limit 15); printf '%s' \"$result\"",
        commands: ["gh", "printf"],
        flags: ["--limit"],
      },
      {
        command: "echo 'gh --quoted' > --redirect",
        commands: ["echo"],
        flags: [],
        plainCommands: ["gh"],
      },
      {
        command: "> /tmp/not-command 2>&1 gh --help",
        commands: ["gh"],
        flags: ["--help"],
      },
      {
        command: "printf 'café 界';\n\tgh --help",
        commands: ["printf", "gh"],
        flags: ["--help"],
      },
      {
        command:
          'echo "$(printf \'%s\' "$(gh pr view --json number)")"; tail -15',
        commands: ["echo", "printf", "gh", "tail"],
        flags: ["--json", "-15"],
      },
      {
        command: "if true; then gh --help; else echo done; fi # tail --comment",
        commands: ["gh", "echo"],
        flags: ["--help"],
        plainCommands: ["if", "fi", "tail"],
      },
      {
        command: "cat <<'EOF'\ngh --heredoc\nEOF",
        commands: ["cat"],
        flags: [],
        plainCommands: ["gh"],
      },
      {
        command: "echo `gh --help`",
        commands: ["echo", "gh"],
        flags: ["--help"],
      },
      {
        command: "echo $((subtotal + 2)); gh --help",
        commands: ["echo", "gh"],
        flags: ["--help"],
        plainCommands: ["subtotal"],
      },
    ];
    for (const { command, commands, flags, plainCommands = [] } of cases) {
      const args = { command, timeout: 30 };
      const state: { startedAt?: number } = {};
      const context = {
        keyText,
        keyHint,
        args,
        toolCallId: "fixture",
        invalidate() {},
        lastComponent: undefined,
        state,
        cwd: directory,
        executionStarted: true,
        argsComplete: true,
        isPartial: false,
        expanded: true,
        showImages: false,
        isError: false,
        durationMs: undefined,
        outputPad: 0,
      };
      const original: Component = native.renderCall(args, theme, context);
      const originalRows = original.render(4000).map(stripTerminalSequences);
      const startedAt = state.startedAt;
      assert.equal(typeof startedAt, "number");
      const component: Component = renderer.renderCall(args, theme, {
        ...context,
        lastComponent: original,
      });
      assert.equal(state.startedAt, startedAt);
      assert.equal(
        component,
        original,
        "Preserve Pi's Text component and timer setup",
      );
      assert.ok(component instanceof Text);
      const rendered = component.render(4000).join("\n");
      assert.deepEqual(
        component.render(4000).map(stripTerminalSequences),
        originalRows,
      );
      for (const executable of plainCommands)
        assert.ok(
          !rendered.includes(
            theme.fg("syntaxFunction", theme.bold(executable)),
          ),
          `${executable} must retain generic styling: ${command}`,
        );
      for (const executable of commands)
        assert.ok(
          rendered.includes(theme.fg("syntaxFunction", theme.bold(executable))),
          `${executable}: ${command}`,
        );
      for (const flag of flags)
        assert.ok(
          rendered.includes(theme.fg("syntaxKeyword", flag)),
          `${flag}: ${command}`,
        );
      for (const flag of [
        "--assignment",
        "--redirect",
        "--quoted",
        "--double",
        "--literal",
        "--comment",
        "--heredoc",
      ])
        assert.ok(
          !rendered.includes(theme.fg("syntaxKeyword", flag)),
          `${flag}: ${command}`,
        );
      for (const width of [60, 128])
        assert.ok(
          component.render(width).every((line) => visibleWidth(line) <= width),
        );
    }
    const source = "const value = 1;";
    for (const command of [
      "rg pattern file.ts | cat",
      "sed -n '1p' file.ts; echo done",
    ]) {
      let calls = 0;
      assert.equal(
        highlightSearchOutput("bash", { command }, source, () => {
          calls++;
          return ["decorated"];
        }),
        source,
      );
      assert.equal(
        calls,
        0,
        "Header classification must not broaden output language detection",
      );
    }
  } finally {
    session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("rg discovery highlights the source on match and context rows", async () => {
  await prepareShellSyntax();
  const path = "'/studio releases/lead-plan.ts'";
  const output = [
    "14:export const TaskDelivery = {};",
    '15-  return "Opens a PR";',
    '16-// see parser.py:7: return "fallback";',
    "--",
    "45:const taskDeliverySchema = {};",
    "rg: unrelated diagnostic",
  ].join("\n");
  const marked = [
    "14:[typescript]export const TaskDelivery = {};",
    '15-[typescript]  return "Opens a PR";',
    '16-[typescript]// see parser.py:7: return "fallback";',
    "--",
    "45:[typescript]const taskDeliverySchema = {};",
    "rg: unrelated diagnostic",
  ].join("\n");
  const color = (code: string, language: string) => [`[${language}]${code}`];
  for (const command of [
    `rg -n -A35 'pullRequestMergeSchema|taskDeliverySchema' ${path} | head -70`,
    `rg -n -A8 'enum TaskDelivery|const TaskDelivery|TaskDelivery.*from' ${path}`,
    `rg -n -B 3 needle ${path} | tail -n 5`,
    `rg --line-number --context=3 needle ${path}`,
    "cd 'operator && reviewer' && rg -n -A8 'one|two' 'lead plan.ts' | head -70",
    "rg -n 'needle;alternative' first.ts && rg -n 'one && two' second.ts",
  ])
    assert.equal(
      highlightSearchOutput("bash", { command }, output, color),
      marked,
      command,
    );

  const search = `rg -n -A8 'needle|alternative' ${path}`;
  for (const command of [
    `${search} | head -c 70`,
    `${search} | head -70 other.ts`,
    `${search} | head -70 | wc -l`,
    `${search}; printf '1:synthetic'`,
    `rg -n --replace '1:synthetic' needle ${path}`,
    `rg -n -A8 needle a.ts other.py`,
  ])
    assert.equal(
      highlightSearchOutput("bash", { command }, output, color),
      output,
      command,
    );
});

await test("combined shell searches keep a language only when each output row can be attributed", async () => {
  await prepareShellSyntax();
  const numbered = "14:const value = 1;\n18-return value";
  const prefixed = "first.ts:14:const value = 1;\nsecond.py-18-return value";
  const color = (code: string, language: string) => [`[${language}]${code}`];
  const render = (command: string, text: string) =>
    highlightSearchOutput("bash", { command }, text, color);

  assert.equal(
    render(
      "rg --with-filename -n value first.ts; rg --with-filename -n -A2 value second.py",
      prefixed,
    ),
    "first.ts:14:[typescript]const value = 1;\nsecond.py-18-[python]return value",
  );
  assert.equal(
    render("rg -n value first.ts && rg -n value second.py", numbered),
    numbered,
  );
  assert.equal(
    render(
      "echo 'first.ts:14:const value = 1;'; rg -n --with-filename value second.py",
      prefixed,
    ),
    prefixed,
  );
});
