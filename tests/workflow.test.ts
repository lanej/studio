import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  realpath,
  stat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { taskDetails, taskLabel, taskSchema, taskTree } from "../beads.ts";

import { githubLink, renderReferences } from "../github-links.ts";
import { footerModelLabel } from "../footer.ts";
import { highlightSearchOutput } from "../search-renderer.ts";
import { prepareShellSyntax } from "../shell-syntax.ts";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

await test("task containment stays separate from blockers, including missing parents and cycles", () => {
  const rows = taskTree([
    {
      id: "child",
      title: "Inspect",
      status: "open",
      dependencies: [
        { id: "root", dependency_type: "parent-child" },
        { id: "blocker", dependency_type: "blocks" },
      ],
    },
    { id: "root", title: "Studio", status: "in_progress" },
    { id: "blocker", title: "Scope fence", status: "open" },
    { id: "orphan", title: "Other branch", status: "open", parent: "missing" },
    { id: "cycle-a", title: "Cycle A", status: "open", parent: "cycle-b" },
    { id: "cycle-b", title: "Cycle B", status: "open", parent: "cycle-a" },
  ]);
  assert.deepEqual(
    rows.slice(0, 3).map((row) => [row.task.id, row.depth]),
    [
      ["root", 0],
      ["child", 1],
      ["blocker", 0],
    ],
  );
  assert.equal(rows.length, 6);
  assert.match(rows[3]?.warning ?? "", /outside/);
  assert.match(rows[4]?.warning ?? "", /Cyclic/);
  assert.match(
    taskDetails(
      rows[1]?.task ?? { id: "", title: "", status: "" },
      "/authority",
    ),
    /Blocked by: blocker/,
  );
  assert.doesNotMatch(
    taskLabel({
      task: { id: "bad", title: "escape\x1b[31m\nnewline", status: "open" },
      depth: 0,
    }),
    /\p{Cc}/u,
  );
});

await test("search rendering highlights only identifiable source, preserving prefixes", async () => {
  await prepareShellSyntax();
  const color = (text: string, language: string) => [`[${language}]${text}`];
  assert.equal(
    highlightSearchOutput(
      "bash",
      { command: "sed -n '1,4p' 'src/a file.ts'" },
      "const a = 1;",
      color,
    ),
    "[typescript]const a = 1;",
  );
  const hits = "src/a.ts:9:const a = 1;\nsrc/b.py-8-print(a)\nunknown:2:plain";
  assert.equal(
    highlightSearchOutput("bash", { command: "rg -n needle src" }, hits, color),
    "src/a.ts:9:[typescript]const a = 1;\nsrc/b.py-8-[python]print(a)\nunknown:2:plain",
  );
  assert.equal(
    highlightSearchOutput("grep", {}, hits, color),
    "src/a.ts:9:[typescript]const a = 1;\nsrc/b.py-8-[python]print(a)\nunknown:2:plain",
  );
  assert.equal(
    highlightSearchOutput(
      "bash",
      { command: "rg --json needle src" },
      hits,
      color,
    ),
    hits,
  );
  assert.equal(
    highlightSearchOutput(
      "bash",
      { command: "sed -n '1,4p' a.ts | wc" },
      "4",
      color,
    ),
    "4",
  );
});

await test("CDPATH output is kept separate from discovered source", async () => {
  await prepareShellSyntax();
  const color = (text: string, language: string) => [`[${language}]${text}`];
  const render = (command: string, text: string) =>
    highlightSearchOutput("bash", { command }, text, color);
  const cd = "cd -- project";
  const unnumbered = "rg value src.ts";
  const numbered = "rg -n value src.ts";
  const source = "const value = 1;";
  const directory = "/work/project";
  const combined = `${directory}\n${source}`;
  assert.equal(
    render(`${cd} && ${unnumbered}`, source),
    `[typescript]${source}`,
  );
  assert.equal(render(`${cd} && ${unnumbered}`, combined), combined);
  assert.equal(render(`${cd} && sed -n '1p' src.ts`, combined), combined);
  assert.equal(
    render(`${cd} && ${numbered}`, `${directory}\n2:${source}`),
    `${directory}\n2:[typescript]${source}`,
  );
  const ambiguous = `/work/nested.ts:4:path\n2:${source}`;
  assert.equal(render(`${cd} && ${numbered}`, ambiguous), ambiguous);
  for (const path of ["./project", "../project", "/work/project"])
    assert.equal(
      render(`cd ${path} && ${unnumbered}`, "// value"),
      "[typescript]// value",
    );
  for (const option of ["-", "-P project", '"$target"'])
    assert.equal(render(`cd ${option} && ${unnumbered}`, combined), combined);
});

await test("compact model names preserve versions, variants, and unknown IDs", () => {
  assert.equal(footerModelLabel("gpt-6.1-sol"), "⊛ 6.1 \uE30D");
  assert.equal(footerModelLabel("openai.gpt-6.1-terra"), "⊛ 6.1 \uF0AC");
  assert.equal(footerModelLabel("gpt-6.1-luna"), "⊛ 6.1 \uF186");
  assert.equal(footerModelLabel("gpt-6.1-astra"), "⊛ 6.1 \uF005");
  assert.equal(footerModelLabel("gpt-7-nova"), "⊛ 7 Nova");
  assert.equal(footerModelLabel("gpt-4o-2024-11-20"), "⊛ 4o 2024-11-20");
  assert.equal(footerModelLabel("o3-mini"), "⊛ o3 Mini");
  assert.equal(footerModelLabel("claude-sonnet-4"), "claude-sonnet-4");
});

await test("inline GitHub references retain their exact destinations and line anchors", () => {
  const code = "https://github.com/owner/repo/blob/main/src/driver.ts#L4-L9";
  const issue = "https://github.com/owner/repo/issues/12";
  const rendered = renderReferences(
    `See [source](${code}) and ${issue}. Local src/driver.ts:4.`,
    (text) => text,
  );
  assert.ok(rendered.includes(`\x1b]8;;${code}\x1b\\‹› driver.ts:4–9`));
  assert.ok(rendered.includes(`\x1b]8;;${issue}\x1b\\! owner/repo#12`));
  assert.ok(rendered.endsWith("Local src/driver.ts:4."));
  assert.equal(
    githubLink("https://github.com.example.test/owner/repo/pull/1"),
    undefined,
  );
  assert.equal(
    githubLink("https://github.com/owner/repo/pull/1\x1b]8;;malicious"),
    undefined,
  );
});

await test(
  "CLI reads the explicitly configured source and dispatch never allocates",
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), "studio-workflow-"));
    try {
      const workspace = join(temporary, "authority with spaces");
      await mkdir(join(workspace, ".beads"), { recursive: true });
      await writeFile(
        join(workspace, ".beads/metadata.json"),
        JSON.stringify({ dolt_mode: "server", dolt_database: "fixture" }),
      );
      const capture = join(temporary, "calls.jsonl");
      const boundary = join(temporary, "native-bd");
      await writeFile(
        boundary,
        `#!/usr/bin/env bun\nimport fs from 'node:fs';\nconst args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify(args)+'\\n');\nif (!args.includes('--readonly') || !args.includes('--sandbox')) process.exit(31);\nif(process.env.BEADS_DIR || process.env.BEADS_DOLT_SERVER_PORT) process.exit(32);\nif(args.includes('sql')) console.log(JSON.stringify([{branch:'main'}]));\nelse if(args.includes('list')) console.log(JSON.stringify([{id:'fixture-1',title:'Task tree',status:'open'}]));\nelse if(args.includes('show')) console.log(JSON.stringify([{id:'fixture-1',title:'Task tree',status:'open',description:'Keep state'}]));\nelse process.exit(33);\n`,
        { mode: 0o755 },
      );
      const config = join(temporary, "config.json");
      await writeFile(
        config,
        JSON.stringify({
          beads: {
            workspace,
            database: "fixture",
            branch: "main",
            executable: boundary,
          },
        }),
      );
      const env = {
        ...process.env,
        STUDIO_CONFIG: config,
        BEADS_DIR: "/wrong-workspace",
        BEADS_DOLT_SERVER_PORT: "1",
      };
      const driver = (...args: string[]) =>
        execute(join(root, "scripts/studio"), args, {
          cwd: workspace,
          env,
          timeout: 10_000,
        });
      assert.match((await driver("--help")).stdout, /^Usage: studio /);
      const listing = z
        .object({ workspace: z.string(), tasks: z.array(taskSchema) })
        .parse(JSON.parse((await driver("tasks", "--json")).stdout));
      assert.equal(listing.workspace, workspace);
      assert.equal(listing.tasks[0]?.id, "fixture-1");
      assert.match((await driver("tasks", "fixture-1")).stdout, /Keep state/);
      const before = await readFile(capture, "utf8");
      await assert.rejects(
        driver("start", "--profile", "personal"),
        /missing required argument/,
      );
      assert.equal(
        await readFile(capture, "utf8"),
        before,
        "gated start must not call Beads",
      );
      await writeFile(config, "invalid config");
      assert.match((await driver("skill")).stdout, /Studio/);
      await assert.rejects(
        driver("config", "--example", "--pi-models"),
        /cannot be used with option/,
      );
      await assert.rejects(driver("tasks"), /Cannot load/);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

await test(
  "environment-backed entrypoints preserve directory, Pi arguments and exit status",
  { timeout: 60_000 },
  async () => {
    const temporary = await realpath(
      await mkdtemp(join(tmpdir(), "studio-session-")),
    );
    try {
      const bundle = join(temporary, "bundle");
      const checkout = join(temporary, "project with spaces");
      const host = join(
        bundle,
        "node_modules/@earendil-works/pi-coding-agent/dist",
      );
      for (const path of [
        host,
        checkout,
        join(bundle, "scripts"),
        join(bundle, "resources"),
      ])
        await mkdir(path, { recursive: true });
      await execute(process.execPath, ["scripts/prepare-delegation.mjs"], {
        cwd: root,
        timeout: 10_000,
      });
      await execute(
        process.execPath,
        [
          "build",
          "--target=bun",
          "cli.ts",
          "--outfile",
          join(bundle, "cli.ts"),
        ],
        { cwd: root, timeout: 30_000 },
      );
      for (const name of ["pi", "studio", "runtime.mjs"]) {
        await copyFile(
          join(root, "scripts", name),
          join(bundle, "scripts", name),
        );
        await chmod(join(bundle, "scripts", name), 0o755);
      }
      await copyFile(join(root, "package.json"), join(bundle, "package.json"));
      await copyFile(
        join(root, "resources/bunfig.toml"),
        join(bundle, "resources/bunfig.toml"),
      );
      await writeFile(
        join(host, "cli.js"),
        'console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)})); process.exit(Number(process.env["STUDIO_FIXTURE_EXIT"] ?? 0));',
      );
      const launch = (args: string[], exit = "0") =>
        execute(join(bundle, "scripts/studio"), args, {
          cwd: checkout,
          env: { ...process.env, STUDIO_FIXTURE_EXIT: exit },
          timeout: 10_000,
        });
      for (const [args, forwarded] of [
        [[], []],
        [["lead"], []],
        [
          ["lead", "--", "--resume", "session with spaces"],
          ["--resume", "session with spaces"],
        ],
      ] satisfies [string[], string[]][]) {
        const result = await launch(args);
        const observed: unknown = JSON.parse(result.stdout);
        assert.deepEqual(observed, {
          cwd: checkout,
          args: ["--extension", join(bundle, "extension.ts"), ...forwarded],
        });
      }
      await assert.rejects(launch(["lead"], "23"), { code: 23 });
      await assert.rejects(launch(["start", "fixture"]), /required option/);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

await test("the shared Bun gate accepts newer stable runtimes and rejects old or prerelease runtimes", async () => {
  const validate = (version: string) =>
    execute(
      process.execPath,
      [
        "--eval",
        `Object.defineProperty(process.versions, "bun", {value: ${JSON.stringify(version)}}); await import(${JSON.stringify(join(root, "scripts/runtime.mjs"))});`,
      ],
      { cwd: root },
    );
  await validate("1.4.5");
  await validate("1.5.0");
  await assert.rejects(validate("1.4.4"), /requires Bun/);
  await assert.rejects(validate("1.4.5-canary"), /requires Bun/);
});

await test("opt-in registration preserves local settings and is idempotent", async () => {
  const temporary = await realpath(
    await mkdtemp(join(tmpdir(), "studio-install-")),
  );
  try {
    const agent = join(temporary, "agent");
    await mkdir(agent);
    await writeFile(
      join(agent, "settings.json"),
      JSON.stringify({
        theme: "dark",
        defaultModel: "keep-model",
        packages: ["keep-package"],
      }),
    );
    await chmod(join(agent, "settings.json"), 0o600);
    const install = () =>
      execute("python3", [join(root, "scripts/configure.py"), root, agent], {
        env: { ...process.env, PI_CODING_AGENT_DIR: agent },
      });
    await install();
    await install();
    assert.equal(
      (await stat(join(agent, "settings.json"))).mode & 0o777,
      0o600,
    );
    const settings = z
      .object({
        theme: z.string(),
        quietStartup: z.boolean(),
        defaultModel: z.string(),
        packages: z.array(z.string()),
      })
      .parse(JSON.parse(await readFile(join(agent, "settings.json"), "utf8")));
    assert.equal(settings.theme, "dark");
    assert.equal(settings.quietStartup, true);
    assert.equal(
      await readlink(join(agent, "themes/dotfiles.json")),
      join(root, "resources/theme.json"),
    );
    assert.equal(settings.defaultModel, "keep-model");
    assert.deepEqual(settings.packages, [
      "keep-package",
      root.replace(/\/$/, ""),
    ]);
    const saved = await readFile(join(agent, "settings.json"), "utf8");
    const linked = join(temporary, "linked-settings.json");
    await writeFile(linked, saved);
    await rm(join(agent, "settings.json"));
    await symlink(linked, join(agent, "settings.json"));
    await assert.rejects(install(), /Preserving linked Pi settings/);
    assert.equal(await readFile(linked, "utf8"), saved);
    await rm(join(agent, "settings.json"));
    await writeFile(join(agent, "settings.json"), saved);
    const theme = join(agent, "themes/dotfiles.json");
    await rm(theme);
    await symlink(linked, theme);
    await assert.rejects(install(), /Preserving the existing dotfiles.json/);
    assert.equal(await readlink(theme), linked);
    assert.equal(await readFile(join(agent, "settings.json"), "utf8"), saved);

    const upgradeAgent = join(temporary, "upgrade-agent");
    const previous = join(temporary, "previous-release");
    await mkdir(join(upgradeAgent, "themes"), { recursive: true });
    await mkdir(join(previous, "resources"), { recursive: true });
    await writeFile(join(previous, "resources/theme.json"), "{}");
    await symlink(
      join(previous, "resources/theme.json"),
      join(upgradeAgent, "themes/dotfiles.json"),
    );
    const upgradeSettings = {
      theme: "dotfiles",
      defaultModel: "keep-model",
      packages: ["keep-package", previous],
    };
    await writeFile(
      join(upgradeAgent, "settings.json"),
      JSON.stringify(upgradeSettings),
    );
    await chmod(join(upgradeAgent, "settings.json"), 0o600);
    const registration = join(upgradeAgent, "studio-package.json");
    await writeFile(registration, JSON.stringify({ packages: [previous] }));
    const upgrade = () =>
      execute(
        "python3",
        [join(root, "scripts/configure.py"), root, upgradeAgent],
        { env: { ...process.env, PI_CODING_AGENT_DIR: upgradeAgent } },
      );
    await upgrade();
    assert.deepEqual(
      JSON.parse(await readFile(join(upgradeAgent, "settings.json"), "utf8")),
      {
        ...upgradeSettings,
        packages: ["keep-package", root.replace(/\/$/, "")],
        quietStartup: true,
      },
    );
    assert.equal(
      (await stat(join(upgradeAgent, "settings.json"))).mode & 0o777,
      0o600,
    );
    assert.equal(
      await readlink(join(upgradeAgent, "themes/dotfiles.json")),
      join(root, "resources/theme.json"),
    );
    const ownership = z.object({ packages: z.array(z.string()) });
    assert.deepEqual(
      ownership.parse(
        JSON.parse(
          await readFile(join(upgradeAgent, "studio-package.json"), "utf8"),
        ),
      ).packages,
      [previous, root.replace(/\/$/, "")],
    );
    await upgrade();
    await rm(registration);
    await symlink(linked, registration);
    const upgraded = await readFile(
      join(upgradeAgent, "settings.json"),
      "utf8",
    );
    await assert.rejects(upgrade(), /Preserving linked Pi settings/);
    assert.equal(await readFile(linked, "utf8"), saved);
    assert.equal(
      await readFile(join(upgradeAgent, "settings.json"), "utf8"),
      upgraded,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

await test("optional integrations stay inactive until enabled and fail before effects when absent", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "studio-optional-"));
  try {
    const config = join(temporary, "config.json");
    const marker = join(temporary, "unexpected-effect");
    const executable = join(temporary, "integration");
    await writeFile(
      executable,
      `#!/bin/sh\nprintf called >> "${marker}"\nexit 99\n`,
      { mode: 0o755 },
    );
    const invoke = (...args: string[]) =>
      execute(join(root, "scripts/studio"), args, {
        cwd: temporary,
        env: {
          ...process.env,
          STUDIO_CONFIG: config,
          STUDIO_STATE_DIR: join(temporary, "state"),
        },
      });
    await writeFile(
      config,
      JSON.stringify({
        integrations: {
          zellij: { executable },
          neovim: { executable },
          worktrees: { executable },
          octo: { executable },
        },
      }),
    );
    const report = z
      .object({
        resources: z.object({
          available: z.literal(true),
          paths: z.array(z.string()),
        }),
        integrations: z.record(
          z.string(),
          z.object({ enabled: z.boolean(), available: z.boolean() }),
        ),
      })
      .parse(JSON.parse((await invoke("doctor")).stdout));
    assert.ok(
      report.resources.paths.includes(
        fileURLToPath(import.meta.resolve("@lanej/editor-interop/neovim")),
      ),
    );
    assert.ok(
      Object.values(report.integrations).every(
        (integration) => !integration.enabled && !integration.available,
      ),
    );
    await assert.rejects(
      invoke("start", "fixture", "--profile", "personal"),
      /Enable integrations.zellij.enabled/,
    );
    await writeFile(
      config,
      JSON.stringify({
        integrations: {
          zellij: { enabled: true, executable: join(temporary, "missing") },
        },
      }),
    );
    await assert.rejects(
      invoke("start", "fixture", "--profile", "personal"),
      /Install .*missing or configure integrations.zellij.executable/,
    );
    await assert.rejects(invoke("doctor"));
    await assert.rejects(readFile(marker), /ENOENT/);
    await assert.rejects(
      readFile(join(temporary, "state/attempts.sqlite")),
      /ENOENT/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

await test("launchers ignore checkout Bun preloads and dotenv before the host entrypoint", async () => {
  const temporary = await realpath(
    await mkdtemp(join(tmpdir(), "studio-bootstrap-")),
  );
  try {
    const checkout = join(temporary, "untrusted checkout");
    const home = join(temporary, "home");
    const bundle = join(temporary, "bundle");
    const marker = join(temporary, "preload-executed");
    const hostDirectory = join(
      bundle,
      "node_modules/@earendil-works/pi-coding-agent/dist",
    );
    for (const path of [
      checkout,
      home,
      hostDirectory,
      join(bundle, "scripts"),
      join(bundle, "resources"),
      join(temporary, "bin"),
    ])
      await mkdir(path, { recursive: true });
    const preload = join(checkout, "preload.ts");
    await writeFile(
      preload,
      `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(marker)}, "executed\\n"); process.env["STUDIO_BOOTSTRAP_PRELOAD"] = "executed";`,
    );
    await writeFile(
      join(checkout, "bunfig.toml"),
      `preload = [${JSON.stringify(preload)}]\n`,
    );
    await writeFile(
      join(home, ".bunfig.toml"),
      `preload = [${JSON.stringify(preload)}]\n`,
    );
    await writeFile(
      join(checkout, ".env"),
      "STUDIO_BOOTSTRAP_UNTRUSTED=dotenv\n",
    );
    await writeFile(join(bundle, "resources/bunfig.toml"), "preload = []\n");
    const entry = `console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), inherited: process.env["STUDIO_BOOTSTRAP_INHERITED"], dotenv: process.env["STUDIO_BOOTSTRAP_UNTRUSTED"] ?? null, preload: process.env["STUDIO_BOOTSTRAP_PRELOAD"] ?? null }));`;
    await writeFile(join(hostDirectory, "cli.js"), entry);
    await writeFile(join(bundle, "cli.ts"), entry);
    await symlink(process.execPath, join(temporary, "bin/bun"));
    const args = ["argument with spaces", "--no-extensions", "--resume"];
    await copyFile(join(root, "package.json"), join(bundle, "package.json"));
    await copyFile(
      join(root, "scripts/runtime.mjs"),
      join(bundle, "scripts/runtime.mjs"),
    );
    for (const name of ["pi", "studio"]) {
      const launcher = join(bundle, "scripts", name);
      await copyFile(join(root, "scripts", name), launcher);
      await chmod(launcher, 0o755);
      const result = await execute(launcher, args, {
        cwd: checkout,
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          PATH: `${join(temporary, "bin")}:${process.env["PATH"] ?? ""}`,
          STUDIO_BOOTSTRAP_INHERITED: "preserve",
        },
        timeout: 10_000,
      });
      assert.ok(result.stdout.length > 0, `${name}: ${result.stderr}`);
      const observed = z
        .object({
          cwd: z.string(),
          args: z.array(z.string()),
          inherited: z.string(),
          dotenv: z.string().nullable(),
          preload: z.string().nullable(),
        })
        .parse(JSON.parse(result.stdout));
      assert.deepEqual(observed, {
        cwd: checkout,
        args,
        inherited: "preserve",
        dotenv: null,
        preload: null,
      });
      await assert.rejects(readFile(marker), /ENOENT/);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
