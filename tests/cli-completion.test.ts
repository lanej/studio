import { spawnSync, type SpawnSyncOptionsWithBufferEncoding } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

function run(argv: string[], options: SpawnSyncOptionsWithBufferEncoding) {
  const [executable, ...args] = argv;
  if (executable === undefined) throw new Error("Missing executable");
  return spawnSync(executable, args, options);
}

const cli = new URL("../cli.ts", import.meta.url).pathname;
// Preserve provisioned package code, not Studio configuration, across HOME
// isolation. An empty dependency cache could turn this into a network install.
const bunInstall = process.env["BUN_INSTALL"] ?? join(homedir(), ".bun");
const dependencyCache = process.env["BUN_INSTALL_CACHE_DIR"] ?? join(bunInstall, "install", "cache");

function offline<T>(exercise: (invoke: (...args: string[]) => string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "studio-completion-test-"));
  const config = join(home, "invalid.json");
  writeFileSync(config, "configuration must never be loaded");
  try {
    return exercise((...args) => {
      const result = run([process.execPath, "--no-install", cli, ...args], {
        cwd: home,
        env: {
          ...process.env,
          BUN_INSTALL: bunInstall,
          BUN_INSTALL_CACHE_DIR: dependencyCache,
          // Bun's transpiler cache otherwise creates ~/Library on macOS,
          // independently of Studio. Disable it so the unchanged-HOME
          // assertion measures CLI effects rather than runtime caching.
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
          HOME: home,
          XDG_CONFIG_HOME: home,
          XDG_STATE_HOME: home,
          STUDIO_CONFIG: config,
          PATH: home,
          AWS_SHARED_CREDENTIALS_FILE: join(home, "absent-credentials"),
        },
        timeout: 15_000,
      });
      expect(result.stderr.toString()).toBe("");
      expect(result.status).toBe(0);
      expect(readdirSync(home)).toEqual(["invalid.json"]);
      return result.stdout.toString().trim();
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function query(...words: string[]): string[] {
  return offline((invoke) => {
    const output = invoke("completion", "--query", "--", ...words);
    return output === "" ? [] : output.split("\n");
  });
}

describe("offline Commander completion", () => {
  test("top-level and nested commands follow actual help metadata", () => {
    offline((invoke) => {
      const root = invoke("--help");
      for (const candidate of query("")) expect(root).toContain(candidate);
      const runtime = invoke("runtime", "--help");
      for (const candidate of query("runtime", "")) expect(runtime).toContain(candidate);
    });
    expect(query("ru")).toEqual(["runtime"]);
    expect(query("runtime", "sta")).toEqual(["start", "status"]);
    expect(query("runtime", "ver")).toEqual([]);
    expect(query("runtime", "verify", "--t")).toEqual([]);
    expect(query("runtime", "status", "")).toEqual([]);
    expect(query("help", "runtime", "sta")).toEqual([]);
    expect(query("runtime", "help", "sta")).toEqual(["start", "status"]);
  });

  test("flags are command-specific and prefix filtered", () => {
    expect(query("tasks", "--j")).toEqual(["--json"]);
    expect(query("config", "--r")).toEqual(["--region"]);
    expect(query("publish", "id", "--b")).toEqual(["--base", "--body-file"]);
    expect(query("runtime", "status", "--")).toEqual(["--help"]);
    expect(query("doctor", "--j")).toEqual([]);
    expect(query("start", "id", "--", "")).toEqual([]);
    expect(query("lead", "--", "--pro")).toEqual([]);
    expect(query("start", "id", "--w")).toEqual(["--worker"]);
  });

  test("declared values, argument choices and help topics", () => {
    expect(query("start", "id", "--profile", "")).toEqual([]);
    expect(query("start", "--profile=p")).toEqual([]);
    expect(query("start", "--profile", "missing")).toEqual([]);
    expect(query("skill", "--topic", "pro")).toEqual(["profile"]);
    expect(query("skill", "--topic", "")).toEqual(["compaction", "dispatch", "profile", "tasks"]);
    expect(query("skill", "--topic=ta")).toEqual(["--topic=tasks"]);
    expect(query("completion", "")).toEqual(["bash", "fish", "zsh"]);
    expect(query("completion", "z")).toEqual(["zsh"]);
    expect(query("tasks", "unknown-id")).toEqual([]);
    expect(query("publish", "id", "--base", "")).toEqual([]);
    expect(query("config", "--pi-models", "")).toEqual([]);
  });

  test("queries are bounded and never execute requested commands", () => {
    expect(query(...Array<string>(129).fill("runtime"), "")).toEqual([]);
    expect(query("x".repeat(4097))).toEqual([]);
    expect(query("runtime", "serve", "")).toEqual([]);
    expect(query("doctor", "")).toEqual([]);
  });

  test("generation and setup help need no optional integrations or credentials", () => {
    offline((invoke) => {
      const help = invoke("completion", "--help");
      for (const shell of ["bash", "zsh", "fish"]) {
        expect(help.toLowerCase()).toContain(shell);
        const script = invoke("completion", shell);
        expect(script).toContain("# Opt-in");
        expect(script).toContain("studio completion --query --");
        expect(script).toContain("offline");
      }
    });
  });
});
