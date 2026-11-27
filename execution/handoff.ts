import { assertVerificationIsolation } from "./sandbox.ts";
import { isDeepStrictEqual } from "node:util";
import { realpathSync } from "node:fs";
import { z } from "zod";
import { loadConfig, requireProfile, workerForTask, type StudioConfig } from "../config.ts";
import { planDigest, TaskDelivery, type LeadDraft, type PlanWorkers } from "../planning/plan.ts";
import { requireIntegration } from "../integrations.ts";
import { octo } from "../delivery.ts";
import { HandoffPhase, type Discovery } from "../discovery/model.ts";
import { Discoveries } from "../discovery/store.ts";
import { ExecutionStore } from "./store.ts";
import { projectSchema, type InteractiveTarget, type RuntimeProject } from "./target.ts";
import { checkHandoffRetry, handoffTaskIds } from "./handoff-model.ts";
import { ExecutionBeads, verifyHeartbeatAuthority } from "./beads.ts";
import { ensureRuntime } from "./supervisor.ts";
import { processMatchesStart, processStart } from "../process.ts";
import { assertRuntimeProfile, profileDigest } from "./profile.ts";
import { verifyInteractiveTarget } from "./interactive-target.ts";
import { setTimeout as delay } from "node:timers/promises";

export function handoffWorkers(config: StudioConfig, draft: LeadDraft | null): PlanWorkers | undefined {
  const assigned = draft?.tasks.filter((task) => task.assignment !== undefined) ?? [];
  if (assigned.length === 0) return undefined;
  const roles = requireProfile(config);
  return Object.fromEntries(assigned.map((task) => [task.key, workerForTask(roles, task.assignment)]));
}

export function retainedInteractiveTarget(record: Discovery): InteractiveTarget | undefined {
  if (record.handoff === undefined) return undefined;
  const store = new ExecutionStore();
  try {
    return store.intent(record.revision)?.interactive;
  } finally {
    store.close();
  }
}

export function handoffTarget(config: StudioConfig, record: Discovery): RuntimeProject {
  if (!config.runtime.enabled)
    throw new Error("Enable runtime and configure this project before approving unattended execution");
  if (!config.integrations.worktrees.enabled) throw new Error("Enable the native worktree integration for execution");
  const project = config.runtime.projects.find((item) => realpathSync(item.root) === record.project);
  if (!project) throw new Error("Configure this project's runtime repository and Beads service");
  requireProfile(config);
  if (project.source.reviewOnly === true)
    throw new Error("Review-only Beads authority does not permit unattended task creation or completion");
  return projectSchema.parse({
    ...project,
    root: record.project,
    id: project.source.projectId,
    profileDigest: profileDigest(config),
  });
}

async function verifyHandoff(
  record: Discovery,
  config: StudioConfig,
  enrolled: RuntimeProject,
  workers?: PlanWorkers,
): Promise<void> {
  await requireIntegration(config, "worktrees");
  if (record.leadPlan.draft?.tasks.some((task) => task.delivery === TaskDelivery.PullRequest) === true) {
    await requireIntegration(config, "octo");
    await octo(enrolled.root, "pr", "instructions");
  }
  const enrollment = new ExecutionStore();
  try {
    enrollment.validateEnrollment(enrolled);
  } finally {
    enrollment.close();
  }
  await assertRuntimeProfile(config, workers);
  await verifyHeartbeatAuthority(enrolled);
  await assertVerificationIsolation(enrolled.root, enrolled.verificationReadPaths);
}

export async function approveHandoff(
  record: Discovery,
  target: RuntimeProject,
  interactive?: InteractiveTarget,
  workers?: PlanWorkers,
): Promise<void> {
  const discoveries = new Discoveries();
  let locked: Discovery;
  try {
    const prior = record.handoff;
    let recover = false;
    if (prior?.phase === HandoffPhase.Pending) {
      if (!prior.owner || (await processMatchesStart(prior.owner.pid, prior.owner.started)))
        throw new Error(
          "The handoff owner is live or lacks a settled identity; retain the pending effect before retrying",
        );
      recover = true;
    }
    locked = discoveries.beginHandoff(
      record,
      target,
      { pid: process.pid, started: await processStart(process.pid) },
      recover,
      workers,
    );
  } catch (error) {
    discoveries.close();
    throw error;
  }
  const operation = z.uuid().parse(locked.handoff?.operation);
  let submitted = false;
  let project: RuntimeProject;
  try {
    const config = await loadConfig();
    project = handoffTarget(config, locked);
    if (
      !isDeepStrictEqual(project, target) ||
      !isDeepStrictEqual(handoffWorkers(config, locked.leadPlan.draft), workers)
    )
      throw new Error("Runtime project authority or the global profile changed after the displayed approval");
    await verifyHandoff(locked, config, project, workers);
    if (interactive) {
      if (!isDeepStrictEqual(retainedInteractiveTarget(locked), interactive))
        throw new Error("The displayed interactive target changed; review the approval again");
      await ensureInteractiveSupervisor();
      await verifyInteractiveTarget(interactive);
    }
  } catch (error) {
    discoveries.change(
      record.id,
      (row) => {
        if (row.handoff?.operation === operation) row.handoff = record.handoff;
      },
      true,
    );
    discoveries.close();
    throw error;
  }
  const draft = record.leadPlan.draft;
  if (draft === null) throw new Error("No breakdown to approve");
  const digest = planDigest(draft);
  const store = new ExecutionStore();
  try {
    const service = new ExecutionBeads(project.source);
    let intent = store.intent(record.revision);
    if (!intent) {
      const prefix = await service.prefix();
      intent = {
        digest,
        project: project.id,
        target: project,
        draft,
        ids: handoffTaskIds(prefix, record.revision, draft),
        workers,
        ...(!interactive ? {} : { interactive }),
      };
      store.saveIntent(record.revision, intent);
    } else checkHandoffRetry(intent, { digest, interactive, workers });
    submitted = true;
    const ids = await service.createGraph(
      record.revision,
      digest,
      record.title,
      draft,
      intent.ids,
      interactive !== undefined,
      intent.workers,
    );
    discoveries.change(
      record.id,
      (row) => {
        if (
          row.handoff?.operation !== operation ||
          row.handoff.revision !== record.revision ||
          row.handoff.digest !== digest
        )
          throw new Error("The handoff identity changed; retain its receipt before reconciliation");
        row.approved = digest;
        row.graph = ids;
        row.handoff.phase = HandoffPhase.Complete;
      },
      true,
    );
    store.enroll(project);
  } catch (error) {
    discoveries.change(
      record.id,
      (row) => {
        if (row.handoff?.operation === operation) {
          if (submitted) row.handoff.phase = HandoffPhase.Uncertain;
          else row.handoff = record.handoff;
        }
      },
      true,
    );
    throw error;
  } finally {
    store.close();
    discoveries.close();
  }
  await ensureRuntime();
}

async function ensureInteractiveSupervisor(): Promise<void> {
  await ensureRuntime();
  const store = new ExecutionStore();
  try {
    const deadline = Date.now() + 5000;
    do {
      const supervisor = store.supervisor();
      if (supervisor && (await processMatchesStart(supervisor.pid, supervisor.started))) {
        if (supervisor.interactiveDispatch !== true || supervisor.stop)
          throw new Error("Restart the Studio runtime on this version before approving interactive execution");
        return;
      }
      await delay(100);
    } while (Date.now() < deadline);
    throw new Error("Studio did not confirm an interactive-capable runtime");
  } finally {
    store.close();
  }
}
