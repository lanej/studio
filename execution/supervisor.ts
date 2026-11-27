import { assertVerificationIsolation } from "./sandbox.ts";
import { reconcileAttempt, retainClaim, writerFence } from "./recovery.ts";
import { isDeepStrictEqual } from "node:util";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { configPath, loadConfig, type StudioConfig } from "../config.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { requireIntegration } from "../integrations.ts";
import { packageRoot } from "../package-resources.ts";
import { processFailure, processMatchesStart, processStart } from "../process.ts";
import { owner } from "../task-service.ts";
import { ownershipConflict, retainedConflicts } from "./admission.ts";
import { ExecutionBeads, interactiveTask, heartbeat, verifyHeartbeatAuthority } from "./beads.ts";
import { ExecutionStore, ExecutionPhase, executionSchema, unsettled, type Execution } from "./store.ts";
import type { RuntimeProject } from "./target.ts";
import { assertRuntimeProfile, profileDigest } from "./profile.ts";
import { verifyInteractiveTarget } from "./interactive-target.ts";
import type { Zellij } from "../zellij.ts";
import { workerTerminal } from "./worker-terminal.ts";

export type LaunchWorkerPane = (zellij: Zellij, ...args: Parameters<Zellij["launch"]>) => Promise<number>;

export async function ensureRuntime(): Promise<void> {
  const config = await loadConfig();
  if (!config.runtime.enabled) throw new Error("Studio runtime is disabled");
  const store = new ExecutionStore();
  try {
    const current = store.supervisor();
    if (current && (await processMatchesStart(current.pid, current.started))) {
      if (current.stop) throw new Error("Runtime is stopping; inspect status before restarting");
      return;
    }
    const log = openSync(join(store.directory, "runtime.log"), "a", 0o600);
    try {
      const child = spawn(join(packageRoot, "scripts/studio"), ["runtime", "serve"], {
        detached: true,
        stdio: ["ignore", log, log],
        cwd: packageRoot,
      });
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

export async function maintainAttempt(
  store: ExecutionStore,
  project: RuntimeProject,
  id: string,
  adapters = { reconcile: reconcileAttempt, heartbeat },
): Promise<void> {
  let observed = store.attempt(id);
  try {
    await adapters.reconcile(store, project, id);
    observed = store.attempt(id);
    // A possibly running control host owns its lease until its launch is reconciled.
    if (
      !observed.bead ||
      observed.phase === ExecutionPhase.Complete ||
      (observed.launchToken !== undefined &&
        !observed.launchSettled &&
        (!observed.interactive || observed.pid !== undefined)) ||
      Date.now() - observed.heartbeatAt <= 15000
    )
      return;
    await adapters.heartbeat(project, observed.id, observed.bead.id);
    store.change(id, (row) => {
      if (
        row.phase !== ExecutionPhase.Complete &&
        row.launchToken === observed.launchToken &&
        row.pid === observed.pid &&
        row.started === observed.started
      )
        row.heartbeatAt = Date.now();
    });
  } catch (error) {
    store.change(id, (row) => {
      if (
        row.phase === ExecutionPhase.Complete ||
        row.phase !== observed.phase ||
        row.launchSettled !== observed.launchSettled ||
        row.launchToken !== observed.launchToken ||
        row.pid !== observed.pid ||
        row.started !== observed.started
      )
        return;
      row.phase = ExecutionPhase.Uncertain;
      row.message = `This attempt needs reconciliation: ${processFailure(error).message}`;
    });
  }
}

export async function serveRuntime(signal?: AbortSignal, launchWorkerPane?: LaunchWorkerPane): Promise<void> {
  const store = new ExecutionStore();
  const id = randomUUID();
  const terminalName = `studio-runtime-${id}`;
  const connectTerminal = workerTerminal(terminalName);
  const terminal: typeof connectTerminal = async (executable, cwd) => {
    const target = await connectTerminal(executable, cwd);
    store.transaction(() => {
      const owner = store.supervisor();
      if (owner?.id !== id || owner.stop) throw new Error("Runtime ownership changed before terminal dispatch");
      if (owner.workerSession !== terminalName) store.setSupervisor({ ...owner, workerSession: terminalName });
    });
    return target;
  };
  const started = await processStart(process.pid);
  const previous = store.supervisor();
  if (previous && (await processMatchesStart(previous.pid, previous.started))) {
    store.close();
    throw new Error("A live Studio runtime already owns scheduling");
  }
  store.transaction(() => {
    const current = store.supervisor();
    if (current?.id !== previous?.id) throw new Error("Another runtime won scheduling ownership");
    store.setSupervisor({
      id,
      pid: process.pid,
      started,
      stop: false,
      interactiveDispatch: true,
    });
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
                ...(project.profile === undefined ? {} : { profile: project.profile }),
                ...(project.profileDigest === undefined ? {} : { profileDigest: project.profileDigest }),
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
              (record) =>
                record.project === project.id &&
                (unsettled(record) || (record.interactive !== undefined && record.phase === ExecutionPhase.Parked)),
            )) {
            await maintainAttempt(store, project, attempt.id);
          }
          await requireIntegration(config, "worktrees");
          const attempts = store.attempts();
          const live = [];
          for (const attempt of attempts) if (await writerFence(attempt)) live.push(attempt);
          for (const attempt of attempts.filter(
            (record) => record.project === project.id && record.phase === ExecutionPhase.Queued,
          )) {
            const retainedConflict = retainedConflicts(attempt, attempts).next().done !== true;
            if (
              live.filter((record) => ![ExecutionPhase.Delivery, ExecutionPhase.Waiting].includes(record.phase))
                .length >= config.runtime.concurrency ||
              retainedConflict ||
              live.some((other) => ownershipConflict(other, attempt) !== undefined)
            )
              continue;
            if (!attempt.interactive) await launchHost(store, attempt, project, config, terminalName, terminal);
            else await launchInteractive(store, attempt, project, config.runtime.concurrency, launchWorkerPane);
            live.push(store.attempt(attempt.id));
          }
          if (
            live.filter((record) => ![ExecutionPhase.Delivery, ExecutionPhase.Waiting].includes(record.phase)).length <
              config.runtime.concurrency &&
            attempts.filter((attempt) => attempt.project === project.id && unsettled(attempt)).length < 32
          ) {
            const digest = profileDigest(config);
            if (digest === undefined || project.profileDigest !== digest)
              throw new Error("Approve a handoff with the current global profile before admitting new work");
            await assertRuntimeProfile(config);
            await verifyHeartbeatAuthority(project);
            await assertVerificationIsolation(project.root, project.verificationReadPaths);
            const attempt = executionSchema.parse({
              id: randomUUID(),
              project: project.id,
              profileDigest: digest,
              phase: ExecutionPhase.Claiming,
              message: "Atomic ready-work claim intent persisted",
            });
            store.transaction(() => {
              if (!isDeepStrictEqual(store.project(project.id), project))
                throw new Error("Project enrollment changed before claim intent");
              store.saveAttempt(attempt);
            });
            const service = new ExecutionBeads(project.source);
            try {
              const claimed = await service.claimNext(attempt.id);
              if (!claimed) store.forgetEmpty(attempt.id);
              else {
                if (claimed.assignee !== owner(attempt.id) || claimed.status !== "in_progress")
                  throw new Error("Atomic claim returned a different owner or status");
                await retainClaim(store, service, attempt.id, claimed, config);
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
          console.error(`Project ${project.id}: ${processFailure(error).message}`);
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

async function launchInteractive(
  store: ExecutionStore,
  attempt: Execution,
  project: RuntimeProject,
  capacity: number,
  launch: LaunchWorkerPane = (zellij, ...args) => zellij.launch(...args),
): Promise<void> {
  const target = attempt.interactive;
  if (!target || !attempt.bead) throw new Error("Missing interactive assignment");
  const bead = attempt.bead.id;
  let zellij: Zellij;
  try {
    await requireIntegration(await loadConfig(), "zellij");
    zellij = await verifyInteractiveTarget(target);
  } catch (error) {
    store.change(attempt.id, (row) => {
      if (row.phase !== ExecutionPhase.Queued) return;
      row.phase = ExecutionPhase.Parked;
      row.message = `Approved Zellij target unavailable. Inspect the retained claim: ${processFailure(error).message}`;
    });
    return;
  }
  const token = randomUUID();
  if (
    !store.reserveInference(attempt.id, capacity, (row) => {
      if (row.phase !== ExecutionPhase.Queued || row.launchToken !== undefined)
        throw new Error("Interactive launch has already been reserved");
      row.launchToken = token;
      row.launchSettled = false;
      row.phase = ExecutionPhase.Launching;
      row.message = "Native Pi pane launch intent persisted";
    })
  )
    return;
  try {
    const path = process.env["PATH"];
    const pane = await launch(zellij, target.tab, bead, project.root, [
      `STUDIO_STATE_DIR=${store.directory}`,
      `STUDIO_CONFIG=${resolve(configPath())}`,
      `PI_CODING_AGENT_DIR=${resolve(getAgentDir())}`,
      ...(path === undefined ? [] : [`PATH=${path}`]),
      "PI_OFFLINE=1",
      process.execPath,
      "--no-env-file",
      `--config=${join(packageRoot, "resources/bunfig.toml")}`,
      join(packageRoot, "execution/interactive-host.ts"),
      attempt.id,
      token,
    ]);
    store.change(attempt.id, (row) => {
      if (row.launchToken !== token) throw new Error("Interactive launch token changed");
      if (row.pane !== undefined && row.pane !== pane) {
        row.phase = ExecutionPhase.Uncertain;
        row.message = "Zellij acknowledged a different pane. Inspect the registered attempt before reconciling.";
        return;
      }
      row.pane = pane;
    });
  } catch (error) {
    store.change(attempt.id, (row) => {
      if (row.launchToken !== token || row.pid !== undefined) return;
      row.phase = ExecutionPhase.Uncertain;
      row.message = `Zellij launch is unconfirmed. Wait for the same pane to register or inspect this attempt. ${processFailure(error).message}`;
    });
  }
}

async function launchHost(
  store: ExecutionStore,
  attempt: Execution,
  project: RuntimeProject,
  config: StudioConfig,
  terminalName: string,
  terminal: ReturnType<typeof workerTerminal>,
): Promise<void> {
  if (attempt.bead && interactiveTask(attempt.bead)) {
    await retainClaim(store, new ExecutionBeads(project.source), attempt.id, attempt.bead);
    return;
  }
  const selection = attempt.controller;
  if (!selection) throw new Error("Runtime lead/control model is not configured");
  const directory = join(store.directory, "runtime-sessions", attempt.id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let target: Awaited<ReturnType<typeof terminal>> | undefined;
  if (config.integrations.zellij.enabled) {
    try {
      target = await terminal(await requireIntegration(config, "zellij"), project.root);
    } catch (error) {
      store.change(attempt.id, (row) => {
        if (row.phase === ExecutionPhase.Queued && row.launchToken === undefined)
          row.message = `Studio worker session ${terminalName} unavailable; work remains queued: ${processFailure(error).message}`;
      });
      return;
    }
  }
  const token = randomUUID();
  const launch = { spawned: false };
  const capacity = config.runtime.concurrency;
  if (
    !store.reserveInference(attempt.id, capacity, (row) => {
      row.launchToken = token;
      row.launchSettled = false;
      row.pid = undefined;
      row.started = undefined;
      row.phase = ExecutionPhase.Launching;
      row.message = target
        ? `Control-host launch reserved in Zellij ${terminalName}; attach with zellij attach ${terminalName}`
        : "Native control-host launch intent persisted";
    })
  )
    return;
  const executable = join(packageRoot, "scripts/pi");
  const args = [
    "--mode",
    "rpc",
    "--offline",
    "--no-mcp",
    "--no-extensions",
    "--extension",
    join(packageRoot, "execution/host-extension.ts"),
    "--session-dir",
    directory,
    ...(attempt.controllerSession === undefined ? [] : ["--session-id", attempt.controllerSession]),
    "--model",
    `${selection.provider}/${selection.model}`,
    "--thinking",
    selection.reasoning,
  ];
  const binding = {
    STUDIO_STATE_DIR: store.directory,
    STUDIO_CONFIG: resolve(configPath()),
    PI_CODING_AGENT_DIR: resolve(getAgentDir()),
    STUDIO_RUN_ID: attempt.id,
    STUDIO_LAUNCH_TOKEN: token,
  };
  const log = target ? undefined : openSync(join(directory, "host.log"), "a", 0o600);
  try {
    if (target) {
      // The pane's process registers the same launch token and PID itself. An uncertain
      // acknowledgement must retain the writer fence, just as an uncertain spawn does.
      launch.spawned = true;
      await target.zellij.launch(target.tab, attempt.bead?.title ?? attempt.id, project.root, [
        "-u",
        "STUDIO_ATTEMPT",
        ...Object.entries(binding).map(([key, value]) => `${key}=${value}`),
        "/bin/sh",
        "-c",
        'exec "$@" </dev/null',
        "studio-control-host",
        executable,
        ...args,
      ]);
      return;
    }
    const child = spawn(executable, args, {
      cwd: project.root,
      env: {
        ...process.env,
        ...binding,
        STUDIO_ATTEMPT: undefined,
      },
      stdio: ["ignore", log ?? "ignore", log ?? "ignore"],
      detached: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    launch.spawned = true;
    if (child.pid === undefined) throw new Error("Native control host did not return a process identity");
    const hostStart = await processStart(child.pid);
    store.change(attempt.id, (row) => {
      if (row.launchToken !== token || (row.pid !== undefined && row.pid !== child.pid))
        throw new Error("Native launch ownership changed before its receipt");
      row.pid = child.pid;
      row.started = hostStart;
    });
    child.unref();
  } catch (error) {
    store.change(attempt.id, (row) => {
      if (row.launchToken !== token) return;
      row.phase = launch.spawned ? ExecutionPhase.Uncertain : ExecutionPhase.Parked;
      row.launchSettled = !launch.spawned;
      row.message = processFailure(error).message;
    });
  } finally {
    if (log !== undefined) closeSync(log);
  }
}
