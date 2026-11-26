import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

await test("manifest-only source exports preserve extension modules and the installed editor runtime", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "studio-source-export-"));
  try {
    // Start from the checked-in snapshot boundary. Exporting from Git first
    // would regenerate its manifest and conceal a missing required module.
    const snapshot = join(temporary, "snapshot");
    const names = z
      .array(z.string())
      .parse(
        JSON.parse(await readFile(join(root, "source-files.json"), "utf8")),
      );
    for (const name of names) {
      const target = join(snapshot, name);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(root, name), target);
    }
    const guard = join(temporary, "guard");
    await mkdir(guard);
    const git = join(guard, "git");
    const gitProbe = join(temporary, "git-probed");
    await writeFile(
      git,
      '#!/bin/sh\nprintf "unavailable\\n" >> "$STUDIO_EXPORT_GIT_PROBE"\nexit 1\n',
    );
    await chmod(git, 0o755);
    const env = {
      ...process.env,
      PATH: `${guard}:${process.env["PATH"] ?? ""}`,
      STUDIO_EXPORT_GIT_PROBE: gitProbe,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    };
    const artifact = join(temporary, "export");
    await execute("python3", [join(snapshot, "scripts/export.py"), artifact], {
      env,
      timeout: 15_000,
    });
    assert.match(
      await readFile(gitProbe, "utf8"),
      /unavailable/u,
      "the real source selector used its no-Git fallback",
    );
    assert.deepEqual(
      await readFile(join(artifact, "keybindings.ts")),
      await readFile(join(root, "keybindings.ts")),
    );
    for (const resource of [
      "package.json",
      "bun.lock",
      "documents/editor.ts",
      "documents/provider.ts",
      "documents/workspace.ts",
    ]) {
      assert.deepEqual(
        await readFile(join(artifact, resource)),
        await readFile(join(root, resource)),
      );
    }
    // Resolve the actual exported extension's local import graph without
    // installing dependencies or executing the extension.
    await execute(
      process.execPath,
      [
        "build",
        join(artifact, "extension.ts"),
        "--target=bun",
        "--packages=external",
        "--outdir",
        join(temporary, "build"),
      ],
      { env, timeout: 15_000 },
    );
    // Reuse installed dependencies to exercise their public resource exports
    // from the source artifact without a network install.
    await symlink(join(root, "node_modules"), join(artifact, "node_modules"));
    const report = z
      .object({ available: z.literal(true), paths: z.array(z.string()) })
      .parse(
        JSON.parse(
          (
            await execute(
              process.execPath,
              [
                "--no-env-file",
                "-e",
                'import { inspectPackageResources } from "./package-resources.ts"; console.log(JSON.stringify(await inspectPackageResources()));',
              ],
              { cwd: artifact, env, timeout: 15_000 },
            )
          ).stdout,
        ),
      );
    assert.ok(
      (await Promise.all(report.paths.map((path) => realpath(path)))).includes(
        await realpath(
          fileURLToPath(import.meta.resolve("@lanej/copydesk/neovim")),
        ),
      ),
      "the exported Studio resource check resolves the installed editor package's public runtime",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
