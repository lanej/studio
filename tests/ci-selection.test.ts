import { stringify } from "yaml";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  writeFile,
  mkdir,
  rm,
  readFile,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  changedPaths,
  revisionChecks,
  matchesPaths,
  readWorkflow,
  selectedChecks,
  workflowFiles,
} from "../scripts/ci-selection.ts";

function fixtureGit(cwd: string) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return (...args: string[]) =>
    execFileSync("/usr/bin/git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...environment,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    }).trim();
}

const selected = async (...paths: string[]) =>
  (await selectedChecks(paths)).map((item) => item.workflow);

await test("workflow file filters select consumers without duplicate branch-push suites", async () => {
  for (const file of workflowFiles) {
    const value = await readWorkflow(file);
    assert.deepEqual(value.on.push.branches, ["main"]);
    assert.deepEqual(value.on.push.paths, value.on.pull_request.paths);
    assert(
      matchesPaths(value.on.pull_request.paths, [`.github/workflows/${file}`]),
    );
    assert.equal(value.on.workflow_dispatch, null);
  }
  assert.deepEqual(
    await selected(
      "README.md",
      "docs/assets/transcript.png",
      ".github/workflows/README.md",
    ),
    [],
  );
  assert.deepEqual(await selected("tests/lsp.test.ts"), ["check.yml"]);
  assert.deepEqual(await selected("acceptance/lsp.ts"), [
    "check.yml",
    "lsp.yml",
  ]);
  assert.deepEqual(await selected("execution/worker.ts"), [
    "check.yml",
    "beads.yml",
  ]);
  assert.deepEqual(await selected("acceptance/beads-control.ts"), [
    "check.yml",
    "beads.yml",
  ]);
  assert.deepEqual(await selected(".github/workflows/lsp.yml"), [
    "check.yml",
    "lsp.yml",
  ]);
  assert.deepEqual(await selected(".github/workflows/beads.yml"), [
    "check.yml",
    "beads.yml",
  ]);
});

await test("shared runtime inputs and the full CLI integration retain their consumers", async () => {
  for (const path of [
    "package.json",
    "bun.lock",
    "config.ts",
    "code-intelligence/new-server.ts",
    "scripts/ci-selection.ts",
    "tests/ci-selection.test.ts",
  ])
    assert.deepEqual(await selected(path), [...workflowFiles], path);
  assert.deepEqual(await selected("resources/socrates/host.md"), [
    "check.yml",
    "beads.yml",
  ]);
  assert.deepEqual(await selected("vendor/task-runtime/beads.ts"), [
    "check.yml",
    "beads.yml",
  ]);
  assert.deepEqual(await selected(".typescript-quality/eslint.config.mjs"), [
    "check.yml",
  ]);
  const gates = (await selectedChecks(["package.json"])).flatMap(
    (item) => item.checks,
  );
  assert.deepEqual(gates, [
    "check (ubuntu-latest, minimum)",
    "check (macos-latest, minimum)",
    "check (ubuntu-latest, latest)",
    "lsp-native (ubuntu-latest)",
    "lsp-native (macos-latest)",
    "beads-native (ubuntu-latest)",
    "beads-native (macos-latest)",
  ]);
});

await test("selection detects a removed consumer edge and rejects unsupported filter syntax", async () => {
  const definition = await readWorkflow("lsp.yml");
  assert(
    matchesPaths(definition.on.pull_request.paths, [
      "code-intelligence/client.ts",
    ]),
  );
  assert.equal(
    matchesPaths(
      definition.on.pull_request.paths.filter(
        (path) => path !== "code-intelligence/**",
      ),
      ["code-intelligence/client.ts"],
    ),
    false,
  );
  assert.throws(
    () =>
      matchesPaths(["resources/**", "!resources/**"], ["resources/test.md"]),
    /Unsupported/u,
  );
});

await test("deleted and renamed paths retain both workflow owners in a real revision diff", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-ci-diff-"));
  const git = fixtureGit(directory);
  try {
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "core.hooksPath", "/dev/null");
    await mkdir(join(directory, "code-intelligence"));
    await writeFile(join(directory, "code-intelligence/old.ts"), "source\n");
    git("add", ".");
    git("commit", "-qm", "Before");
    const base = git("rev-parse", "HEAD");
    await mkdir(join(directory, "execution"));
    git("mv", "code-intelligence/old.ts", "execution/new.ts");
    git("commit", "-qm", "After");
    const paths = changedPaths(base, "HEAD", directory);
    assert.deepEqual(paths, ["code-intelligence/old.ts", "execution/new.ts"]);
    assert.deepEqual(await selected(...paths), [...workflowFiles]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("revision selection retains base edges but requires only workflows and check names present at head", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-ci-policy-"));
  const git = fixtureGit(directory);
  try {
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "core.hooksPath", "/dev/null");
    await mkdir(join(directory, ".github/workflows"), { recursive: true });
    for (const file of workflowFiles) {
      const definition = await readWorkflow(file);
      await writeFile(
        join(directory, ".github/workflows", file),
        stringify(definition),
      );
    }
    await mkdir(join(directory, "code-intelligence"));
    await writeFile(join(directory, "code-intelligence/client.ts"), "before\n");
    git("add", ".");
    git("commit", "-qm", "Before");
    const base = git("rev-parse", "HEAD");
    await rm(join(directory, ".github/workflows/lsp.yml"));
    await writeFile(join(directory, "code-intelligence/client.ts"), "after\n");
    git("add", "-A");
    git("commit", "-qm", "Remove LSP workflow");
    const checks = revisionChecks(base, "HEAD", directory);
    assert.deepEqual(
      checks.map((item) => item.workflow),
      ["check.yml", "beads.yml"],
    );
    assert(
      checks.every((item) =>
        item.checks.every((name) => !name.startsWith("lsp-native")),
      ),
    );
    assert.throws(() => revisionChecks(base, "missing-revision", directory));
    await writeFile(
      join(directory, ".github/workflows/check.yml"),
      "invalid: [",
    );
    git("add", ".");
    git("commit", "-qm", "Invalid definition");
    assert.throws(() => revisionChecks(base, "HEAD", directory));
    await writeFile(
      join(directory, ".github/workflows/check.yml"),
      stringify(await readWorkflow("check.yml")),
    );
    await writeFile(
      join(directory, ".github/workflows/unmapped.yml"),
      "name: New workflow\non: push\njobs: {}\n",
    );
    git("add", ".");
    git("commit", "-qm", "Unmapped workflow");
    assert.throws(
      () => revisionChecks(base, "HEAD", directory),
      /Unmapped CI workflow/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("native workflow filters cover static imports and literal process inputs", async () => {
  const ts = await import("typescript");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const cases: { workflow: "lsp.yml" | "beads.yml"; roots: string[] }[] = [
    { workflow: "lsp.yml", roots: ["acceptance/lsp.ts"] },
    {
      workflow: "beads.yml",
      roots: [
        "acceptance/beads-control.ts",
        "acceptance/runtime-beads.ts",
        "acceptance/runtime-worker.ts",
        "cli.ts",
        "extension.ts",
        "execution/host-extension.ts",
        "scripts/runtime.mjs",
      ],
    },
  ];
  for (const item of cases) {
    const definition = await readWorkflow(item.workflow);
    const pending = item.roots.map((path) => resolve(root, path));
    const visited = new Set<string>();
    const processInputs = new Set<string>();
    while (pending.length > 0) {
      const file = pending.pop();
      assert(file !== undefined);
      if (visited.has(file)) continue;
      visited.add(file);
      const local = relative(root, file);
      assert(!local.startsWith(".."), `Local import escaped package: ${local}`);
      assert(
        matchesPaths(definition.on.pull_request.paths, [local]),
        `${item.workflow} does not select consumed ${local}`,
      );
      const source = await readFile(file, "utf8");
      const syntax = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
      );
      const processInput = (node: import("typescript").Node): void => {
        if (
          ts.isCallExpression(node) &&
          ((ts.isIdentifier(node.expression) &&
            node.expression.text === "join") ||
            (ts.isPropertyAccessExpression(node.expression) &&
              node.expression.name.text === "join"))
        ) {
          const base = node.arguments[0];
          const parts = node.arguments.slice(1);
          if (
            base !== undefined &&
            ts.isIdentifier(base) &&
            ["root", "packageRoot"].includes(base.text) &&
            parts.length > 0 &&
            parts.every(ts.isStringLiteralLike)
          ) {
            const path = parts.map((part) => part.text).join("/");
            if (path.startsWith("scripts/")) processInputs.add(path);
          }
        }
        ts.forEachChild(node, processInput);
      };
      processInput(syntax);
      for (const imported of ts.preProcessFile(source, true, true)
        .importedFiles) {
        if (!imported.fileName.startsWith(".")) continue;
        const exact = resolve(dirname(file), imported.fileName);
        if (
          await access(exact)
            .then(() => true)
            .catch(() => false)
        )
          pending.push(exact);
        else {
          const resolved = ts.resolveModuleName(
            imported.fileName,
            file,
            { moduleResolution: ts.ModuleResolutionKind.Bundler },
            ts.sys,
          ).resolvedModule?.resolvedFileName;
          assert(
            resolved !== undefined,
            `Unresolved local import: ${imported.fileName}`,
          );
          pending.push(resolved);
        }
      }
    }
    for (const input of processInputs) {
      await access(resolve(root, input));
      assert(
        matchesPaths(definition.on.pull_request.paths, [input]),
        `${item.workflow} does not select executed ${input}`,
      );
    }
    if (item.workflow === "beads.yml") {
      assert(
        processInputs.has("scripts/prepare-delegation.mjs"),
        "The real preparation invocation must be detected",
      );
      const missingPreparation = definition.on.pull_request.paths.filter(
        (path) => path !== "scripts/prepare-delegation.mjs",
      );
      assert.equal(
        matchesPaths(missingPreparation, ["scripts/prepare-delegation.mjs"]),
        false,
        "Removing the dynamic-exec dependency must lose selection",
      );
    }
  }
});

await test("PR policy rejects unincorporated base CI changes without requiring unrelated base rebases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-ci-base-"));
  const git = fixtureGit(directory);
  try {
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "core.hooksPath", "/dev/null");
    await mkdir(join(directory, ".github/workflows"), { recursive: true });
    for (const file of workflowFiles)
      await writeFile(
        join(directory, ".github/workflows", file),
        stringify(await readWorkflow(file)),
      );
    await mkdir(join(directory, "code-intelligence"));
    await writeFile(join(directory, "code-intelligence/client.ts"), "before\n");
    git("add", ".");
    git("commit", "-qm", "Common base");
    const common = git("rev-parse", "HEAD");
    git("checkout", "-qb", "feature");
    await writeFile(join(directory, "code-intelligence/client.ts"), "after\n");
    git("add", ".");
    git("commit", "-qm", "Feature");
    const head = git("rev-parse", "HEAD");
    git("checkout", "-qb", "target-ci", common);
    git(
      "mv",
      ".github/workflows/lsp.yml",
      ".github/workflows/language-server.yml",
    );
    git("commit", "-qm", "Base renamed workflow");
    assert.throws(
      () => revisionChecks("HEAD", head, directory),
      /Sync current CI definitions/u,
    );
    git("checkout", "-qb", "target-docs", common);
    await writeFile(
      join(directory, "README.md"),
      "Unrelated base documentation\n",
    );
    git("add", ".");
    git("commit", "-qm", "Base documentation");
    assert.deepEqual(
      revisionChecks("HEAD", head, directory).map((item) => item.workflow),
      [...workflowFiles],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
