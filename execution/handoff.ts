import { assertVerificationIsolation } from "./sandbox.ts";
import { isDeepStrictEqual } from "node:util";
import { realpathSync } from "node:fs";
import { z } from "zod";
import { loadConfig, studioProfileSchema } from "../config.ts";
import { planDigest, TaskDelivery } from "../lead-plan.ts";
import { requireIntegration } from "../integrations.ts";
import { octo } from "../delivery.ts";
import type { Discovery } from "../discovery/store.ts";
import { Discoveries, HandoffPhase } from "../discovery/store.ts";
import { ExecutionStore, projectSchema, type RuntimeProject } from "./store.ts";
import { ExecutionBeads, verifyHeartbeatAuthority } from "./beads.ts";
import { ensureRuntime } from "./supervisor.ts";
import { alive } from "./supervisor.ts";
import { processStart } from "../process.ts";
import { assertRuntimeProfile } from "./profile.ts";

export async function prepareHandoff(
  record: Discovery,
  profile: string,
): Promise<RuntimeProject> {
  const config = await loadConfig();
  if (!config.runtime.enabled)
    throw new Error(
      "Enable runtime and configure this project before approving unattended execution",
    );
  if (!config.integrations.worktrees.enabled)
    throw new Error("Enable the native worktree integration for execution");
  await requireIntegration(config, "worktrees");
  const project = config.runtime.projects.find(
    (item) => realpathSync(item.root) === record.project,
  );
  if (
    project === undefined ||
    project.profile !== studioProfileSchema.parse(profile)
  )
    throw new Error(
      "Configure this project's runtime repository, Beads service, and selected profile",
    );
  if (project.source.reviewOnly === true)
    throw new Error(
      "Review-only Beads authority does not permit unattended task creation or completion",
    );
  const enrolled = projectSchema.parse({
    ...project,
    root: record.project,
    id: project.source.projectId,
  });
  if (
    record.leadPlan.draft?.tasks.some(
      (task) => task.delivery === TaskDelivery.PullRequest,
    ) === true
  ) {
    await requireIntegration(config, "octo");
    await octo(enrolled.root, "pr", "instructions");
  }
  const enrollment = new ExecutionStore();
  try {
    enrollment.validateEnrollment(enrolled);
  } finally {
    enrollment.close();
  }
  await assertRuntimeProfile(config, enrolled.profile);
  await verifyHeartbeatAuthority(enrolled);
  await assertVerificationIsolation(
    enrolled.root,
    enrolled.verificationReadPaths,
  );
  return enrolled;
}
const intentSchema = z.object({
  digest: z.string(),
  ids: z.record(z.string(), z.string()),
});
export async function approveHandoff(
  record: Discovery,
  profile: string,
  target: RuntimeProject,
): Promise<void> {
  const discoveries = new Discoveries();
  let locked: Discovery;
  try {
    const prior = record.handoff;
    let recover = false;
    if (prior?.phase === HandoffPhase.Pending) {
      if (
        prior.owner === undefined ||
        (await alive(prior.owner.pid, prior.owner.started))
      )
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
    );
  } catch (error) {
    discoveries.close();
    throw error;
  }
  const operation = z.uuid().parse(locked.handoff?.operation);
  let submitted = false;
  let project: RuntimeProject;
  try {
    project = await prepareHandoff(record, profile);
    if (!isDeepStrictEqual(project, target))
      throw new Error(
        "Runtime project authority changed after the displayed approval",
      );
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
    let intent = intentSchema.optional().parse(store.intent(record.revision));
    if (intent !== undefined && intent.digest !== digest)
      throw new Error(
        "A different graph creation attempt is already retained; reconcile it before changing the proposal",
      );
    if (intent === undefined) {
      const prefix = await service.prefix();
      const root = `${prefix}-${record.revision.replaceAll("-", "")}`;
      const entries: [string, string][] = [["root", root]];
      for (const task of draft.tasks)
        entries.push([task.key, `${root}.${task.key}`]);
      intent = { digest, ids: Object.fromEntries(entries) };
      store.saveIntent(record.revision, intent);
    }
    submitted = true;
    const ids = await service.createGraph(
      record.revision,
      digest,
      record.title,
      draft,
      intent.ids,
      project.profile,
    );
    discoveries.change(
      record.id,
      (row) => {
        if (
          row.handoff?.operation !== operation ||
          row.handoff.revision !== record.revision ||
          row.handoff.digest !== digest
        )
          throw new Error(
            "The handoff identity changed; retain its receipt before reconciliation",
          );
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
