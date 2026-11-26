import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { stateDirectory } from "../attempts.ts";
import {
  LeadMode,
  TaskDelivery,
  leadPlanSchema,
  planDigest,
  planWorkersSchema,
  type LeadDraft,
  type PlanWorkers,
} from "../lead-plan.ts";
import { runtimeProjectSchema } from "../config.ts";
import {
  draftDeliveryPolicy,
  specRecord,
  SpecStatus,
  specificationGaps,
  type DeliveryPolicy,
} from "../socrates/spec.ts";
import { pendingCoverageReview, specificationToken } from "../socrates/assessment.ts";
import {
  commitOperation,
  initializeOperationWitnesses,
  transaction,
  type OperationWitness,
} from "../operation-witness.ts";

export enum HandoffPhase {
  Pending = "pending",
  Complete = "complete",
  Uncertain = "uncertain",
}
export const discoverySchema = z.object({
  id: z.uuid(),
  title: z.string().min(1),
  project: z.string(),
  conversation: z.string(),
  revision: z.string(),
  specification: specRecord.optional(),
  history: z.array(specRecord).default([]),
  leadPlan: leadPlanSchema,
  planSpecificationRevision: z.string().optional(),
  handoff: z
    .object({
      operation: z.uuid(),
      digest: z.string(),
      revision: z.string(),
      phase: z.enum(HandoffPhase),
      workers: planWorkersSchema.optional(),
      owner: z.object({ pid: z.number().int().positive(), started: z.string() }).optional(),
      target: runtimeProjectSchema
        .extend({ id: z.uuid() })
        .refine(
          (project) => project.id === project.source.projectId,
          "Handoff project authority differs from its configured source",
        ),
    })
    .optional(),
  approved: z.string().optional(),
  graph: z.record(z.string(), z.string()).optional(),
});
export type Discovery = z.infer<typeof discoverySchema>;

/** Resolve each proposed bead against the same publication decision shown at freeze. */
export function applyDeliveryPolicy(draft: LeadDraft, policy: DeliveryPolicy): LeadDraft {
  const tasks = draft.tasks.map((task) => {
    const publishes =
      policy.pullRequests === "per-bead" || (policy.pullRequests === "selected" && policy.publish.includes(task.key));
    const delivery = publishes ? TaskDelivery.PullRequest : TaskDelivery.Local;
    if (task.delivery !== undefined && task.delivery !== delivery)
      throw new Error(
        `Delivery for ${task.key} conflicts with decision ${policy.decisionId}. Revise the proposal or revisit the Socrates delivery decision.`,
      );
    return { ...task, delivery };
  });
  const { pullRequestMerge: previousMerge, ...proposal } = draft;
  if (previousMerge !== undefined && (policy.pullRequests === "none" || previousMerge !== policy.merge))
    throw new Error("The proposed merge rule conflicts with the Socrates delivery decision");
  return policy.pullRequests === "none"
    ? { ...proposal, tasks }
    : { ...proposal, tasks, pullRequestMerge: policy.merge };
}

/** Persist a proposal against its current specification without certifying the old assessment. */
export function saveDiscoveryPlan(
  row: Pick<Discovery, "specification" | "leadPlan" | "planSpecificationRevision">,
  proposal: LeadDraft,
  linkSpecification = true,
): void {
  const existing = new Map(row.leadPlan.draft?.tasks.map((task) => [task.key, task]));
  const unassigned = proposal.tasks.find((task) => {
    const previous = existing.get(task.key);
    return task.assignment === undefined && (previous === undefined || previous.assignment !== undefined);
  });
  if (unassigned) throw new Error(`Specify worker capability and reasoning for task ${unassigned.key}`);

  const spec = row.specification;
  if (spec) {
    const requirements = spec.draft?.requirements.map(({ id }) => id) ?? [];
    if (proposal.tasks.some((task) => task.requirements.some((id) => !requirements.includes(id))))
      throw new Error("Link proposed tasks only to requirements in the current specification");
    if (linkSpecification) row.planSpecificationRevision = specificationToken(spec);
  }
  const policy = draftDeliveryPolicy(spec?.draft ?? null);
  const draft = !policy ? proposal : applyDeliveryPolicy(proposal, policy);
  if (spec?.coverageRevision !== undefined && !isDeepStrictEqual(draft, row.leadPlan.draft))
    spec.pendingReview = pendingCoverageReview(spec, "plan");
  row.leadPlan = { ...row.leadPlan, mode: LeadMode.Planning, draft };
}

/** A proposal is editable throughout discovery. Only this reviewed form may reach the runtime. */
export function handoffDraft(record: Discovery): LeadDraft {
  const draft = record.leadPlan.draft;
  if (draft === null || draft.tasks.length === 0) throw new Error("Draft at least one executable task first");
  const retained = record.handoff;
  if (retained) {
    if (retained.digest !== planDigest(draft) || retained.revision !== record.revision)
      throw new Error("Reconcile the original handoff with its recorded draft and revision");
    return draft;
  }
  const spec = record.specification;
  if (spec?.status !== SpecStatus.Frozen || spec.approvalAt === undefined || spec.draft === null)
    throw new Error(
      "Start /socrates and freeze the reviewed specification with /spec-freeze before handing work to the runtime",
    );
  const gaps = specificationGaps(spec, record.revision);
  if (gaps.length > 0) throw new Error(gaps.join("\n"));
  if (record.planSpecificationRevision !== specificationToken(spec))
    throw new Error("Update the work breakdown against the current frozen specification before approval");
  const policy = draftDeliveryPolicy(spec.draft);
  if (!policy || !isDeepStrictEqual(draft, applyDeliveryPolicy(draft, policy)))
    throw new Error("Update the proposed beads to match the settled delivery policy");
  if (policy.pullRequests === "selected") {
    const missing = policy.publish.filter((key) => !draft.tasks.some((task) => task.key === key));
    if (missing.length > 0)
      throw new Error(`The delivery decision names missing publishing beads: ${missing.join(", ")}`);
  }
  const requirements = spec.draft.requirements.map(({ id }) => id);
  if (
    draft.tasks.some(
      (task) => task.requirements.length === 0 || task.requirements.some((id) => !requirements.includes(id)),
    ) ||
    requirements.some((id) => !draft.tasks.some((task) => task.requirements.includes(id)))
  )
    throw new Error("Cover every frozen requirement and link each task to known requirement IDs");
  return draft;
}

/** Discovery is private conversational state, not another task backlog. */
export class Discoveries {
  private readonly db: Database;
  constructor(directory = stateDirectory()) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new Database(join(directory, "discoveries.sqlite"), {
      create: true,
    });
    this.db.run("PRAGMA busy_timeout=5000");
    this.db.run(
      "CREATE TABLE IF NOT EXISTS discoveries (id TEXT PRIMARY KEY, project TEXT NOT NULL, record TEXT NOT NULL)",
    );
    initializeOperationWitnesses(this.db);
  }
  beginHandoff(
    expected: Discovery,
    target: z.infer<typeof runtimeProjectSchema> & { id: string },
    owner?: { pid: number; started: string },
    recoverPending = false,
    workers?: PlanWorkers,
  ): Discovery {
    if (expected.leadPlan.draft === null) throw new Error("No displayed draft to approve");
    const digest = planDigest(expected.leadPlan.draft);
    return this.change(
      expected.id,
      (row) => {
        if (
          row.revision !== expected.revision ||
          row.project !== expected.project ||
          !isDeepStrictEqual(row.specification, expected.specification) ||
          row.leadPlan.draft === null ||
          planDigest(row.leadPlan.draft) !== digest
        )
          throw new Error("The displayed draft changed before approval; review it again");
        handoffDraft(row);
        const retained = row.handoff;
        if (
          retained &&
          (!isDeepStrictEqual(retained.target, target) ||
            !isDeepStrictEqual(retained.workers, workers) ||
            retained.digest !== digest ||
            retained.revision !== row.revision)
        )
          throw new Error(
            "The handoff retains its original project authority and draft, including worker selections; restore the approved configuration to reconcile it",
          );
        if (
          retained?.phase === HandoffPhase.Pending &&
          (!recoverPending || !owner || !isDeepStrictEqual(retained, expected.handoff))
        )
          throw new Error("This exact handoff is already in progress; inspect its outcome before retrying");
        row.handoff = {
          operation: retained && retained.phase !== HandoffPhase.Complete ? retained.operation : randomUUID(),
          digest,
          revision: row.revision,
          target,
          workers,
          phase: HandoffPhase.Pending,
          owner,
        };
      },
      true,
    );
  }
  close(): void {
    this.db.close();
  }
  list(project: string): Discovery[] {
    return this.db
      .query("SELECT record FROM discoveries WHERE project=? ORDER BY rowid DESC")
      .all(realpathSync(project))
      .map(decode);
  }
  find(id: string): Discovery | undefined {
    const row = this.db.query("SELECT record FROM discoveries WHERE id=?").get(id);
    return row === null ? undefined : decode(row);
  }
  get(id: string): Discovery {
    const record = this.find(id);
    if (!record) throw new Error(`Unknown discovery: ${id}`);
    return record;
  }
  create(project: string, conversation: string, title: string): Discovery {
    const record: Discovery = {
      id: randomUUID(),
      title,
      project: realpathSync(project),
      conversation,
      revision: randomUUID(),
      history: [],
      leadPlan: { mode: LeadMode.Planning, draft: null },
    };
    this.db.query("INSERT INTO discoveries VALUES (?,?,?)").run(record.id, record.project, JSON.stringify(record));
    return record;
  }
  change(id: string, update: (record: Discovery) => void, handoff = false): Discovery {
    return transaction(this.db, () => this.update(id, update, handoff));
  }
  changeWithWitness(
    id: string,
    operationId: string,
    command: string,
    update: (record: Discovery) => void,
    result: (record: Discovery) => string,
  ): OperationWitness {
    return commitOperation(this.db, id, operationId, command, () => result(this.update(id, update)));
  }
  private update(id: string, update: (record: Discovery) => void, handoff = false): Discovery {
    const record = this.get(id);
    if (!handoff && record.handoff && record.handoff.phase !== HandoffPhase.Complete)
      throw new Error("The approved handoff is pending or uncertain; reconcile it before editing this discovery");
    update(record);
    const checked = discoverySchema.parse(record);
    this.db.query("UPDATE discoveries SET record=? WHERE id=?").run(JSON.stringify(checked), id);
    return checked;
  }
}

function decode(value: unknown): Discovery {
  return discoverySchema.parse(JSON.parse(z.object({ record: z.string() }).parse(value).record));
}
