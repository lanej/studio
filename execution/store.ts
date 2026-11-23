import { Database } from "bun:sqlite";
import { isDeepStrictEqual } from "node:util";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { stateDirectory } from "../attempts.ts";
import {
  runtimeProjectSchema,
  studioProfileSchema,
  selection,
} from "../config.ts";
import { verificationSchema, beadSchema } from "../task-service.ts";
import {
  worktreeReservation,
  worktreeAllocation,
} from "../vendor/task-runtime/worktree-contracts.ts";

export enum ExecutionPhase {
  Queued = "queued",
  Claiming = "claiming",
  Allocating = "allocating",
  Launching = "launching",
  Running = "running",
  Reviewing = "reviewing",
  Integrating = "integrating",
  Delivery = "delivery-pending",
  Waiting = "correction-pending",
  Complete = "complete",
  Parked = "needs-review",
  Uncertain = "uncertain",
}
export const projectSchema = runtimeProjectSchema
  .extend({ id: z.uuid() })
  .refine(
    (project) => project.id === project.source.projectId,
    "Runtime project identity differs from its Beads source",
  );
export type RuntimeProject = z.infer<typeof projectSchema>;
export enum VerificationPhase {
  Launching = "launching",
  Running = "running",
  Complete = "complete",
}
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
  integrationExpected: z.string().optional(),
  base: z.string().optional(),
  head: z.string().optional(),
  pid: z.number().int().positive().optional(),
  started: z.string().optional(),
  launchToken: z.uuid().optional(),
  launchSettled: z.boolean().default(false),
  recoveries: z.number().int().nonnegative().default(0),
  controllerSession: z.string().optional(),
  controllerSessionFile: z.string().optional(),
  readyNotice: z.object({ id: z.string(), head: z.string() }).optional(),
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
  summary: z.string().default(""),
  review: z.string().optional(),
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
});
export type Supervisor = z.infer<typeof supervisorSchema>;

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
    const result = this.db
      .query("SELECT record FROM records WHERE kind=? AND id=?")
      .get(kind, id);
    return result === null
      ? undefined
      : JSON.parse(z.object({ record: z.string() }).parse(result).record);
  }
  private rows(kind: string): unknown[] {
    return this.db
      .query("SELECT record FROM records WHERE kind=? ORDER BY rowid")
      .all(kind)
      .map((row) => {
        const value: unknown = JSON.parse(
          z.object({ record: z.string() }).parse(row).record,
        );
        return value;
      });
  }
  private save(kind: string, id: string, record: unknown): void {
    this.db
      .query(
        "INSERT INTO records VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET record=excluded.record",
      )
      .run(kind, id, JSON.stringify(record));
  }
  projects(): RuntimeProject[] {
    return this.rows("project").map((row) => projectSchema.parse(row));
  }
  project(id: string): RuntimeProject {
    return projectSchema.parse(this.read("project", id));
  }
  validateEnrollment(input: RuntimeProject): RuntimeProject {
    const project = { ...input, root: realpathSync(input.root) };
    const current = this.projects().find(
      (item) => item.id === project.id || item.root === project.root,
    );
    if (
      current !== undefined &&
      (current.root !== project.root || current.id !== project.id)
    )
      throw new Error(
        "Project identity is already enrolled with a different repository",
      );
    if (
      current !== undefined &&
      !isDeepStrictEqual(
        { ...current, merge: undefined },
        { ...project, merge: undefined },
      ) &&
      this.attempts().some(
        (row) =>
          row.project === current.id && row.phase !== ExecutionPhase.Complete,
      )
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
  reserveInference(
    id: string,
    limit: number,
    update: (record: Execution) => void,
  ): boolean {
    return this.transaction(() => {
      const holders = this.attempts().filter(
        (row) =>
          row.id !== id &&
          row.launchToken !== undefined &&
          !row.launchSettled &&
          ![
            ExecutionPhase.Delivery,
            ExecutionPhase.Waiting,
            ExecutionPhase.Complete,
            ExecutionPhase.Parked,
          ].includes(row.phase),
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
  override(project: string): MergeOverride | undefined {
    return mergeOverrideSchema.optional().parse(this.read("merge", project));
  }
  setOverride(
    project: string,
    override: MergeOverride | undefined,
    audit?: { actor: string; reason: string },
  ): void {
    if (
      override === undefined &&
      (audit === undefined || audit.reason.trim().length === 0)
    )
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
      if (override === undefined)
        this.db
          .query("DELETE FROM records WHERE kind='merge' AND id=?")
          .run(project);
      else this.save("merge", project, mergeOverrideSchema.parse(override));
    });
  }
  intent(id: string): unknown {
    return this.read("handoff", id);
  }
  saveIntent(id: string, value: unknown): void {
    this.save("handoff", id, value);
  }
}
export const unsettled = (record: Execution): boolean =>
  record.phase !== ExecutionPhase.Complete &&
  record.phase !== ExecutionPhase.Parked;
