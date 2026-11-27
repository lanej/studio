import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { statSync } from "node:fs";
import { join } from "node:path";
import { stateDirectory } from "../attempts.ts";
import { loadConfig } from "../config.ts";
import { processMatchesStart } from "../process.ts";
import { ExecutionPhase } from "./phase.ts";
import { effectiveMergePolicy } from "./policy.ts";
import { ExecutionStore, pendingDecision, type AllocationOwner, type Execution, type Supervisor } from "./store.ts";
import type { RuntimeProject } from "./target.ts";

export interface RuntimeStatus {
  supervisor: Supervisor | null;
  allocationOwner: AllocationOwner | null;
  live: boolean;
  projects: (Pick<RuntimeProject, "id" | "root" | "profile" | "profileDigest"> & {
    mergePolicy: ReturnType<typeof effectiveMergePolicy>;
  })[];
  attempts: Execution[];
}

export async function readRuntimeStatus(): Promise<RuntimeStatus> {
  const directory = stateDirectory();
  if (statSync(join(directory, "runtime.sqlite"), { throwIfNoEntry: false }) === undefined)
    return { supervisor: null, allocationOwner: null, live: false, projects: [], attempts: [] };

  const store = new ExecutionStore(directory, true);
  try {
    const supervisor = store.supervisor();
    const enrolled = store.projects();
    const config = enrolled.length === 0 ? undefined : await loadConfig();
    const projects =
      config === undefined
        ? []
        : enrolled.map(({ id, root, profile, profileDigest }) => ({
            id,
            root,
            profile,
            profileDigest,
            mergePolicy: effectiveMergePolicy(id, config, store.override(id)),
          }));
    return {
      supervisor: supervisor ?? null,
      allocationOwner: store.allocationOwner() ?? null,
      live: supervisor !== undefined && (await processMatchesStart(supervisor.pid, supervisor.started)),
      projects,
      attempts: store.attempts(),
    };
  } finally {
    store.close();
  }
}

export function supervisorStatus({ live, supervisor }: RuntimeStatus): string {
  if (supervisor === null) return "No supervisor recorded";
  const pid = String(supervisor.pid);
  if (!live) return `Supervisor not live · PID ${pid}`;
  if (supervisor.stop) return `Admission stop requested · PID ${pid}`;
  return `Supervisor live · PID ${pid}`;
}

export function runtimeAttemptGroups(attempts: readonly Execution[]) {
  const attention: Execution[] = [];
  const inProgress: Execution[] = [];
  const completed: Execution[] = [];
  for (const attempt of [...attempts].reverse()) {
    if (attempt.phase === ExecutionPhase.Complete) completed.push(attempt);
    else if (
      pendingDecision(attempt) !== undefined ||
      [
        ExecutionPhase.AwaitingDecision,
        ExecutionPhase.Parked,
        ExecutionPhase.Uncertain,
        ExecutionPhase.Waiting,
      ].includes(attempt.phase)
    )
      attention.push(attempt);
    else inProgress.push(attempt);
  }
  return { attention, inProgress, completed };
}

export function statusLine(value: string): string {
  return stripTerminalSequences(value)
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim();
}

function excerpt(text: string, limit: number): string {
  const characters = Array.from(statusLine(text));
  return characters.length > limit ? characters.slice(0, limit - 1).join("") + "…" : characters.join("");
}

export function formatRuntimeSummary(snapshot: RuntimeStatus): string {
  const { attention, inProgress, completed } = runtimeAttemptGroups(snapshot.attempts);
  const unfinished = [...attention, ...inProgress];
  const owner = snapshot.allocationOwner;
  const lines = [
    supervisorStatus(snapshot),
    `${String(snapshot.projects.length)} enrolled · ${String(attention.length)} need attention · ${String(inProgress.length)} other unfinished · ${String(completed.length)} complete`,
    ...(owner === null ? [] : [`Allocation owner recorded for ${owner.attempt} · PID ${String(owner.pid)}`]),
  ];
  const limit = 8;
  for (const attempt of unfinished.slice(0, limit)) {
    const task = attempt.bead === undefined ? "unclaimed" : excerpt(attempt.bead.id, 40);
    const decision = pendingDecision(attempt);
    const context = decision === undefined ? excerpt(attempt.message, 120) : `request ${decision.id}`;
    lines.push(`${attempt.phase} ${task} ${attempt.id}${context.length === 0 ? "" : ` · ${context}`}`);
  }
  if (unfinished.length > limit) lines.push(`+${String(unfinished.length - limit)} unfinished (see --json)`);
  return lines.join("\n");
}
