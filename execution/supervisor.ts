import { assertVerificationIsolation } from "./sandbox.ts";
import { reconcileAttempt, retainClaim, writerFence } from "./recovery.ts";
import { isDeepStrictEqual } from "node:util";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { requireIntegration } from "../integrations.ts";
import { packageRoot } from "../package-resources.ts";
import { processFailure, processStart } from "../process.ts";
import { owner } from "../task-service.ts";
import {
  ExecutionBeads,
  heartbeat,
  verifyHeartbeatAuthority,
} from "./beads.ts";
import {
  ExecutionStore,
  ExecutionPhase,
  executionSchema,
  unsettled,
  type Execution,
  type RuntimeProject,
} from "./store.ts";
import { assertRuntimeProfile } from "./profile.ts";

export async function alive(pid: number, started: string): Promise<boolean> {
  try {
    return (await processStart(pid)) === started;
  } catch (error) {
    if (processFailure(error).code === 1) return false;
    throw error;
  }
}
export async function ensureRuntime(): Promise<void> {
  const config = await loadConfig();
  if (!config.runtime.enabled) throw new Error("Studio runtime is disabled");
  const store = new ExecutionStore();
  try {
    const current = store.supervisor();
    if (current !== undefined && (await alive(current.pid, current.started))) {
      if (current.stop)
        throw new Error(
          "Runtime is stopping; inspect status before restarting",
        );
      return;
    }
    const log = openSync(join(store.directory, "runtime.log"), "a", 0o600);
    try {
      const child = spawn(
        join(packageRoot, "scripts/studio"),
        ["runtime", "serve"],
        { detached: true, stdio: ["ignore", log, log], cwd: packageRoot },
      );
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
    } finally {
      closeSync(log);
    }
  } finally {
    store.close();
  }
}
function overlaps(left: Execution, right: Execution): boolean {
  return (
    left.project === right.project &&
    (left.owns.length === 0 ||
      right.owns.length === 0 ||
      left.owns.some((a) =>
        right.owns.some(
          (b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`),
        ),
      ))
  );
}
export async function serveRuntime(signal?: AbortSignal): Promise<void> {
  const store = new ExecutionStore();
  const id = randomUUID();
  const started = await processStart(process.pid);
  const previous = store.supervisor();
  if (previous !== undefined && (await alive(previous.pid, previous.started))) {
    store.close();
    throw new Error("A live Studio runtime already owns scheduling");
  }
  store.transaction(() => {
    const current = store.supervisor();
    if (current?.id !== previous?.id)
      throw new Error("Another runtime won scheduling ownership");
    store.setSupervisor({ id, pid: process.pid, started, stop: false });
  });
  try {
    while (signal?.aborted !== true) {
      const control = store.supervisor();
      if (control?.id !== id || control.stop) break;
      const config = await loadConfig();
      if (!config.runtime.enabled) break;
      const projects = store.projects().filter((project) =>
        config.runtime.projects.some(
          (current) =>
            current.source.projectId === project.id &&
            realpathSync(current.root) === project.root &&
            isDeepStrictEqual(
              {
                ...current,
                id: project.id,
                root: project.root,
                merge: project.merge,
              },
              project,
            ),
        ),
      );
      for (const project of projects) {
        try {
          for (const attempt of store
            .attempts()
            .filter(
              (record) => record.project === project.id && unsettled(record),
            )) {
            try {
              await reconcileAttempt(store, project, attempt.id);
              const current = store.attempt(attempt.id);
              if (
                current.bead !== undefined &&
                current.phase !== ExecutionPhase.Complete &&
                Date.now() - current.heartbeatAt > 15000 &&
                (await heartbeat(project, current.id, current.bead.id))
              ) {
                store.change(current.id, (row) => {
                  row.heartbeatAt = Date.now();
                });
              }
            } catch (error) {
              store.change(attempt.id, (row) => {
                row.phase = ExecutionPhase.Uncertain;
                row.message = `This attempt needs reconciliation: ${processFailure(error).message}`;
              });
            }
          }
          await requireIntegration(config, "worktrees");
          const attempts = store.attempts();
          const live = [];
          for (const attempt of attempts)
            if (await writerFence(attempt)) live.push(attempt);
          for (const attempt of attempts.filter(
            (record) =>
              record.project === project.id &&
              record.phase === ExecutionPhase.Queued,
          )) {
            const position = attempts.findIndex((row) => row.id === attempt.id);
            const retainedConflict = attempts.some(
              (other, index) =>
                other.id !== attempt.id &&
                other.bead !== undefined &&
                other.phase !== ExecutionPhase.Complete &&
                (other.phase !== ExecutionPhase.Queued || index < position) &&
                overlaps(attempt, other),
            );
            if (
              live.filter(
                (record) =>
                  ![ExecutionPhase.Delivery, ExecutionPhase.Waiting].includes(
                    record.phase,
                  ),
              ).length >= config.runtime.concurrency ||
              retainedConflict ||
              live.some((other) => overlaps(attempt, other))
            )
              continue;
            await launchHost(store, attempt, project);
            live.push(store.attempt(attempt.id));
          }
          if (
            live.filter(
              (record) =>
                ![ExecutionPhase.Delivery, ExecutionPhase.Waiting].includes(
                  record.phase,
                ),
            ).length < config.runtime.concurrency &&
            attempts.filter(
              (attempt) => attempt.project === project.id && unsettled(attempt),
            ).length < 32
          ) {
            await assertRuntimeProfile(config, project.profile);
            await verifyHeartbeatAuthority(project);
            await assertVerificationIsolation(
              project.root,
              project.verificationReadPaths,
            );
            const attempt = executionSchema.parse({
              id: randomUUID(),
              project: project.id,
              profile: project.profile,
              phase: ExecutionPhase.Claiming,
              message: "Atomic ready-work claim intent persisted",
            });
            store.transaction(() => {
              if (!isDeepStrictEqual(store.project(project.id), project))
                throw new Error(
                  "Project enrollment changed before claim intent",
                );
              store.saveAttempt(attempt);
            });
            const service = new ExecutionBeads(project.source);
            try {
              const claimed = await service.claimNext(attempt.id);
              if (claimed === undefined) store.forgetEmpty(attempt.id);
              else {
                if (
                  claimed.assignee !== owner(attempt.id) ||
                  claimed.status !== "in_progress"
                )
                  throw new Error(
                    "Atomic claim returned a different owner or status",
                  );
                await retainClaim(store, service, attempt.id, claimed);
              }
            } catch (error) {
              const won = await service.owned(attempt.id).catch(() => []);
              store.change(attempt.id, (row) => {
                row.phase = ExecutionPhase.Uncertain;
                row.bead = won.length === 1 ? won[0] : undefined;
                row.message = `Claim outcome requires reconciliation: ${processFailure(error).message}`;
              });
            }
          }
        } catch (error) {
          console.error(
            `Project ${project.id}: ${processFailure(error).message}`,
          );
        }
      }
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, config.runtime.pollMs);
        signal?.addEventListener("abort", finish, { once: true });
        if (signal?.aborted === true) finish();
      });
    }
  } finally {
    store.close();
  }
}
async function launchHost(
  store: ExecutionStore,
  attempt: Execution,
  project: RuntimeProject,
): Promise<void> {
  const selection = attempt.controller;
  if (selection === undefined)
    throw new Error("Runtime lead/control model is not configured");
  const directory = join(store.directory, "runtime-sessions", attempt.id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const launch = { spawned: false };
  const capacity = (await loadConfig()).runtime.concurrency;
  if (
    !store.reserveInference(attempt.id, capacity, (row) => {
      row.launchToken = token;
      row.launchSettled = false;
      row.pid = undefined;
      row.started = undefined;
      row.phase = ExecutionPhase.Launching;
      row.message = "Native control-host launch intent persisted";
    })
  )
    return;
  const log = openSync(join(directory, "host.log"), "a", 0o600);
  try {
    const child = spawn(
      join(packageRoot, "scripts/pi"),
      [
        "--mode",
        "rpc",
        "--offline",
        "--no-mcp",
        "--no-extensions",
        "--extension",
        join(packageRoot, "execution/host-extension.ts"),
        "--session-dir",
        directory,
        ...(attempt.controllerSession === undefined
          ? []
          : ["--session-id", attempt.controllerSession]),
        "--model",
        `${selection.provider}/${selection.model}`,
        "--thinking",
        selection.reasoning,
      ],
      {
        cwd: project.root,
        env: {
          ...process.env,
          STUDIO_RUN_ID: attempt.id,
          STUDIO_LAUNCH_TOKEN: token,
          STUDIO_ATTEMPT: undefined,
        },
        stdio: ["ignore", log, log],
        detached: true,
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    launch.spawned = true;
    if (child.pid === undefined)
      throw new Error("Native control host did not return a process identity");
    const hostStart = await processStart(child.pid);
    store.change(attempt.id, (row) => {
      if (
        row.launchToken !== token ||
        (row.pid !== undefined && row.pid !== child.pid)
      )
        throw new Error("Native launch ownership changed before its receipt");
      row.pid = child.pid;
      row.started = hostStart;
    });
    child.unref();
  } catch (error) {
    store.change(attempt.id, (row) => {
      if (row.launchToken !== token) return;
      row.phase = launch.spawned
        ? ExecutionPhase.Uncertain
        : ExecutionPhase.Parked;
      row.launchSettled = !launch.spawned;
      row.message = processFailure(error).message;
    });
  } finally {
    closeSync(log);
  }
}
