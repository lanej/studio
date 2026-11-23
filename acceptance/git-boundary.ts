import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../process.ts";
import { gitState } from "../task-verification.ts";
import { safeGit } from "../execution/git.ts";
import { snapshotTools } from "../delegation.ts";

const fixture = await realpath(
  await mkdtemp(join(tmpdir(), "studio-git-boundary-")),
);
const project = join(fixture, "source");
const checkout = join(project, ".worktrees", "owned");
const marker = join(fixture, "controller-marker");
const ordinary = (args: string[], cwd = project) =>
  run("/usr/bin/git", args, { cwd });
try {
  await mkdir(project);
  await ordinary(["init", "-q"]);
  await ordinary(["config", "user.name", "Fixture"]);
  await ordinary(["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(project, "baseline.txt"), "initial\n");
  await ordinary(["add", "."]);
  await ordinary(["-c", "commit.gpgsign=false", "commit", "-qm", "Initial"]);
  await ordinary(["worktree", "add", "-q", "-b", "worker", checkout]);
  // These trusted configuration values point to scripts whose contents the worker can edit.
  await ordinary(["config", "filter.fixture.clean", "./clean.sh"]);
  await ordinary(["config", "filter.fixture.smudge", "./clean.sh"]);
  await ordinary(["config", "filter.fixture.required", "true"]);
  await ordinary(["config", "core.hooksPath", ".hooks"]);
  await mkdir(join(checkout, ".hooks"));
  const callback = `#!/bin/sh\nprintf invoked > '${marker}'\ncat\n`;
  await writeFile(join(checkout, "clean.sh"), callback);
  await writeFile(join(checkout, ".hooks", "pre-commit"), callback);
  await chmod(join(checkout, "clean.sh"), 0o755);
  await chmod(join(checkout, ".hooks", "pre-commit"), 0o755);
  await writeFile(join(checkout, ".gitattributes"), "*.txt filter=fixture\n");
  await writeFile(join(checkout, "result.txt"), "accepted result\n");
  const git = (args: string[], env?: NodeJS.ProcessEnv) =>
    safeGit(project, checkout, args, {
      ...(env?.["GIT_INDEX_FILE"] === undefined
        ? {}
        : { indexFile: env["GIT_INDEX_FILE"] }),
    });
  const fingerprint = await gitState(checkout, "worker", git);
  await git(["add", "-A"]);
  await git(["commit", "-qm", "Accepted worker output"]);
  assert.equal(
    (await git(["rev-parse", "HEAD^{tree}"])).trim(),
    fingerprint.gitState,
  );
  assert.equal(await git(["show", "HEAD:result.txt"]), "accepted result\n");
  await snapshotTools(checkout, (await git(["rev-parse", "HEAD"])).trim(), git);
  await assert.rejects(access(marker));
  // Includes from mutable source are rejected before an indexing or commit command.
  await writeFile(
    join(checkout, "worker-config"),
    '[filter "extra"]\n clean = ./clean.sh\n',
  );
  await ordinary(["config", "include.path", join(checkout, "worker-config")]);
  await assert.rejects(git(["add", "-A"]), /worker-writable/u);
  await ordinary(["config", "--unset", "include.path"]);
  // A changed .git pointer cannot rebind the controller to another repository.
  const identity = await readFile(join(checkout, ".git"), "utf8");
  await writeFile(join(checkout, ".git"), `gitdir: ${join(project, ".git")}\n`);
  await assert.rejects(
    git(["status", "--porcelain"]),
    /registered isolated worktree/u,
  );
  await writeFile(join(checkout, ".git"), identity);
  await assert.rejects(access(marker));
  console.log(
    "Native Git boundary disabled worker-writable filter/hooks, rejected source config includes, and retained registered checkout identity.",
  );
} finally {
  await rm(fixture, { recursive: true, force: true });
}
