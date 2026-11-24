import {
  nativeBashAdmission,
  registerNativeBashAdmission,
} from "./activation-bash.ts";
import { mappedHost, runtimeIdentity } from "./scripts/host-identity.mjs";
import { backgroundAuthorities } from "./activation-background.ts";
import { Zellij } from "./zellij.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  openSync,
  fsyncSync,
  closeSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { type Attempts, Phase, stateDirectory } from "./attempts.ts";
import { packageRoot } from "./package-resources.ts";
import { processStart } from "./process.ts";

const checkpointSchema = z.object({
  schema_version: z.literal(1),
  run_id: z.uuid(),
  target: z.string().min(1),
  process: z.object({
    pid: z.number().int().positive(),
    start_identity: z.string().min(1),
    native_id: z.uuid(),
    owner_verified: z.literal(true),
  }),
  replacement_identity: z.string().min(1),
  session: z.object({
    session_id: z.string().min(1),
    transcript_path: z.string().refine(isAbsolute),
    branch_id: z.string().nullable(),
    pre_checkpoint_branch_id: z.string().nullable().optional(),
    cwd: z.string().refine(isAbsolute),
    editor_text: z.string(),
    recoverable_inputs: z.array(z.string()).optional(),
    attempt_id: z.uuid().optional(),
    model: z
      .object({
        provider: z.string().min(1),
        id: z.string().min(1),
        thinking: z.string().min(1),
      })
      .optional(),
    launch_environment: z.record(z.string(), z.string()).optional(),
    zellij_identity: z.string().optional(),
  }),
  state: z.enum(["requested", "confirmed", "refused"]),
  interrupted: z.boolean(),
  stop_submitted: z.boolean().optional(),
  reason: z.string().optional(),
});
const requestSchema = z.object({
  action: z.enum(["inventory", "verify", "checkpoint", "stop", "release"]),
  run_id: z.uuid().optional(),
  native_id: z.uuid().optional(),
  start_identity: z.string().optional(),
  checkpoint_directory: z.string().refine(isAbsolute).optional(),
  replacement_identity: z.string().min(1).optional(),
  expected_session: z
    .object({
      session_id: z.string().min(1),
      transcript_path: z.string().refine(isAbsolute),
      branch_id: z.string().nullable(),
      cwd: z.string().refine(isAbsolute),
    })
    .optional(),
});
type Checkpoint = z.infer<typeof checkpointSchema>;
type Request = z.infer<typeof requestSchema>;
const installationSchema = z.object({
  sha256: z.string().min(1),
  minimum: z.string().regex(/^>=\d+\.\d+\.\d+$/u),
  files: z.array(z.string()),
});

function privateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error(`Studio lifecycle directory is not private: ${directory}`);
}

function save(path: string, value: unknown): void {
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    )
      throw new Error("Preserving unexpected lifecycle file");
  }
  const staged = `${path}.${randomUUID()}`;
  try {
    writeFileSync(staged, `${JSON.stringify(value)}\n`, {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    renameSync(staged, path);
    const parent = openSync(join(path, ".."), "r");
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  } finally {
    if (existsSync(staged)) unlinkSync(staged);
  }
}

export function loadedIdentity(): string {
  const hash = createHash("sha256");
  const installation = join(packageRoot, "installation.json");
  if (existsSync(installation)) {
    const record = installationSchema.parse(
      JSON.parse(readFileSync(installation, "utf8")),
    );
    for (const name of record.files) {
      if (isAbsolute(name) || name.split(/[\\/]/u).includes(".."))
        throw new Error("Invalid installed lifecycle manifest");
      const file = join(packageRoot, name);
      const info = lstatSync(file);
      hash
        .update(name)
        .update("\0")
        .update(String(info.mode & 0o777))
        .update(info.isSymbolicLink() ? "link" : "file")
        .update("\0");
      hash
        .update(info.isSymbolicLink() ? readlinkSync(file) : readFileSync(file))
        .update("\0");
    }
    if (hash.digest("hex") !== record.sha256)
      throw new Error("Loaded Studio bundle differs from its installation");
    const host = mappedHost().sha256;
    const cli = process.argv[1];
    const pinnedCLI = join(
      packageRoot,
      "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    );
    const actualCLI =
      cli !== undefined && existsSync(cli)
        ? createHash("sha256").update(readFileSync(cli)).digest("hex")
        : null;
    const expectedCLI = createHash("sha256")
      .update(readFileSync(pinnedCLI))
      .digest("hex");
    return actualCLI === expectedCLI
      ? runtimeIdentity(record.sha256, host, record.minimum)
      : `unmanaged-host:${record.sha256}:${host}:${actualCLI ?? "unknown"}`;
  }
  for (const name of ["activation.ts", "extension.ts", "worker-extension.ts"])
    hash.update(readFileSync(join(packageRoot, name)));
  hash.update(readFileSync(process.execPath));
  return `source:${hash.digest("hex")}`;
}

// Pi's pinned shell abort force-kills process trees. Refuse those owners until
// they settle naturally instead of routing an update cancellation through it.
function hasNativeChildren(): boolean {
  const observed = spawnSync("ps", ["-axo", "pid=,ppid="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  if (observed.error !== undefined || observed.status !== 0)
    throw new Error("Native subprocess ownership inspection unavailable");
  return observed.stdout.split("\n").some((line) => {
    const [pid, parent] = line.trim().split(/\s+/u).map(Number);
    return parent === process.pid && pid !== observed.pid;
  });
}

function readCheckpoint(path: string): Checkpoint {
  const info = lstatSync(path);
  if (
    !info.isFile() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0 ||
    info.size > 4 * 1024 * 1024
  )
    throw new Error("Lifecycle checkpoint is not private and owned");
  return checkpointSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export async function recoverManagedBinding(
  ctx: ExtensionContext,
  db: Attempts,
  id: string,
): Promise<void> {
  const path = process.env["STUDIO_ACTIVATION_CHECKPOINT"];
  if (path === undefined) return;
  const checkpoint = readCheckpoint(path);
  if (
    checkpoint.state !== "confirmed" ||
    checkpoint.replacement_identity !== loadedIdentity() ||
    checkpoint.session.session_id !== ctx.sessionManager.getSessionId() ||
    checkpoint.session.transcript_path !==
      ctx.sessionManager.getSessionFile() ||
    checkpoint.session.cwd !== ctx.cwd ||
    checkpoint.session.attempt_id !== id
  )
    throw new Error(
      "Restored managed session differs from its confirmed checkpoint",
    );
  try {
    if (
      (await processStart(checkpoint.process.pid)) ===
      checkpoint.process.start_identity
    )
      throw new Error("The previous Pi owner has not exited");
  } catch (error) {
    let absent = false;
    try {
      process.kill(checkpoint.process.pid, 0);
    } catch (probe) {
      absent = z.object({ code: z.literal("ESRCH") }).safeParse(probe).success;
    }
    if (!absent) throw error;
  }
  db.change(id, (record) => {
    if (record.pid === process.pid) return;
    if (
      record.pid !== checkpoint.process.pid ||
      record.processStarted !== checkpoint.process.start_identity ||
      record.transcript !== checkpoint.session.transcript_path ||
      ![Phase.Running, Phase.Verified, Phase.CheckFailed].includes(record.phase)
    )
      throw new Error("Managed attempt binding changed after checkpoint");
    if (
      record.phase === Phase.Running ||
      record.phase === Phase.Verified ||
      record.phase === Phase.CheckFailed
    )
      record.resumePhase = record.phase;
    else
      throw new Error(
        "Attempt phase cannot be restored without reconciliation",
      );
    record.phase = Phase.Launching;
    record.pid = null;
    record.pane = null;
    record.processStarted = null;
    record.zellijSocket = new Zellij(record.session).identity;
    record.live = false;
    record.message = "Restoring the confirmed Pi conversation without replay";
  });
}

let registered = false;
interface ActivationAdmissionState {
  fenced: () => boolean;
  pending: number;
  apis: WeakSet<ExtensionAPI>;
}
declare global {
  var studioActivationAdmissionState: ActivationAdmissionState | undefined;
}
globalThis.studioActivationAdmissionState ??= {
  fenced: () => process.env["STUDIO_ACTIVATION_CHECKPOINT"] !== undefined,
  pending: 0,
  apis: new WeakSet<ExtensionAPI>(),
};
const admission = globalThis.studioActivationAdmissionState;
export function registerActivationAdmission(pi: ExtensionAPI): void {
  if (admission.apis.has(pi)) return;
  admission.apis.add(pi);
  const register = pi.registerCommand.bind(pi);
  pi.registerCommand = (name, options) => {
    register(name, {
      ...options,
      handler: async (argument, ctx) => {
        if (admission.fenced() && name !== "studio-activation-restore") {
          ctx.ui.notify(
            "Studio is checkpointed; command admission is suspended",
            "warning",
          );
          return;
        }
        admission.pending++;
        try {
          await options.handler(argument, ctx);
        } finally {
          admission.pending--;
        }
      },
    });
  };
}
export function registerActivation(
  pi: ExtensionAPI,
  blocked: (ctx: ExtensionContext) => boolean,
): void {
  if (registered) return;
  registered = true;
  const incarnation = randomUUID();
  let restoring = false;
  let context: ExtensionContext | undefined;
  let server: Server | undefined;
  let identity: string | undefined;
  let started: string | undefined;
  let checkpoint: Checkpoint | undefined;
  let checkpointPath: string | undefined;
  let fenced = admission.fenced();
  admission.fenced = () => fenced;
  registerNativeBashAdmission(() => fenced);
  let stopSubmitted = false;
  let shutdownScheduled = false;
  let restored = false;
  let restoredCheckpoint:
    | { run_id: string; process: Checkpoint["process"] }
    | undefined;
  const releasedRuns = new Set<string>();
  const tools = new Set<string>();
  const directory = join(stateDirectory(), "activation");
  const socketPath = join(
    directory,
    `${String(process.pid)}-${incarnation.slice(0, 8)}.sock`,
  );
  const metadataPath = join(directory, `${incarnation}.json`);

  const session = (ctx: ExtensionContext) => ({
    session_id: ctx.sessionManager.getSessionId(),
    transcript_path: ctx.sessionManager.getSessionFile(),
    branch_id: ctx.sessionManager.getLeafId(),
    cwd: ctx.cwd,
    editor_text: ctx.mode === "tui" ? ctx.ui.getEditorText() : "",
    ...(ctx.model === undefined
      ? {}
      : {
          model: {
            provider: ctx.model.provider,
            id: ctx.model.id,
            thinking: pi.getThinkingLevel(),
          },
        }),
    launch_environment: Object.fromEntries(
      ["PI_CODING_AGENT_DIR", "STUDIO_CONFIG", "STUDIO_STATE_DIR"].flatMap(
        (key) => {
          const value = process.env[key];
          return value === undefined ? [] : [[key, value]];
        },
      ),
    ),
    ...(process.env["ZELLIJ_SESSION_NAME"] === undefined
      ? {}
      : {
          zellij_identity: new Zellij(process.env["ZELLIJ_SESSION_NAME"])
            .identity,
        }),
    ...(process.env["STUDIO_ATTEMPT"] === undefined
      ? {}
      : { attempt_id: process.env["STUDIO_ATTEMPT"] }),
  });
  const target = () => {
    if (
      context === undefined ||
      identity === undefined ||
      started === undefined
    )
      throw new Error("Studio runtime has not initialized");
    mappedHost();
    const current = session(context);
    const publicSession = {
      session_id: current.session_id,
      transcript_path: current.transcript_path,
      branch_id: current.branch_id,
      cwd: current.cwd,
      ...(current.attempt_id === undefined
        ? {}
        : { attempt_id: current.attempt_id }),
    };
    return {
      target: `pi:${current.session_id}`,
      running_identity: identity,
      checkpoint_binding: "exact-session-v1",
      admitted_commands: admission.pending,
      admitted_bash_dispatches: nativeBashAdmission().pending,
      uncertain_bash_authority: nativeBashAdmission().uncertain,
      ...(restoredCheckpoint === undefined
        ? {}
        : { restored_checkpoint: restoredCheckpoint }),
      ready: !fenced,
      terminal_environment: Object.fromEntries(
        ["TERM", "COLORTERM", "NO_COLOR", "GIT_PAGER"].map((key) => [
          key,
          process.env[key] ?? null,
        ]),
      ),
      process: {
        pid: process.pid,
        start_identity: started,
        native_id: incarnation,
        owner_verified: true,
      },
      sessions: [
        {
          ...publicSession,
          ...(checkpoint?.session.pre_checkpoint_branch_id === undefined
            ? {}
            : {
                pre_checkpoint_branch_id:
                  checkpoint.session.pre_checkpoint_branch_id,
              }),
          restoration: fenced ? "pending" : restored ? "restored" : "unchanged",
        },
      ],
      ...(checkpoint === undefined
        ? {}
        : {
            checkpoint: { state: checkpoint.state, run_id: checkpoint.run_id },
          }),
      ...(process.env["ZELLIJ_SESSION_NAME"] === undefined
        ? {}
        : {
            restoration_owner: {
              project: "zellij",
              target: process.env["ZELLIJ_SESSION_NAME"],
              pane_id: Number(process.env["ZELLIJ_PANE_ID"]),
            },
          }),
    };
  };
  const publish = (): void => {
    save(metadataPath, { schema_version: 1, socket: socketPath, ...target() });
  };
  const command = async (request: Request) => {
    if (context === undefined) throw new Error("Studio runtime is unavailable");
    const current = target();
    if (request.action === "inventory" || request.action === "verify")
      return current;
    if (
      ["checkpoint", "stop"].includes(request.action) &&
      backgroundAuthorities().length > 0
    )
      throw new Error("uncheckpointed-native-background-runtime-authority");
    if (
      ["checkpoint", "stop"].includes(request.action) &&
      admission.pending > 0
    )
      throw new Error("native-async-command-is-still-admitted");
    if (["checkpoint", "stop"].includes(request.action)) {
      const bash = nativeBashAdmission();
      if (
        !bash.intact ||
        process.argv[1] !==
          join(
            packageRoot,
            "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
          )
      )
        throw new Error("native-host-Bash-admission-boundary-unavailable");
      if (bash.pending > 0)
        throw new Error(
          bash.uncertain
            ? "native-Bash-authority-has-uncertain-outcomes"
            : "native-Bash-dispatch-is-still-admitted",
        );
    }
    if (stopSubmitted) throw new Error("native-Pi-stop-already-submitted");
    if (request.native_id !== incarnation || request.start_identity !== started)
      throw new Error("Studio process incarnation changed");
    const expected = request.expected_session;
    const observed = session(context);
    if (
      expected === undefined ||
      expected.session_id !== observed.session_id ||
      expected.transcript_path !== observed.transcript_path ||
      expected.cwd !== observed.cwd ||
      expected.branch_id !==
        (checkpoint === undefined ||
        (!fenced && releasedRuns.has(checkpoint.run_id))
          ? observed.branch_id
          : checkpoint.session.pre_checkpoint_branch_id)
    )
      throw new Error(
        "Native Pi conversation binding changed before activation",
      );
    if (request.action === "checkpoint") {
      if (
        request.run_id === undefined ||
        request.checkpoint_directory === undefined ||
        request.replacement_identity === undefined
      )
        throw new Error(
          "Checkpoint needs an operation, selected artifact and private directory",
        );
      if (releasedRuns.has(request.run_id)) return current;
      if (
        checkpoint !== undefined &&
        checkpoint.run_id !== request.run_id &&
        !fenced &&
        releasedRuns.has(checkpoint.run_id)
      ) {
        checkpoint = undefined;
        checkpointPath = undefined;
      }
      if (checkpoint !== undefined && checkpoint.run_id !== request.run_id)
        throw new Error(
          "An earlier checkpoint still owns this Pi conversation",
        );
      if (checkpoint === undefined) {
        if (tools.size > 0 || hasNativeChildren())
          throw new Error("active-native-tool-or-child-lacks-safe-checkpoint");
        if (context.hasPendingMessages() || blocked(context))
          throw new Error(
            "queued-input-or-unsettled-child-cannot-be-checkpointed",
          );
        const snapshot = session(context);
        if (snapshot.transcript_path === undefined)
          throw new Error("Pi transcript persistence is disabled");
        if (!existsSync(snapshot.transcript_path))
          throw new Error("native-Pi-conversation-has-not-been-persisted");
        const transcript = openSync(snapshot.transcript_path, "r");
        try {
          fsyncSync(transcript);
        } finally {
          closeSync(transcript);
        }
        privateDirectory(request.checkpoint_directory);
        checkpointPath = join(
          request.checkpoint_directory,
          `studio-${incarnation}.json`,
        );
        checkpoint = checkpointSchema.parse({
          schema_version: 1,
          run_id: request.run_id,
          target: current.target,
          process: current.process,
          replacement_identity: request.replacement_identity,
          session: {
            ...snapshot,
            pre_checkpoint_branch_id: snapshot.branch_id,
          },
          state: "requested",
          interrupted: !context.isIdle() || tools.size > 0,
        });
        save(checkpointPath, checkpoint);
        fenced = true;
        // The durable intent precedes the single cancellation request.
        context.abort();
      }
      const deadline = Date.now() + 58_000;
      while ((!context.isIdle() || tools.size > 0) && Date.now() < deadline)
        await delay(20);
      if (
        context.hasPendingMessages() ||
        blocked(context) ||
        hasNativeChildren() ||
        !context.isIdle() ||
        tools.size > 0
      ) {
        checkpoint.state = "refused";
        checkpoint.reason = "cancellation-not-settled";
      } else {
        const finalTranscript = openSync(
          checkpoint.session.transcript_path,
          "r",
        );
        try {
          fsyncSync(finalTranscript);
        } finally {
          closeSync(finalTranscript);
        }
        checkpoint.state = "confirmed";
        checkpoint.session = checkpointSchema.shape.session.parse({
          ...session(context),
          pre_checkpoint_branch_id: checkpoint.session.pre_checkpoint_branch_id,
        });
      }
      if (checkpointPath === undefined)
        throw new Error("Checkpoint path is unavailable");
      save(checkpointPath, checkpoint);
      publish();
      return target();
    }
    if (
      checkpoint?.state !== "confirmed" ||
      checkpoint.run_id !== request.run_id
    )
      throw new Error("A confirmed checkpoint for this operation is required");
    if (
      request.action === "stop" &&
      context.mode === "rpc" &&
      process.argv[1] !==
        join(
          packageRoot,
          "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
        )
    )
      throw new Error("native-RPC-host-shutdown-control-unavailable");
    if (
      request.action === "stop" &&
      (!context.isIdle() ||
        tools.size > 0 ||
        context.hasPendingMessages() ||
        blocked(context) ||
        hasNativeChildren())
    )
      throw new Error("native-owner-changed-after-checkpoint");
    if (request.action === "stop") {
      const latest = session(context);
      if (
        latest.session_id !== checkpoint.session.session_id ||
        latest.transcript_path !== checkpoint.session.transcript_path ||
        latest.branch_id !== checkpoint.session.branch_id ||
        latest.cwd !== checkpoint.session.cwd
      )
        throw new Error("native-conversation-moved-after-checkpoint");
      stopSubmitted = true;
      checkpoint.stop_submitted = true;
      checkpoint.session.editor_text = latest.editor_text;
      if (checkpointPath === undefined)
        throw new Error("Checkpoint path unavailable");
      save(checkpointPath, checkpoint);
    }
    if (request.action === "release") {
      fenced = false;
      restored = true;
      releasedRuns.add(checkpoint.run_id);
      publish();
    }
    return target();
  };

  const serve = (connection: Socket) => {
    let buffer = "";
    connection.setTimeout(60_000, () => connection.destroy());
    connection.on("error", () => {});
    connection.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 16_384) {
        connection.destroy();
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      connection.removeAllListeners("data");
      let request: Request;
      try {
        request = requestSchema.parse(JSON.parse(buffer.slice(0, newline)));
      } catch {
        connection.end('{"error":"invalid-lifecycle-request"}\n');
        return;
      }
      command(request)
        .then((value) => {
          connection.end(
            `${JSON.stringify({ schema_version: 1, targets: [value] })}\n`,
            () => {
              if (
                request.action === "stop" &&
                stopSubmitted &&
                !shutdownScheduled &&
                tools.size === 0 &&
                context?.isIdle() === true &&
                !hasNativeChildren()
              ) {
                // Pi's pinned CLI registers SIGTERM as graceful runtime disposal.
                // RPC ctx.shutdown only settles after a subsequent RPC command;
                // this native endpoint must not depend on that caller transport.
                shutdownScheduled = true;
                const nativeHost = join(
                  packageRoot,
                  "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
                );
                if (process.argv[1] === nativeHost)
                  process.kill(process.pid, "SIGTERM");
                else context.shutdown();
              }
            },
          );
        })
        .catch((cause: unknown) => {
          connection.end(
            `${JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) })}\n`,
          );
        });
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    identity ??= loadedIdentity();
    started ??= await processStart(process.pid);
    privateDirectory(directory);
    if (server === undefined) {
      server = createServer(serve);
      await new Promise<void>((resolve, reject) => {
        const active = server;
        if (active === undefined) {
          reject(new Error("Lifecycle server unavailable"));
          return;
        }
        active.once("error", reject);
        active.listen(socketPath, () => {
          active.off("error", reject);
          resolve();
        });
      });
    }
    publish();
  });
  const refresh = (ctx: ExtensionContext): void => {
    context = ctx;
    if (server !== undefined) publish();
  };
  pi.on("session_before_switch", () => (fenced ? { cancel: true } : undefined));
  pi.on("session_before_fork", () => (fenced ? { cancel: true } : undefined));
  pi.on("session_before_compact", () =>
    fenced ? { cancel: true } : undefined,
  );
  pi.on("session_before_tree", () =>
    fenced && !restoring ? { cancel: true } : undefined,
  );
  pi.on("session_tree", (_event, ctx) => {
    refresh(ctx);
  });
  pi.on("session_compact", (_event, ctx) => {
    refresh(ctx);
  });
  pi.on("agent_settled", (_event, ctx) => {
    refresh(ctx);
  });
  pi.on("tool_execution_start", (event) => {
    tools.add(event.toolCallId);
  });
  pi.on("tool_execution_end", (event) => {
    tools.delete(event.toolCallId);
  });
  pi.on("input", (event) => {
    if (!fenced) return undefined;
    if (checkpoint !== undefined && checkpointPath !== undefined) {
      checkpoint.session.recoverable_inputs ??= [];
      checkpoint.session.recoverable_inputs.push(event.text);
      save(checkpointPath, checkpoint);
    }
    return { action: "handled" };
  });
  pi.on("user_bash", () => {
    if (fenced)
      throw new Error(
        "Studio is checkpointed; user Bash admission is suspended",
      );
  });
  pi.on("before_provider_request", () => {
    if (fenced)
      throw new Error(
        "Studio is checkpointed; interrupted work is not replayed",
      );
  });
  pi.on("tool_call", () =>
    fenced ? { block: true, reason: "Studio is checkpointed" } : undefined,
  );
  pi.registerCommand("studio-activation-restore", {
    description:
      "Restore the confirmed native checkpoint without replaying operations",
    handler: async (_argument, ctx) => {
      const path = process.env["STUDIO_ACTIVATION_CHECKPOINT"];
      if (path === undefined)
        throw new Error("A private activation checkpoint is required");
      const retained = readCheckpoint(path);
      if (
        retained.state !== "confirmed" ||
        retained.replacement_identity !== identity ||
        retained.session.session_id !== ctx.sessionManager.getSessionId() ||
        retained.session.transcript_path !==
          ctx.sessionManager.getSessionFile() ||
        retained.session.cwd !== ctx.cwd
      )
        throw new Error(
          "Restored Pi runtime differs from the confirmed checkpoint",
        );
      if (
        retained.session.branch_id !== null &&
        retained.session.branch_id !== ctx.sessionManager.getLeafId()
      ) {
        restoring = true;
        try {
          const result = await ctx.navigateTree(retained.session.branch_id, {
            summarize: false,
          });
          if (result.cancelled)
            throw new Error("Native Pi branch restoration was refused");
        } finally {
          restoring = false;
        }
      }
      if (ctx.sessionManager.getLeafId() !== retained.session.branch_id)
        throw new Error("Native Pi restored another transcript branch");
      if (ctx.mode === "tui") {
        const draft = [
          ...(retained.session.recoverable_inputs ?? []),
          retained.session.editor_text,
        ]
          .filter((text) => text.length > 0)
          .join("\n\n");
        ctx.ui.setEditorText(draft);
        if (ctx.ui.getEditorText() !== draft)
          throw new Error(
            "Native Pi recoverable editor input was not restored",
          );
      }
      context = ctx;
      restoredCheckpoint = {
        run_id: retained.run_id,
        process: retained.process,
      };
      restored = true;
      fenced = false;
      delete process.env["STUDIO_ACTIVATION_CHECKPOINT"];
      publish();
    },
  });
  pi.on("session_shutdown", async () => {
    await new Promise<void>((resolve) => {
      if (server === undefined) {
        resolve();
        return;
      }
      server.close(() => {
        resolve();
      });
    });
    server = undefined;
    registered = false;
    for (const path of [socketPath, metadataPath])
      if (existsSync(path)) unlinkSync(path);
  });
}
