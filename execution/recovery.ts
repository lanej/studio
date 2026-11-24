import { processFailure, run } from "../process.ts";
import { sameBrief } from "../task-service.ts";
import {
  loadConfig,
  studioProfileSchema,
  AgentRole,
  type StudioConfig,
} from "../config.ts";
import { draftSchema } from "../lead-plan.ts";
import { ExecutionBeads } from "./beads.ts";
import {
  type ExecutionStore,
  ExecutionPhase,
  VerificationPhase,
  type Execution,
  type RuntimeProject,
} from "./store.ts";
import { alive } from "./supervisor.ts";

export function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (processFailure(error).code === "ESRCH") return false;
    throw error;
  }
}
/** A missing receipt is uncertainty, never evidence that a writer is gone. */
export async function writerFence(record: Execution): Promise<boolean> {
  if (record.launchSettled || record.launchToken === undefined) return false;
  if (record.pid === undefined || record.started === undefined) return true;
  if ((await alive(record.pid, record.started)) || groupExists(record.pid))
    return true;
  const verifier = record.verifier;
  if (verifier !== undefined && verifier.phase !== VerificationPhase.Complete) {
    if (
      verifier.pid === undefined ||
      verifier.started === undefined ||
      verifier.childPid === undefined ||
      verifier.childStarted === undefined
    )
      return true;
    if (
      (await alive(verifier.pid, verifier.started)) ||
      groupExists(verifier.pid) ||
      (await alive(verifier.childPid, verifier.childStarted)) ||
      groupExists(verifier.childPid)
    )
      return true;
  }
  return false;
}

/** Explicit retry must also wait for a settled host to exit after recording its result. */
export async function retryWriterFence(record: Execution): Promise<boolean> {
  if (await writerFence(record)) return true;
  if (
    record.verifier !== undefined &&
    record.verifier.phase !== VerificationPhase.Complete
  )
    return true;
  if (record.pid === undefined) return record.started !== undefined;
  if (record.started === undefined) return true;
  return (await alive(record.pid, record.started)) || groupExists(record.pid);
}
export async function retainClaim(
  store: ExecutionStore,
  service: ExecutionBeads,
  id: string,
  claimed: NonNullable<Execution["bead"]>,
  configuration?: StudioConfig,
): Promise<void> {
  const bound =
    claimed.metadata["pi.attempt"] === id
      ? claimed
      : await service.bind(claimed, id);
  const config = configuration ?? (await loadConfig());
  const profile = studioProfileSchema.parse(
    bound.metadata["studio.profile"] ?? store.attempt(id).profile,
  );
  const roles = config.profiles[profile];
  if (roles === undefined)
    throw new Error(
      `Configure the approved ${profile} profile; another profile will not be substituted`,
    );
  const metadata = bound.metadata["studio.task"];
  const task =
    metadata === undefined
      ? undefined
      : draftSchema.shape.tasks.element.parse(metadata);
  store.change(id, (row) => {
    row.bead = bound;
    row.revision = bound.revision;
    row.profile = profile;
    row.controller = roles[AgentRole.Lead];
    row.worker = roles[AgentRole.Worker];
    row.reviewer = roles[AgentRole.Reviewer];
    row.phase = ExecutionPhase.Queued;
    row.owns = task?.owns ?? [];
    row.check = task?.check ?? [];

    row.message =
      "Claim receipt reconciled; waiting for non-conflicting worker capacity";
  });
}
export async function reconcileAttempt(
  store: ExecutionStore,
  project: RuntimeProject,
  id: string,
): Promise<void> {
  const record = store.attempt(id);
  if (record.phase === ExecutionPhase.Complete) return;
  const service = new ExecutionBeads(project.source);
  if (
    record.launchToken === undefined &&
    (record.phase === ExecutionPhase.Claiming ||
      (record.phase === ExecutionPhase.Uncertain &&
        (record.bead === undefined ||
          record.revision === undefined ||
          record.controller === undefined ||
          record.worker === undefined ||
          record.reviewer === undefined)))
  ) {
    const owned = await service.owned(record.id);
    if (owned.length === 1 && owned[0] !== undefined)
      await retainClaim(store, service, id, owned[0]);
    else
      store.change(id, (row) => {
        row.phase = ExecutionPhase.Uncertain;
        row.message =
          owned.length === 0
            ? "Claim may still be pending; no second claim will be sent under this actor"
            : "Multiple claims carry this actor; inspect the retained identities before dispatch";
      });
    return;
  }
  if (
    record.phase === ExecutionPhase.Queued ||
    record.launchSettled ||
    record.phase === ExecutionPhase.Parked
  )
    return;
  if (
    record.pid !== undefined &&
    record.started !== undefined &&
    (await alive(record.pid, record.started))
  )
    return;
  if (await writerFence(record)) {
    store.change(id, (row) => {
      row.phase = ExecutionPhase.Uncertain;
      row.message =
        "Launch/verifier identity or process-group settlement is uncertain; retain writer capacity and owned-path fences";
    });
    return;
  }
  if (record.bead === undefined || record.revision === undefined) return;
  const current = await service.get(record.bead.id);
  if (
    current.status === "closed" &&
    current.metadata["studio.completed"] === id &&
    sameBrief(current, record.bead) &&
    record.review !== undefined &&
    record.integration !== undefined &&
    record.resultRef !== undefined
  ) {
    await run(
      "git",
      ["merge-base", "--is-ancestor", record.integration, record.resultRef],
      { cwd: project.root },
    );
    store.change(id, (row) => {
      row.phase = ExecutionPhase.Complete;
      row.launchSettled = true;
      row.message =
        "Confirmed prior integration and guarded completion after control-host loss";
    });
    return;
  }
  await service.requireCurrent(record.bead, record.revision, id);
  if (record.recoveries >= 3) {
    store.change(id, (row) => {
      row.phase = ExecutionPhase.Parked;
      row.launchSettled = true;
      row.message =
        "Automatic host recovery budget exhausted; inspect retained native sessions before explicit retry";
    });
    return;
  }
  store.change(id, (row) => {
    if (
      row.launchToken !== record.launchToken ||
      row.pid !== record.pid ||
      row.started !== record.started
    )
      throw new Error(
        "A control host reported ownership while recovery was inspecting it",
      );
    row.phase = ExecutionPhase.Queued;
    row.pid = undefined;
    row.started = undefined;
    row.launchToken = undefined;
    row.launchSettled = true;
    row.recoveries += 1;
    row.message =
      "Prior host and verifier groups confirmed gone; resume the same accepted attempt and retained effects";
  });
}
