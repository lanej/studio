import { Database } from "bun:sqlite";
import { isDeepStrictEqual } from "node:util";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { knownTaskStatus, TaskStatus, type Task, type TaskReview } from "../beads.ts";
import { stateDirectory } from "../attempts.ts";
import { studioProfileSchema, selection } from "../config.ts";
import { verificationSchema, beadSchema, owner } from "../task-service.ts";
import { sha } from "../delivery-record.ts";
import { worktreeReservation, worktreeAllocation } from "../vendor/task-runtime/worktree-contracts.ts";
import { ExecutionPhase } from "./phase.ts";
import { storedHandoffIntentSchema, type HandoffIntent, type RetainedHandoffIntent } from "./handoff-model.ts";
import { interactiveTargetSchema, projectSchema, storedProjectSchema, type RuntimeProject } from "./target.ts";

export { ExecutionPhase } from "./phase.ts";

export enum VerificationPhase {
  Launching = "launching",
  Running = "running",
  Complete = "complete",
}
export const operatorDecisionSchema = z.object({
  id: z.uuid(),
  question: z.string().trim().min(1).max(2000),
  at: z.string(),
  binding: z.object({
    project: z.uuid(),
    bead: z.string().min(1),
    revision: z.string().min(1),
    launchToken: z.uuid(),
    contract: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  answer: z.object({ text: z.string().min(1).max(4000), at: z.string() }).optional(),
  appliedHead: z.string().optional(),
});
export type OperatorDecision = z.infer<typeof operatorDecisionSchema>;
export const executionSchema = z.object({
  id: z.uuid(),
  project: z.uuid(),
  profile: studioProfileSchema,
  controller: selection.optional(),
  phase: z.enum(ExecutionPhase),
  bead: beadSchema.optional(),
  revision: z.string().optional(),
  reservation: worktreeReservation.optional(),
  checkout: worktreeAllocation.optional(),
  resultRef: z
    .string()
    .regex(/^refs\/studio\/(?:graphs|results|projects)\/[a-zA-Z0-9-]+$/u)
    .optional(),
  integration: z.string().optional(),
  integrationReview: z.string().optional(),
  integrationExpected: z.string().optional(),
  base: z.string().optional(),
  publicationBase: z
    .object({
      remote: sha,
      prerequisites: z.array(z.object({ id: z.uuid(), before: sha, after: sha, commit: sha })),
    })
    .optional(),
  head: z.string().optional(),
  pid: z.number().int().positive().optional(),
  started: z.string().optional(),
  launchToken: z.uuid().optional(),
  launchSettled: z.boolean().default(false),
  interactive: interactiveTargetSchema.optional(),
  pane: z.number().int().nonnegative().optional(),
  workerSessionFile: z.string().optional(),
  recoveries: z.number().int().nonnegative().default(0),
  controllerSession: z.string().optional(),
  controllerSessionFile: z.string().optional(),
  readyNotice: z.object({ id: z.string(), head: z.string() }).optional(),
  manualMergeApproval: z
    .object({
      head: z.string(),
      notice: z.string(),
      pr: z.string(),
      agent: z.string(),
      actor: z.string(),
      at: z.string(),
    })
    .optional(),
  worker: selection.optional(),
  reviewer: selection.optional(),
  sessions: z.array(z.string()).default([]),
  owns: z.array(z.string()).default([]),
  check: z.array(z.string()).default([]),
  verifier: z
    .object({
      phase: z.enum(VerificationPhase),
      pid: z.number().int().positive().optional(),
      started: z.string().optional(),
      childPid: z.number().int().positive().optional(),
      childStarted: z.string().optional(),
    })
    .optional(),
  verification: verificationSchema.optional(),
  operatorDecisions: z.array(operatorDecisionSchema).max(8).optional(),
  summary: z.string().default(""),
  review: z.string().optional(),
  reviewFinding: z.string().optional(),
  reviewFeedback: z.array(z.string()).optional(),
  publication: z.string().optional(),
  pr: z.string().optional(),
  agent: z.string().optional(),
  url: z.string().optional(),
  events: z.array(z.string()).default([]),
  mergeReceipt: z.string().optional(),
  merged: z.string().optional(),
  heartbeatAt: z.number().default(0),
  message: z.string(),
});
export type Execution = z.infer<typeof executionSchema>;
export const latestDecision = (record: Execution): OperatorDecision | undefined => record.operatorDecisions?.at(-1);

export function pendingDecision(record: Execution): OperatorDecision | undefined {
  const latest = latestDecision(record);
  return !latest?.answer ? latest : undefined;
}

export const hasUnappliedAnswer = (record: Execution): boolean =>
  record.operatorDecisions?.some((decision) => decision.answer !== undefined && decision.appliedHead === undefined) ===
  true;
export const mergeOverrideSchema = z.object({
  enabled: z.boolean(),
  actor: z.string(),
  reason: z.string().min(1),
  at: z.string(),
});
export type MergeOverride = z.infer<typeof mergeOverrideSchema>;
const supervisorSchema = z.object({
  id: z.uuid(),
  pid: z.number().int().positive(),
  started: z.string(),
  stop: z.boolean().default(false),
  interactiveDispatch: z.literal(true).optional(),
});
export type Supervisor = z.infer<typeof supervisorSchema>;
const allocationOwnerSchema = z.object({
  id: z.uuid(),
  attempt: z.uuid(),
  pid: z.number().int().positive(),
  started: z.string(),
});
export type AllocationOwner = z.infer<typeof allocationOwnerSchema>;

/** Match the local review to the task's current Beads owner on each inspection. */
export function activeTaskReviews(
  project: string | undefined,
  tasks: readonly Task[],
  directory = stateDirectory(),
): Map<string, TaskReview> {
  const result = new Map<string, TaskReview>();
  const path = join(directory, "runtime.sqlite");
  if (project === undefined || !existsSync(path)) return result;
  const db = new Database(path, { readonly: true });
  try {
    const attempt = db.query("SELECT record FROM records WHERE kind='attempt' AND id=?");
    const ownerPrefix = owner("");
    for (const task of tasks) {
      const assignee = task.assignee;
      if (
        knownTaskStatus(task.status) !== TaskStatus.InProgress ||
        assignee === undefined ||
        !assignee.startsWith(ownerPrefix)
      )
        continue;
      const row = attempt.get(assignee.slice(ownerPrefix.length));
      if (row === null) continue;
      const { record } = z.object({ record: z.string() }).parse(row);
      const current = executionSchema.parse(JSON.parse(record));
      if (current.project !== project || current.bead?.id !== task.id) continue;
      const inReview = current.phase === ExecutionPhase.Reviewing;
      if (
        inReview ||
        (current.reviewFinding !== undefined &&
          [ExecutionPhase.Running, ExecutionPhase.Parked, ExecutionPhase.Waiting].includes(current.phase))
      )
        result.set(task.id, { finding: current.reviewFinding });
    }
    return result;
  } finally {
    db.close();
  }
}

/** Durable intents and receipts only. Beads owns task state and dependency readiness. */
export class ExecutionStore {
  private readonly db: Database;
  constructor(readonly directory = stateDirectory()) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new Database(join(directory, "runtime.sqlite"), { create: true });
    this.db.run("PRAGMA busy_timeout=5000");
    this.db.run(
      "CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL,id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(kind,id))",
    );
    this.db.run(
      "CREATE TABLE IF NOT EXISTS journal (sequence INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,id TEXT NOT NULL,record TEXT NOT NULL)",
    );
  }
  close(): void {
    this.db.close();
  }
  transaction<T>(operation: () => T): T {
    this.db.run("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.db.run("COMMIT");
      return value;
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
  }
  private read(kind: string, id: string): unknown {
    const result = this.db.query("SELECT record FROM records WHERE kind=? AND id=?").get(kind, id);
    return result === null ? undefined : JSON.parse(z.object({ record: z.string() }).parse(result).record);
  }
  private rows(kind: string): unknown[] {
    return this.db
      .query("SELECT record FROM records WHERE kind=? ORDER BY rowid")
      .all(kind)
      .map((row) => {
        const value: unknown = JSON.parse(z.object({ record: z.string() }).parse(row).record);
        return value;
      });
  }
  private save(kind: string, id: string, record: unknown): void {
    this.db
      .query("INSERT INTO records VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET record=excluded.record")
      .run(kind, id, JSON.stringify(record));
  }
  projects(): RuntimeProject[] {
    return this.rows("project").map((row) => storedProjectSchema.parse(row));
  }
  project(id: string): RuntimeProject {
    return storedProjectSchema.parse(this.read("project", id));
  }
  validateEnrollment(input: RuntimeProject): RuntimeProject {
    const project = { ...input, root: realpathSync(input.root) };
    const current = this.projects().find((item) => item.id === project.id || item.root === project.root);
    if (current && (current.root !== project.root || current.id !== project.id))
      throw new Error("Project identity is already enrolled with a different repository");
    if (current && "claimLabel" in current && current.claimLabel !== undefined)
      throw new Error("Legacy project has a retained claim label; reconcile its claim scope before reenrollment");
    if (
      current &&
      !isDeepStrictEqual({ ...current, merge: undefined }, { ...project, merge: undefined }) &&
      this.attempts().some((row) => row.project === current.id && row.phase !== ExecutionPhase.Complete)
    )
      throw new Error(
        "Retained attempts pin this project's authority; reconcile them before reenrollment with changed settings",
      );
    return projectSchema.parse(project);
  }
  enroll(input: RuntimeProject): void {
    this.transaction(() => {
      const project = this.validateEnrollment(input);
      this.save("project", project.id, project);
    });
  }
  attempts(): Execution[] {
    return this.rows("attempt").map((row) => executionSchema.parse(row));
  }
  attempt(id: string): Execution {
    return executionSchema.parse(this.read("attempt", id));
  }
  forgetEmpty(id: string): void {
    this.db.query("DELETE FROM records WHERE kind='attempt' AND id=?").run(id);
  }
  saveAttempt(record: Execution): void {
    this.save("attempt", record.id, executionSchema.parse(record));
  }
  change(id: string, update: (record: Execution) => void): Execution {
    return this.transaction(() => {
      const record = this.attempt(id);
      update(record);
      this.saveAttempt(record);
      return record;
    });
  }
  reserveInference(id: string, limit: number, update: (record: Execution) => void): boolean {
    return this.transaction(() => {
      const holders = this.attempts().filter(
        (row) =>
          row.id !== id &&
          row.launchToken !== undefined &&
          !row.launchSettled &&
          ![ExecutionPhase.Delivery, ExecutionPhase.Waiting, ExecutionPhase.Complete, ExecutionPhase.Parked].includes(
            row.phase,
          ),
      );
      if (holders.length >= limit) return false;
      const row = this.attempt(id);
      update(row);
      this.saveAttempt(row);
      return true;
    });
  }
  supervisor(): Supervisor | undefined {
    return supervisorSchema.optional().parse(this.read("supervisor", "owner"));
  }
  setSupervisor(record: Supervisor): void {
    this.save("supervisor", "owner", supervisorSchema.parse(record));
  }
  allocationOwner(): AllocationOwner | undefined {
    return allocationOwnerSchema.optional().parse(this.read("allocation", "owner"));
  }
  reserveAllocation(owner: AllocationOwner, expected: string | undefined): boolean {
    return this.transaction(() => {
      if (this.allocationOwner()?.id !== expected) return false;
      this.save("allocation", "owner", allocationOwnerSchema.parse(owner));
      return true;
    });
  }
  releaseAllocation(id: string): void {
    this.transaction(() => {
      if (this.allocationOwner()?.id === id)
        this.db.query("DELETE FROM records WHERE kind='allocation' AND id='owner'").run();
    });
  }
  override(project: string): MergeOverride | undefined {
    return mergeOverrideSchema.optional().parse(this.read("merge", project));
  }
  setOverride(project: string, override: MergeOverride | undefined, audit?: { actor: string; reason: string }): void {
    if (!override && (!audit || audit.reason.trim().length === 0))
      throw new Error("Record who cleared the project override and why");
    this.transaction(() => {
      this.db.query("INSERT INTO journal(kind,id,record) VALUES (?,?,?)").run(
        "merge",
        project,
        JSON.stringify({
          override: override ?? null,
          actor: override?.actor ?? audit?.actor,
          reason: override?.reason ?? audit?.reason,
          at: new Date().toISOString(),
        }),
      );
      if (!override) this.db.query("DELETE FROM records WHERE kind='merge' AND id=?").run(project);
      else this.save("merge", project, mergeOverrideSchema.parse(override));
    });
  }
  intent(id: string): HandoffIntent | undefined {
    return storedHandoffIntentSchema.optional().parse(this.read("handoff", id));
  }
  taskHandoffIntent(project: string, bead: string): RetainedHandoffIntent | undefined {
    const rows = this.db
      .query(
        "SELECT id, record FROM records WHERE kind='handoff' AND (json_extract(record,'$.project') IS NULL OR json_extract(record,'$.project')=?) AND EXISTS (SELECT 1 FROM json_each(record,'$.ids') WHERE key!='root' AND value=?)",
      )
      .all(project, bead);
    if (rows.length > 1) throw new Error("Multiple handoff receipts identify this bead");
    const row = rows[0];
    if (row === undefined) return undefined;
    const { id, record } = z.object({ id: z.uuid(), record: z.string() }).parse(row);
    return { id, ...storedHandoffIntentSchema.parse(JSON.parse(record)) };
  }
  saveIntent(id: string, value: HandoffIntent): void {
    this.save("handoff", id, value);
  }
}
/** An intentional no-command receipt records completion, not an independent review verdict. */
export function completedWithoutExecutable(attempt: Execution): boolean {
  return (
    attempt.check.length === 0 &&
    attempt.verification?.check.length === 0 &&
    attempt.verification.exitCode === null &&
    attempt.verifier?.phase === VerificationPhase.Complete
  );
}

export const unsettled = (record: Execution): boolean =>
  record.phase !== ExecutionPhase.Complete && record.phase !== ExecutionPhase.Parked;
