import { createServer } from "node:http";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { runInNewContext } from "node:vm";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { run } from "../process.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
// A package-manager rename must not turn an old mapped image into the selected one.
const hostSource = (
  await readFile(join(root, "scripts/host-identity.mjs"), "utf8")
)
  .replace(/^import .*;\n/gmu, "")
  .replaceAll("export function", "function")
  .replaceAll("import.meta", "hostMeta");
const oldHost = { dev: 1n, ino: 10n, size: 1n, mtimeNs: 1n, ctimeNs: 1n };
const newHost = { dev: 1n, ino: 20n, size: 1n, mtimeNs: 2n, ctimeNs: 2n };
for (const kind of ["mapped", "selected"]) {
  let stats = 0;
  let closed = 0;
  const boundary = {
    createHash,
    basename,
    delimiter,
    join,
    URL,
    hostMeta: { url: "file:///shared/scripts/host-identity.mjs" },
    process: {
      platform: "darwin",
      pid: 111,
      execPath: "/shared/bun",
      env: { PATH: "/shared" },
    },
    accessSync() {},
    constants: { X_OK: 1 },
    realpathSync: (path: string) => path,
    statSync: () => (++stats === 1 ? oldHost : newHost),
    openSync: () => 7,
    fstatSync: () => newHost,
    closeSync: () => {
      closed++;
    },
    readFileSync: () => Buffer.from("B"),
    spawnSync: () => ({
      status: 0,
      stdout: kind === "mapped" ? "D0x1\ni10\nn/shared/bun\n" : "1.4.5\n",
    }),
  };
  const call = kind === "mapped" ? "mappedHost()" : "selectedHost('>=1.4.5')";
  assert.throws(
    () => runInNewContext(`${hostSource}\n${call}`, boundary),
    /changed/u,
  );
  assert.equal(closed, 1, "Host image descriptor must close on refusal");
}
const temporary = await mkdtemp(
  join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "st-act-"),
);
const prefix = join(temporary, "prefix");
const state = join(temporary, "state");
const agent = join(temporary, "agent");
const workspace = join(temporary, "work");
const env: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: temporary,
  STUDIO_PREFIX: prefix,
  STUDIO_STATE_DIR: state,
  PI_CODING_AGENT_DIR: agent,
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
};
delete env["ZELLIJ"];
delete env["ZELLIJ_SESSION_NAME"];
delete env["ZELLIJ_PANE_ID"];
const processSchema = z.object({
  pid: z.number().int().positive(),
  start_identity: z.string().min(1),
  native_id: z.uuid(),
  owner_verified: z.literal(true),
});
const nativeTarget = z.object({
  target: z.string(),
  running_identity: z.string(),
  ready: z.boolean(),
  process: processSchema,
  sessions: z.array(
    z.object({
      session_id: z.string(),
      transcript_path: z.string(),
      branch_id: z.string().nullable(),
      cwd: z.string(),
      restoration: z.string(),
    }),
  ),
  checkpoint: z.object({ state: z.string(), run_id: z.uuid() }).optional(),
});
type Target = z.infer<typeof nativeTarget>;
async function control(path: string, request: object): Promise<Target> {
  return new Promise((resolve, reject) => {
    const connection = createConnection(path);
    let buffer = "";
    let settled = false;
    const finish = (error?: Error, value?: Target): void => {
      if (settled) return;
      settled = true;
      connection.destroy();
      if (error !== undefined) reject(error);
      else if (value !== undefined) resolve(value);
      else reject(new Error("Missing native response"));
    };
    connection.setTimeout(60_000, () => {
      finish(new Error("Native checkpoint timed out"));
    });
    connection.on("connect", () => {
      connection.write(`${JSON.stringify(request)}\n`);
    });
    connection.on("error", (error) => {
      finish(error);
    });
    connection.on("close", () => {
      if (!settled) finish(new Error("Native response was lost"));
    });
    connection.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\n")) return;
      try {
        const value: unknown = JSON.parse(
          buffer.slice(0, buffer.indexOf("\n")),
        );
        const error = z.object({ error: z.string() }).safeParse(value);
        if (error.success) {
          finish(new Error(error.data.error));
          return;
        }
        const result = z
          .object({
            schema_version: z.literal(1),
            targets: z.array(nativeTarget).length(1),
          })
          .parse(value);
        finish(undefined, result.targets[0]);
      } catch (cause) {
        finish(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  });
}
class Host {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  errors = "";
  constructor(
    launcher: string,
    args: string[],
    environment: NodeJS.ProcessEnv = env,
  ) {
    this.child = spawn(launcher, args, {
      cwd: workspace,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.errors += chunk.toString();
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const value: unknown = JSON.parse(line);
      const response = z
        .looseObject({ id: z.string(), success: z.boolean() })
        .safeParse(value);
      if (!response.success) return;
      const waiting = this.pending.get(response.data.id);
      if (waiting === undefined) return;
      this.pending.delete(response.data.id);
      if (response.data.success) waiting.resolve(value);
      else waiting.reject(new Error(JSON.stringify(value)));
    });
  }
  async rpc(type: string, extra: object = {}): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`);
    });
  }
  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      this.child.once("close", () => {
        resolve();
      });
    });
  }
}
async function record(
  pid: number,
): Promise<{ socket: string; process: z.infer<typeof processSchema> }> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      for (const name of await readdir(join(state, "activation"))) {
        if (!name.endsWith(".json")) continue;
        const value = z
          .object({ socket: z.string(), process: processSchema })
          .parse(
            JSON.parse(await readFile(join(state, "activation", name), "utf8")),
          );
        if (value.process.pid === pid) return value;
      }
    } catch (error) {
      if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success) {
        await delay(20);
        continue;
      }
      throw error;
    }
    await delay(20);
  }
  throw new Error("Pi did not publish its authoritative lifecycle record");
}

let requests = 0;
const provider = createServer((request, response) => {
  if (request.method !== "POST") {
    response.writeHead(404);
    response.end();
    return;
  }
  requests++;
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write(
    `data: ${JSON.stringify({
      id: "fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "tiny",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "interrupted fixture output" },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
});
await new Promise<void>((resolve) => {
  provider.listen(0, "127.0.0.1", resolve);
});
const address = provider.address();
if (address === null || typeof address === "string")
  throw new Error("Fixture provider did not bind a port");
let background: Host | undefined;
let first: Host | undefined;
let resumed: Host | undefined;
try {
  await Promise.all([
    mkdir(agent, { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ]);
  await writeFile(
    join(agent, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
          api: "openai-completions",
          apiKey: "synthetic-fixture",
          models: [{ id: "tiny" }],
        },
      },
    }),
    { mode: 0o600 },
  );
  await run(process.execPath, [join(root, "scripts/lifecycle.mjs"), "build"], {
    env,
    timeout: 180_000,
  });
  const status = z
    .object({ installed_identity: z.string(), installed_release: z.string() })
    .parse(
      JSON.parse(
        await run(
          process.execPath,
          [join(root, "scripts/lifecycle.mjs"), "status"],
          { env },
        ),
      ),
    );
  const launcher = join(status.installed_release, "scripts/pi");
  const args = ["--mode", "rpc", "--offline", "--model", "fixture/tiny"];
  const delayedReply = join(temporary, "delayed-reply.js");
  const admittedMarker = join(temporary, "admitted-command");
  const releaseMarker = join(temporary, "release-command");
  const bashAdmitted = join(temporary, "admitted-bash-handler");
  const bashRelease = join(temporary, "release-bash-handler");
  await writeFile(
    delayedReply,
    `import { Socket } from "node:net";
import { existsSync, writeFileSync } from "node:fs";
import { registerActivationAdmission } from ${JSON.stringify(join(status.installed_release, "activation.ts"))};
export default function (pi) {
  registerActivationAdmission(pi);
  pi.registerCommand("admission-fixture", {description:"Owned asynchronous admission fixture", handler: async () => {
    writeFileSync(${JSON.stringify(admittedMarker)}, "admitted");
    while (!existsSync(${JSON.stringify(releaseMarker)})) await new Promise(resolve => setTimeout(resolve, 20));
  }});
  pi.on("user_bash", async (event) => {
    if (event.command !== "paused-native-bash-fixture") return undefined;
    writeFileSync(${JSON.stringify(bashAdmitted)}, "admitted");
    while (!existsSync(${JSON.stringify(bashRelease)})) await new Promise(resolve => setTimeout(resolve, 20));
    return {result:{output:"Controlled remote Bash result",exitCode:0,cancelled:false,truncated:false}};
  });
  const original = Socket.prototype.end;
  Socket.prototype.end = function (...args) {
    const callback = args.at(-1);
    if (typeof callback === "function") args[args.length - 1] = () => setTimeout(callback, 150);
    return original.apply(this, args);
  };
}
`,
  );
  first = new Host(launcher, [...args, "--extension", delayedReply]);
  if (first.child.pid === undefined)
    throw new Error("Native Pi host did not start");
  const published = await record(first.child.pid);
  const suspendedBash = first.rpc("bash", {
    command: "paused-native-bash-fixture",
  });
  const bashDeadline = Date.now() + 10_000;
  while (Date.now() < bashDeadline) {
    try {
      await readFile(bashAdmitted);
      break;
    } catch {
      await delay(20);
    }
  }
  assert.equal(await readFile(bashAdmitted, "utf8"), "admitted");
  const whileBash = await control(published.socket, { action: "inventory" });
  await assert.rejects(
    control(published.socket, {
      action: "checkpoint",
      expected_session: whileBash.sessions[0],
      native_id: whileBash.process.native_id,
      start_identity: whileBash.process.start_identity,
      run_id: randomUUID(),
      checkpoint_directory: temporary,
      replacement_identity: status.installed_identity,
    }),
    /native-Bash-dispatch-is-still-admitted/u,
  );
  assert.equal(
    (await control(published.socket, { action: "verify" })).ready,
    true,
  );
  await writeFile(bashRelease, "settle");
  await suspendedBash;
  const before = await control(published.socket, { action: "inventory" });
  assert.equal(
    before.running_identity,
    status.installed_identity,
    "the selected shared Bun image and loaded bundle must match",
  );
  assert.equal(before.ready, true);
  assert.equal(before.sessions[0]?.cwd, workspace);
  await assert.rejects(
    control(published.socket, {
      action: "checkpoint",
      native_id: randomUUID(),
      start_identity: before.process.start_identity,
      run_id: randomUUID(),
      checkpoint_directory: temporary,
      replacement_identity: status.installed_identity,
    }),
    /incarnation changed/u,
  );
  assert.equal(
    (await control(published.socket, { action: "verify" })).ready,
    true,
  );
  const pausedCommand = first.rpc("prompt", { message: "/admission-fixture" });
  const commandDeadline = Date.now() + 10_000;
  while (Date.now() < commandDeadline) {
    try {
      await readFile(admittedMarker);
      break;
    } catch {
      await delay(20);
    }
  }
  assert.equal(await readFile(admittedMarker, "utf8"), "admitted");
  await assert.rejects(
    control(published.socket, {
      action: "checkpoint",
      expected_session: before.sessions[0],
      native_id: before.process.native_id,
      start_identity: before.process.start_identity,
      run_id: randomUUID(),
      checkpoint_directory: temporary,
      replacement_identity: status.installed_identity,
    }),
    /native-async-command-is-still-admitted/u,
  );
  await writeFile(releaseMarker, "settle");
  await pausedCommand;
  const runtimeConfig = join(temporary, "runtime.json");
  await writeFile(
    runtimeConfig,
    JSON.stringify({ runtime: { enabled: true, pollMs: 1000, projects: [] } }),
  );
  background = new Host(
    join(status.installed_release, "scripts/studio"),
    ["runtime", "serve"],
    { ...env, STUDIO_CONFIG: runtimeConfig },
  );
  const runtimeDeadline = Date.now() + 10_000;
  let runtimeInventory: { targets: { target: string; ready: boolean }[] } = {
    targets: [],
  };
  while (Date.now() < runtimeDeadline) {
    runtimeInventory = z
      .object({
        targets: z.array(z.object({ target: z.string(), ready: z.boolean() })),
      })
      .parse(
        JSON.parse(
          await run(
            process.execPath,
            [join(root, "scripts/lifecycle.mjs"), "inventory"],
            { env },
          ),
        ),
      );
    if (
      runtimeInventory.targets.some((target) =>
        target.target.startsWith("runtime:supervisor:"),
      )
    )
      break;
    await delay(20);
  }
  assert.ok(
    runtimeInventory.targets.some(
      (target) =>
        target.target.startsWith("runtime:supervisor:") && !target.ready,
    ),
    background.errors,
  );
  await assert.rejects(
    control(published.socket, {
      action: "checkpoint",
      expected_session: before.sessions[0],
      native_id: before.process.native_id,
      start_identity: before.process.start_identity,
      run_id: randomUUID(),
      checkpoint_directory: temporary,
      replacement_identity: status.installed_identity,
    }),
    /uncheckpointed-native-background-runtime-authority/u,
  );
  assert.equal(
    (await control(published.socket, { action: "verify" })).ready,
    true,
  );
  await background.stop();
  background = undefined;
  // The pinned Bash abort uses forced process-tree termination. An update
  // must refuse that owner and let this real native child settle naturally.
  const bash = first.rpc("bash", { command: "sleep 1" });
  await delay(100);
  await assert.rejects(
    control(published.socket, {
      action: "checkpoint",
      expected_session: before.sessions[0],
      native_id: before.process.native_id,
      start_identity: before.process.start_identity,
      run_id: randomUUID(),
      checkpoint_directory: temporary,
      replacement_identity: status.installed_identity,
    }),
    /native-Bash-dispatch-is-still-admitted/u,
  );
  await bash;
  assert.equal(
    (await control(published.socket, { action: "verify" })).ready,
    true,
  );
  await first.rpc("prompt", {
    message: "Begin the controlled interrupted fixture operation.",
  });
  const deadline = Date.now() + 15_000;
  while (requests === 0 && Date.now() < deadline) await delay(20);
  assert.equal(requests, 1, first.errors);
  const nextSource = join(temporary, "next-source");
  await run("python3", [join(root, "scripts/export.py"), nextSource], { env });
  const nextReadme = join(nextSource, "README.md");
  await writeFile(
    nextReadme,
    `${await readFile(nextReadme, "utf8")}\nNative activation fixture selects a distinct immutable bundle.\n`,
  );
  await run(
    process.execPath,
    [join(nextSource, "scripts/lifecycle.mjs"), "build"],
    { env, timeout: 180_000 },
  );
  const replacement = z
    .object({ installed_identity: z.string(), installed_release: z.string() })
    .parse(
      JSON.parse(
        await run(
          process.execPath,
          [join(nextSource, "scripts/lifecycle.mjs"), "status"],
          { env },
        ),
      ),
    );
  assert.notEqual(replacement.installed_identity, status.installed_identity);
  assert.equal(
    (await control(published.socket, { action: "verify" })).running_identity,
    status.installed_identity,
    "installation must not be mistaken for the running host",
  );
  const admitted = await control(published.socket, { action: "inventory" });
  const checkpoints = join(temporary, "checkpoints");
  await mkdir(checkpoints, { mode: 0o700 });
  const runId = randomUUID();
  const request = {
    action: "checkpoint",
    expected_session: admitted.sessions[0],
    native_id: admitted.process.native_id,
    start_identity: admitted.process.start_identity,
    run_id: runId,
    checkpoint_directory: checkpoints,
    replacement_identity: replacement.installed_identity,
  };
  const confirmed = await control(published.socket, request);
  assert.equal(confirmed.checkpoint?.state, "confirmed");
  assert.equal(confirmed.ready, false);
  const retainedPath = join(
    checkpoints,
    `studio-${admitted.process.native_id}.json`,
  );
  const retained = z
    .object({
      state: z.literal("confirmed"),
      interrupted: z.literal(true),
      session: z.object({
        transcript_path: z.string(),
        session_id: z.string(),
        branch_id: z.string().nullable(),
        pre_checkpoint_branch_id: z.string().nullable(),
      }),
    })
    .parse(JSON.parse(await readFile(retainedPath, "utf8")));
  assert.equal(
    retained.session.pre_checkpoint_branch_id,
    admitted.sessions[0]?.branch_id,
  );
  assert.equal(retained.session.branch_id, confirmed.sessions[0]?.branch_id);
  const fencedBash = join(temporary, "fenced-bash-effect");
  await assert.rejects(
    first.rpc("bash", { command: `touch ${JSON.stringify(fencedBash)}` }),
    /user Bash admission is suspended/u,
  );
  await assert.rejects(readFile(fencedBash), { code: "ENOENT" });
  await control(published.socket, request);
  assert.equal(
    requests,
    1,
    "repeated checkpoint observation must not replay the interrupted request",
  );
  await control(published.socket, {
    action: "stop",
    expected_session: admitted.sessions[0],
    native_id: admitted.process.native_id,
    start_identity: admitted.process.start_identity,
    run_id: runId,
  });
  await assert.rejects(
    control(published.socket, {
      action: "release",
      expected_session: admitted.sessions[0],
      native_id: admitted.process.native_id,
      start_identity: admitted.process.start_identity,
      run_id: runId,
    }),
    /native-Pi-stop-already-submitted/u,
  );
  const stoppedChild = first.child;
  await new Promise<void>((resolve) => {
    if (stoppedChild.exitCode !== null || stoppedChild.signalCode !== null) {
      resolve();
      return;
    }
    stoppedChild.once("close", () => {
      resolve();
    });
  });
  resumed = new Host(
    join(replacement.installed_release, "scripts/pi"),
    [
      ...args,
      "--session",
      retained.session.transcript_path,
      "/studio-activation-restore",
    ],
    { ...env, STUDIO_ACTIVATION_CHECKPOINT: retainedPath },
  );
  if (resumed.child.pid === undefined)
    throw new Error("Restored native Pi host did not start");
  const newRecord = await record(resumed.child.pid);
  await resumed.rpc("prompt", { message: "/studio-activation-restore" });
  let restored = await control(newRecord.socket, { action: "verify" });
  const restoredDeadline = Date.now() + 10_000;
  while (!restored.ready && Date.now() < restoredDeadline) {
    await delay(20);
    restored = await control(newRecord.socket, { action: "verify" });
  }
  assert.equal(restored.ready, true, resumed.errors);
  assert.equal(restored.running_identity, replacement.installed_identity);
  const restoredSession = restored.sessions[0];
  if (restoredSession === undefined)
    throw new Error("The native restored session is missing");
  assert.equal(restoredSession.session_id, retained.session.session_id);
  assert.equal(
    restoredSession.transcript_path,
    retained.session.transcript_path,
  );
  assert.equal(restoredSession.branch_id, retained.session.branch_id);
  assert.equal(restoredSession.restoration, "restored");
  assert.equal(
    requests,
    1,
    "restoring the native conversation must not replay model work",
  );
  console.log(
    "Native Pi cancellation, immutable bundle and mapped shared-host identity, exact transcript/branch restoration, changed-process and active-subprocess refusal, and no replay passed.",
  );
} finally {
  await background?.stop();
  await resumed?.stop();
  await first?.stop();
  provider.closeAllConnections();
  await new Promise<void>((resolve) => {
    provider.close(() => {
      resolve();
    });
  });
  await rm(temporary, { recursive: true, force: true });
}
