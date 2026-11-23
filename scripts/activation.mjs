import { backgroundAuthorities } from "../activation-background.ts";
import { createConnection } from "node:net";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const state = () =>
  process.env.STUDIO_STATE_DIR ??
  join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "studio");
function privateJSON(path) {
  const info = lstatSync(path);
  if (
    !info.isFile() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o077) !== 0 ||
    info.size > 4 * 1024 * 1024
  )
    throw new Error("Studio lifecycle file is not private and owned");
  return JSON.parse(readFileSync(path, "utf8"));
}
function save(path, value) {
  const temporary = `${path}.${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify(value) + "\n", {
    flag: "wx",
    mode: 0o600,
    flush: true,
  });
  renameSync(temporary, path);
}
function call(socket, request, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socket);
    let received = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      connection.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    connection.setTimeout(timeout, () =>
      finish(new Error("native-control-outcome-unknown")),
    );
    connection.on("error", (error) => finish(error));
    connection.on("close", () => {
      if (!settled) finish(new Error("native-control-outcome-unknown"));
    });
    connection.on("connect", () =>
      connection.write(JSON.stringify(request) + "\n"),
    );
    connection.on("data", (chunk) => {
      received += chunk.toString("utf8");
      if (received.length > 4 * 1024 * 1024) {
        finish(new Error("native-control-response-too-large"));
        return;
      }
      if (!received.includes("\n")) return;
      try {
        const value = JSON.parse(received.slice(0, received.indexOf("\n")));
        if (value.error) finish(new Error(value.error));
        else if (value.schema_version !== 1 || value.targets?.length !== 1)
          finish(new Error("invalid-native-control-response"));
        else finish(null, value.targets[0]);
      } catch (error) {
        finish(error);
      }
    });
  });
}
function processStart(pid) {
  const output = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  if (output.status === 0 && output.stdout.trim()) return output.stdout.trim();
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return null;
  }
  throw new Error("native-process-start-identity-unavailable");
}
function legacyProcesses(known, expected) {
  const output = spawnSync("ps", ["-axo", "pid=,uid=,comm=,args="], {
    encoding: "utf8",
  });
  if (output.status !== 0)
    throw new Error("Pi-process-ownership-inventory-unavailable");
  return output.stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/u);
    if (
      !match ||
      Number(match[2]) !== process.getuid() ||
      known.has(Number(match[1])) ||
      Number(match[1]) === process.pid ||
      !/(?:pi-coding-agent|scripts\/pi-host|\/pi(?:\s|$))/u.test(match[4])
    )
      return [];
    return [
      {
        target: `legacy-pi:${match[1]}`,
        expected_identity: expected,
        running_identity: null,
        ready: false,
        process: {
          pid: Number(match[1]),
          start_identity: processStart(Number(match[1])) ?? "",
          native_id: "",
          owner_verified: true,
        },
        sessions: [],
        reason: "legacy-pi-has-no-trustworthy-checkpoint",
      },
    ];
  });
}
async function inventory(installation) {
  const directory = join(state(), "activation");
  const records = [];
  if (existsSync(directory)) {
    const info = lstatSync(directory);
    if (
      !info.isDirectory() ||
      info.uid !== process.getuid() ||
      (info.mode & 0o077) !== 0
    )
      throw new Error("Studio activation directory is not private and owned");
    for (const name of readdirSync(directory).filter((name) =>
      name.endsWith(".json"),
    )) {
      const record = privateJSON(join(directory, name));
      if (
        record.schema_version !== 1 ||
        !record.process?.pid ||
        processStart(record.process.pid) !== record.process.start_identity
      )
        continue; // A retained dead-process record is not a running target.
      try {
        const target = await call(record.socket, { action: "inventory" });
        if (JSON.stringify(target.process) !== JSON.stringify(record.process))
          throw new Error("native-runtime-incarnation-differs");
        records.push({
          ...target,
          expected_identity: installation.installed_identity,
          control_socket: record.socket,
        });
      } catch (error) {
        records.push({
          ...record,
          expected_identity: installation.installed_identity,
          running_identity: null,
          ready: false,
          sessions: record.sessions ?? [],
          reason: error.message,
          control_socket: record.socket,
        });
      }
    }
  }
  records.push(
    ...backgroundAuthorities().map((authority) => ({
      ...authority,
      expected_identity: installation.installed_identity,
      running_identity: null,
      ready: false,
    })),
  );
  records.push(
    ...legacyProcesses(
      new Set(
        records
          .filter((target) => target.process !== null)
          .map((target) => target.process.pid),
      ),
      installation.installed_identity,
    ),
  );
  return records.length > 0
    ? records
    : [
        {
          target: "local",
          expected_identity: installation.installed_identity,
          running_identity: installation.installed_identity,
          ready: installation.installed_identity !== null,
          process: null,
          sessions: [],
          reason:
            installation.installed_identity === null
              ? "selected-studio-bundle-not-installed"
              : undefined,
        },
      ];
}
function frozen() {
  const directory = process.env.PROJECT_UPDATE_OPERATION_DIR;
  if (!directory)
    throw new Error("A detached update operation is required for activation");
  const value = privateJSON(join(directory, "studio-inventory.json"));
  if (value.schema_version !== 1 || !Array.isArray(value.targets))
    throw new Error("Frozen Studio inventory is invalid");
  return value.targets;
}
function selectedTargets(targets) {
  const selected = process.env.PROJECT_UPDATE_TARGET;
  return selected
    ? targets.filter((target) => target.target === selected)
    : targets;
}
export async function activation(action, installation) {
  if (["inventory", "verify"].includes(action)) {
    const targets = await inventory(installation);
    if (action === "verify" && process.env.PROJECT_UPDATE_OPERATION_DIR) {
      const directory = process.env.PROJECT_UPDATE_OPERATION_DIR;
      const proofs = readdirSync(directory)
        .filter(
          (name) =>
            name.startsWith("zellij-restored-") && name.endsWith(".json"),
        )
        .flatMap(
          (name) =>
            privateJSON(join(directory, name)).restored_applications ?? [],
        )
        .filter((proof) => proof.project === "studio");
      for (const target of targets) {
        const bindings = proofs.filter(
          (proof) => proof.target === target.target,
        );
        const expected =
          process.env.PROJECT_UPDATE_TARGET === target.target &&
          process.env.PROJECT_UPDATE_EXPECTED_PROCESS
            ? JSON.parse(process.env.PROJECT_UPDATE_EXPECTED_PROCESS)
            : null;
        if (
          (expected &&
            JSON.stringify(expected) !== JSON.stringify(target.process)) ||
          bindings.length > 1 ||
          (bindings.length === 1 &&
            (JSON.stringify(bindings[0].process) !==
              JSON.stringify(target.process) ||
              target.restored_checkpoint?.run_id !==
                process.env.PROJECT_UPDATE_RUN_ID ||
              JSON.stringify(target.restored_checkpoint?.process) !==
                JSON.stringify(bindings[0].original_process) ||
              !target.sessions.some((session) =>
                Object.entries(bindings[0].session).every(
                  ([key, value]) => session[key] === value,
                ),
              )))
        ) {
          target.ready = false;
          target.reason =
            "native-restored-Pi-incarnation-differs-from-retained-terminal-binding";
        }
      }
    }
    console.log(JSON.stringify({ schema_version: 1, targets }));
    return action === "inventory" ||
      targets.every(
        (target) =>
          target.expected_identity !== null &&
          target.expected_identity === target.running_identity &&
          target.ready &&
          target.sessions.every((session) =>
            ["restored", "unchanged"].includes(session.restoration),
          ),
      )
      ? 0
      : 3;
  }
  if (!process.env.PROJECT_UPDATE_OPERATION_DIR) {
    const targets = (await inventory(installation)).map((target) => ({
      ...target,
      ready: false,
      reason: "detached-operation-required-for-guarded-activation",
    }));
    console.log(JSON.stringify({ schema_version: 1, targets }));
    return 3;
  }
  const targets = selectedTargets(frozen());
  if (targets.length === 0)
    throw new Error("The selected Studio target was not inventoried");
  const results = [];
  let incomplete = false;
  for (const original of targets) {
    try {
      if (
        ["checkpoint", "restart"].includes(action) &&
        backgroundAuthorities().length > 0
      )
        throw new Error("uncheckpointed-native-background-runtime-authority");
      if (
        original.expected_identity !== installation.installed_identity ||
        installation.installed_identity === null
      )
        throw new Error("selected-studio-artifact-changed");
      if (original.process === null) {
        results.push({
          ...original,
          checkpoint: {
            state: "confirmed",
            run_id: process.env.PROJECT_UPDATE_RUN_ID,
          },
        });
        continue;
      }
      if (!original.control_socket || !original.process.native_id)
        throw new Error(
          original.reason ?? "native-Studio-checkpoint-unavailable",
        );
      if (original.checkpoint_binding !== "exact-session-v1")
        throw new Error(
          "legacy-native-Pi-exact-session-checkpoint-binding-unavailable",
        );
      const session = original.sessions[0];
      if (!session) throw new Error("native-Pi-session-binding-unavailable");
      const expectedSession = {
        session_id: session.session_id,
        transcript_path: session.transcript_path,
        branch_id:
          session.pre_checkpoint_branch_id !== undefined
            ? session.pre_checkpoint_branch_id
            : session.branch_id,
        cwd: session.cwd,
      };
      const guarded = {
        expected_session: expectedSession,
        run_id: process.env.PROJECT_UPDATE_RUN_ID,
        native_id: original.process.native_id,
        start_identity: original.process.start_identity,
      };
      const path = join(
        process.env.PROJECT_UPDATE_CHECKPOINT_DIR,
        `studio-${original.process.native_id}.json`,
      );
      if (action === "checkpoint") {
        const current = await call(original.control_socket, {
          action: "inventory",
        });
        if (
          JSON.stringify(current.process) !==
            JSON.stringify(original.process) ||
          current.running_identity !== original.running_identity ||
          current.target !== original.target ||
          current.checkpoint_binding !== "exact-session-v1"
        )
          throw new Error("Studio-process-or-loaded-artifact-changed");
        const target = await call(
          original.control_socket,
          {
            action: "checkpoint",
            ...guarded,
            checkpoint_directory: process.env.PROJECT_UPDATE_CHECKPOINT_DIR,
            replacement_identity: original.expected_identity,
          },
          59000,
        );
        results.push({
          ...target,
          expected_identity: original.expected_identity,
          control_socket: original.control_socket,
        });
        if (target.checkpoint?.state !== "confirmed") incomplete = true;
      } else if (
        action === "restore" &&
        process.env.PROJECT_UPDATE_DEFER_RESTORATION !== "1" &&
        original.running_identity === original.expected_identity &&
        !existsSync(
          join(
            process.env.PROJECT_UPDATE_OPERATION_DIR,
            `studio-stop-${original.process.native_id}.json`,
          ),
        )
      ) {
        const checkpoint = privateJSON(path);
        if (
          checkpoint.state !== "confirmed" ||
          checkpoint.run_id !== guarded.run_id ||
          checkpoint.target !== original.target ||
          JSON.stringify(checkpoint.process) !==
            JSON.stringify(original.process)
        )
          throw new Error("Studio-original-checkpoint-binding-differs");
        const receiptPath = join(
          process.env.PROJECT_UPDATE_OPERATION_DIR,
          `studio-release-${original.process.native_id}.json`,
        );
        let target;
        if (existsSync(receiptPath)) {
          target = await call(original.control_socket, { action: "inventory" });
          if (
            JSON.stringify(target.process) !==
              JSON.stringify(original.process) ||
            !target.ready ||
            target.running_identity !== original.running_identity
          )
            throw new Error("previous-Studio-release-outcome-unknown");
        } else {
          save(receiptPath, {
            state: "requested",
            run_id: checkpoint.run_id,
            process: original.process,
          });
          target = await call(original.control_socket, {
            action: "release",
            ...guarded,
          });
        }
        save(receiptPath, {
          state: "released",
          run_id: checkpoint.run_id,
          process: original.process,
        });
        results.push({
          ...target,
          expected_identity: original.expected_identity,
          control_socket: original.control_socket,
        });
      } else if (["restart", "restore"].includes(action)) {
        if (
          !original.restoration_owner ||
          process.env.PROJECT_UPDATE_DEFER_RESTORATION !== "1"
        )
          throw new Error(
            "native-terminal-or-RPC-transport-restoration-unavailable",
          );
        const checkpoint = privateJSON(path);
        if (
          checkpoint.state !== "confirmed" ||
          checkpoint.run_id !== process.env.PROJECT_UPDATE_RUN_ID ||
          checkpoint.target !== original.target ||
          JSON.stringify(checkpoint.process) !==
            JSON.stringify(original.process)
        )
          throw new Error("Studio-checkpoint-binding-differs");
        const receiptPath = join(
          process.env.PROJECT_UPDATE_OPERATION_DIR,
          `studio-stop-${original.process.native_id}.json`,
        );
        if (
          action === "restart" ||
          (action === "restore" && !existsSync(receiptPath))
        ) {
          if (existsSync(receiptPath)) {
            const receipt = privateJSON(receiptPath);
            if (receipt.state !== "stopped") {
              if (
                processStart(original.process.pid) ===
                original.process.start_identity
              )
                throw new Error("previous-Studio-stop-outcome-unknown");
              save(receiptPath, {
                state: "stopped",
                process: original.process,
                run_id: checkpoint.run_id,
              });
            }
          } else {
            save(receiptPath, {
              state: "requested",
              process: original.process,
              run_id: checkpoint.run_id,
            });
            await call(
              original.control_socket,
              { action: "stop", ...guarded },
              59000,
            );
            const deadline = Date.now() + 59000;
            while (
              processStart(original.process.pid) ===
                original.process.start_identity &&
              Date.now() < deadline
            )
              await new Promise((resolve) => setTimeout(resolve, 20));
            if (
              processStart(original.process.pid) ===
              original.process.start_identity
            )
              throw new Error("Pi-graceful-shutdown-not-confirmed");
            save(receiptPath, {
              state: "stopped",
              process: original.process,
              run_id: checkpoint.run_id,
            });
          }
          // One terminal restoration owner consumes this retained launch intent.
          save(
            join(
              process.env.PROJECT_UPDATE_CHECKPOINT_DIR,
              `studio-restore-${original.process.native_id}.json`,
            ),
            {
              ...checkpoint,
              restoration_owner: original.restoration_owner,
              restore_argv: [
                installation.selected_host.path,
                "--no-env-file",
                "--config=" +
                  join(installation.installed_release, "resources/bunfig.toml"),
                join(
                  installation.installed_release,
                  "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
                ),
                "--session",
                checkpoint.session.transcript_path,
                ...(checkpoint.session.model
                  ? [
                      "--model",
                      `${checkpoint.session.model.provider}/${checkpoint.session.model.id}`,
                      "--thinking",
                      checkpoint.session.model.thinking,
                    ]
                  : []),
                ...(checkpoint.session.attempt_id
                  ? [
                      "--extension",
                      join(
                        installation.installed_release,
                        "worker-extension.ts",
                      ),
                    ]
                  : []),
                "/studio-activation-restore",
              ],
              restore_env: {
                ...checkpoint.session.launch_environment,
                STUDIO_ACTIVATION_CHECKPOINT: path,
                ...(checkpoint.session.attempt_id
                  ? { STUDIO_ATTEMPT: checkpoint.session.attempt_id }
                  : {}),
              },
            },
          );
        }
        results.push({
          ...original,
          ready: false,
          running_identity: null,
          process: null,
          sessions: original.sessions.map((session) => ({
            ...session,
            restoration: "pending",
          })),
          reason: "restoration-owned-by-zellij",
        });
      } else throw new Error("Unsupported Studio activation action");
    } catch (error) {
      incomplete = true;
      results.push({
        ...original,
        ready: false,
        reason: error.message,
        checkpoint: {
          state: "refused",
          run_id: process.env.PROJECT_UPDATE_RUN_ID,
        },
      });
    }
  }
  console.log(JSON.stringify({ schema_version: 1, targets: results }));
  return incomplete ? 3 : 0;
}
