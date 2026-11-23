import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  realpath,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, processStart } from "../process.ts";
import { alive } from "../execution/supervisor.ts";
import { verificationSandbox } from "../execution/sandbox.ts";
import { safeGit } from "../execution/git.ts";
import { gitState, runCheck } from "../task-verification.ts";
import { createServer } from "node:net";
import { once } from "node:events";

const fixture = await realpath(
  await mkdtemp(join(tmpdir(), "studio-verifier-boundary-")),
);
const project = join(fixture, "project");
const checkout = join(project, ".worktrees", "worker");
const privateState = join(fixture, "state");
await mkdir(project);
await mkdir(privateState);
const previous = process.env["STUDIO_STATE_DIR"];
process.env["STUDIO_STATE_DIR"] = privateState;
try {
  const ordinary = (args: string[]) =>
    run("/usr/bin/git", args, { cwd: project });
  await ordinary(["init", "-q"]);
  await ordinary(["config", "user.name", "Fixture"]);
  await ordinary(["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(project, "source.txt"), "reviewed source");
  await writeFile(
    join(project, ".gitignore"),
    "build-output/\nnode_modules\n.worktrees/\n",
  );
  await ordinary(["add", "."]);
  await ordinary(["-c", "commit.gpgsign=false", "commit", "-qm", "Fixture"]);
  await ordinary(["worktree", "add", "-q", "-b", "worker", checkout]);
  const git = (args: string[], env?: NodeJS.ProcessEnv) =>
    safeGit(project, checkout, args, {
      ...(env?.["GIT_INDEX_FILE"] === undefined
        ? {}
        : { indexFile: env["GIT_INDEX_FILE"] }),
    });
  const dependency = join(fixture, "dependencies", "fixture");
  await mkdir(dependency, { recursive: true });
  await writeFile(
    join(dependency, "index.js"),
    'module.exports="verified dependency";',
  );
  await symlink(join(fixture, "dependencies"), join(checkout, "node_modules"));
  await ordinary([
    "config",
    "http.https://fixture.invalid/.extraheader",
    "Fixture-Authority: owned-config-sentinel",
  ]);
  const originalMetadata = (
    await git(["rev-parse", "--path-format=absolute", "--git-dir"])
  ).trim();
  await writeFile(
    join(originalMetadata, "config.worktree"),
    "[fixture]\n authority = owned-worktree-sentinel\n",
  );
  const originalGitConfig = await readFile(
    join(project, ".git", "config"),
    "utf8",
  );
  const before = await gitState(checkout, "worker", git);
  const snapshot = {
    projectRoot: project,
    tree: before.gitState,
    branch: "worker",
  };
  const sentinel = join(privateState, "controller-policy.json");
  await writeFile(sentinel, "private-policy");
  const listener = createServer((socket) => {
    socket.end();
  });
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert(address !== null && typeof address !== "string");
  const script = `const fs = require("node:fs"); const net=require("node:net"); let denied=0; try{fs.writeFileSync(${JSON.stringify(sentinel)},"tampered")}catch{denied++} try{fs.readFileSync(${JSON.stringify(sentinel)})}catch{denied++} try{fs.writeFileSync(${JSON.stringify(join(checkout, "source.txt"))},"tampered")}catch{denied++} if(require("./node_modules/fixture/index.js")!=="verified dependency")process.exit(24);try{fs.writeFileSync("node_modules/fixture/index.js","tampered dependency")}catch{denied++}try{fs.writeFileSync(${JSON.stringify(join(project, ".git", "config"))},"tampered metadata")}catch{denied++}fs.mkdirSync("build-output");fs.writeFileSync("build-output/result.txt","isolated output"); if(denied!==5)process.exit(21); const socket=net.connect({host:"127.0.0.1",port:${String(address.port)}}); socket.on("connect",()=>process.exit(22)); socket.on("error",()=>process.exit(0)); setTimeout(()=>process.exit(23),2000);`;
  const inspectGit = `const fs=require("node:fs");const cp=require("node:child_process");for(const path of ${JSON.stringify([join(project, ".git", "config"), join(originalMetadata, "config.worktree"), join(checkout, ".git")])}){try{if(fs.readFileSync(path,"utf8").trim().length>0)process.exit(41)}catch{}}const head=cp.execFileSync("/usr/bin/git",["rev-parse","HEAD"],{encoding:"utf8"}).trim();if(head!==${JSON.stringify(before.gitHead)})process.exit(42);const status=cp.execFileSync("/usr/bin/git",["status","--porcelain"],{encoding:"utf8"});if(status.trim().length>0)process.exit(43);const config=cp.execFileSync("/usr/bin/git",["config","--list"],{encoding:"utf8"});if(config.includes("owned-config-sentinel")||config.includes("owned-worktree-sentinel"))process.exit(44);`;
  const sanitized = await verificationSandbox(
    checkout,
    [process.execPath, "-e", inspectGit],
    [],
    snapshot,
  );
  try {
    const result = await runCheck(
      sanitized.argv,
      sanitized.cwd,
      AbortSignal.timeout(10000),
      undefined,
      sanitized.environment,
    );
    assert.equal(result.exitCode, 0, result.output);
    await sanitized.assertSourceUnchanged();
  } finally {
    await sanitized.close();
  }
  await assert.rejects(
    verificationSandbox(
      checkout,
      [process.execPath, "--version"],
      [join(project, ".git", "config")],
      snapshot,
    ),
    /original Git metadata/u,
  );
  const sandbox = await verificationSandbox(
    checkout,
    [process.execPath, "-e", script],
    [],
    snapshot,
  );
  try {
    const result = await runCheck(
      sandbox.argv,
      sandbox.cwd,
      AbortSignal.timeout(10000),
      undefined,
      sandbox.environment,
    );
    assert.equal(result.exitCode, 0, result.output);
    await sandbox.assertSourceUnchanged();
    assert.equal(
      await readFile(join(sandbox.cwd, "build-output/result.txt"), "utf8"),
      "isolated output",
    );
    await assert.rejects(access(join(checkout, "build-output/result.txt")));
  } finally {
    await sandbox.close();
    await new Promise<void>((resolve) => {
      listener.close(() => {
        resolve();
      });
    });
  }
  assert.equal(await readFile(sentinel, "utf8"), "private-policy");
  assert.equal(
    await readFile(join(project, ".git", "config"), "utf8"),
    originalGitConfig,
  );
  assert.equal(
    await readFile(join(dependency, "index.js"), "utf8"),
    'module.exports="verified dependency";',
  );
  assert.equal(
    await readFile(join(checkout, "source.txt"), "utf8"),
    "reviewed source",
  );
  await assert.rejects(
    verificationSandbox(checkout, [process.execPath, "--version"], [sentinel]),
    /credentials/u,
  );
  // A configured private file remains hidden even inside a broad system read mount.
  const previousConfig = process.env["STUDIO_CONFIG"];
  process.env["STUDIO_CONFIG"] = "/etc/hosts";
  try {
    const masked = await verificationSandbox(
      checkout,
      [
        process.execPath,
        "-e",
        'try{if(require("node:fs").readFileSync("/etc/hosts","utf8").trim().length>0)process.exit(31)}catch{}',
      ],
      [],
      snapshot,
    );
    try {
      const result = await runCheck(
        masked.argv,
        masked.cwd,
        AbortSignal.timeout(10000),
        undefined,
        masked.environment,
      );
      assert.equal(result.exitCode, 0, result.output);
    } finally {
      await masked.close();
    }
  } finally {
    if (previousConfig === undefined) delete process.env["STUDIO_CONFIG"];
    else process.env["STUDIO_CONFIG"] = previousConfig;
  }
  const mutate = await verificationSandbox(
    checkout,
    [
      process.execPath,
      "-e",
      'require("node:fs").writeFileSync("source.txt","changed copy")',
    ],
    [],
    snapshot,
  );
  try {
    const result = await runCheck(
      mutate.argv,
      mutate.cwd,
      AbortSignal.timeout(10000),
      undefined,
      mutate.environment,
    );
    assert.equal(result.exitCode, 0, result.output);
    await assert.rejects(
      mutate.assertSourceUnchanged(),
      /reviewed source snapshot/u,
    );
  } finally {
    await mutate.close();
  }
  if (process.platform === "darwin") {
    // A deliberately detached descendant survives ordinary group cleanup, but only has scratch writes.
    const descendant = `const fs=require("node:fs");let ticks=0;const timer=setInterval(()=>{if(!fs.existsSync("build-output/trigger")&&ticks++<100)return;clearInterval(timer);let denied=false;try{fs.writeFileSync(${JSON.stringify(join(checkout, "source.txt"))},"late mutation")}catch{denied=true}fs.writeFileSync("build-output/late-result",String(denied));},20);`;
    const launch = `const fs=require("node:fs");fs.mkdirSync("build-output"); const child=require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{detached:true,stdio:"ignore"});fs.writeFileSync("build-output/child-pid",String(child.pid));child.unref();`;
    const lingering = await verificationSandbox(
      checkout,
      [process.execPath, "-e", launch],
      [],
      snapshot,
    );
    let detached: { pid: number; started: string } | undefined;
    try {
      const result = await runCheck(
        lingering.argv,
        lingering.cwd,
        AbortSignal.timeout(10000),
        undefined,
        lingering.environment,
      );
      assert.equal(result.exitCode, 0, result.output);
      await lingering.assertSourceUnchanged();
      const childPid = Number(
        await readFile(join(lingering.cwd, "build-output/child-pid"), "utf8"),
      );
      assert(Number.isSafeInteger(childPid) && childPid > 0);
      const childStart = await processStart(childPid);
      detached = { pid: childPid, started: childStart };
      await writeFile(
        join(lingering.cwd, "build-output/trigger"),
        "wrapper completed",
      );
      const deadline = Date.now() + 5000;
      while (
        !(await access(join(lingering.cwd, "build-output/late-result"))
          .then(() => true)
          .catch(() => false))
      ) {
        assert(
          Date.now() < deadline,
          "Detached fixture did not return confinement evidence",
        );
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(
        await readFile(join(lingering.cwd, "build-output/late-result"), "utf8"),
        "true",
      );
      assert.equal(
        await readFile(join(checkout, "source.txt"), "utf8"),
        "reviewed source",
      );
      const settled = Date.now() + 3000;
      while (await alive(childPid, childStart)) {
        if (Date.now() >= settled) {
          process.kill(childPid, "SIGKILL");
          throw new Error("Detached fixture did not settle");
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      if (
        detached !== undefined &&
        (await alive(detached.pid, detached.started))
      )
        process.kill(detached.pid, "SIGKILL");
      await lingering.close();
    }
  }
  console.log(
    "Native verifier boundary confines source/dependency writes to disposable snapshots, rejects source mutations, blocks controller-state/network access, and confines late detached descendants.",
  );
} finally {
  if (previous === undefined) delete process.env["STUDIO_STATE_DIR"];
  else process.env["STUDIO_STATE_DIR"] = previous;
  await rm(fixture, { recursive: true, force: true });
}
