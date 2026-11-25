import { BeadsError, type components } from "@lanej/task-runtime/beads";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  TaskBeads,
  ClaimRefused,
  owner,
  type NativeBead,
} from "../task-service.ts";
import type { StudioProfile } from "../config.ts";
import { orderedTasks, type LeadDraft } from "../lead-plan.ts";
import { run } from "../process.ts";
import type { RuntimeProject } from "./store.ts";

/** This marker records an interactive parent's plan, never unattended authority. */
export function interactiveTask(bead: NativeBead): boolean {
  return Object.hasOwn(bead.metadata, "pi.plan_task");
}
export function requireUnattendedTask(bead: NativeBead): void {
  if (interactiveTask(bead))
    throw new Error(
      "Task-bound interactive children require studio start with their approved delivery mode; unattended execution is disabled",
    );
}

export class ExecutionBeads extends TaskBeads {
  private requireWritable(): void {
    if (this.readOnlyAuthority)
      throw new Error(
        "This Beads authority is review-only; unattended mutation is disabled",
      );
  }
  private readonly readOnlyAuthority: boolean;
  constructor(settings: ConstructorParameters<typeof TaskBeads>[0]) {
    super(settings);
    this.readOnlyAuthority = settings.reviewOnly === true;
  }
  async prefix(): Promise<string> {
    const setting = await this.result(
      this.client.GET("/v0/beads/config/{key}", {
        params: { path: { key: "issue_prefix" } },
      }),
    );
    return z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/u)
      .parse(setting.value);
  }
  async claimNext(attempt: string): Promise<NativeBead | undefined> {
    this.requireWritable();
    const list = (limit: number) =>
      this.result(
        this.client.GET("/v0/beads/ready", {
          params: {
            query: {
              unassigned: true,
              include_deferred: false,
              include_ephemeral: false,
              exclude_type: ["epic"],
              limit,
            },
          },
        }),
      );
    // The atomic queue API cannot exclude a metadata key. Inspect the complete ready
    // set, then retain the existing revision/status/owner CAS for the chosen brief.
    let ready = await list(1000);
    if (ready.has_more) {
      const count = await this.result(
        this.client.GET("/v0/beads/ready:count", {
          params: {
            query: {
              unassigned: true,
              include_deferred: false,
              include_ephemeral: false,
              exclude_type: ["epic"],
            },
          },
        }),
      );
      ready = await list(Math.max(1, count.total));
    }
    if (ready.has_more)
      throw new Error(
        "Ready-work inventory is truncated; no unattended claim was sent",
      );
    for (const candidate of ready.items) {
      if (Object.hasOwn(candidate.metadata ?? {}, "pi.plan_task")) continue;
      const before = await this.get(candidate.id);
      if (
        interactiveTask(before) ||
        before.status !== "open" ||
        before.assignee !== ""
      )
        continue;
      try {
        const revision = await this.claim(before, attempt);
        const detailed = await this.get(before.id);
        if (
          interactiveTask(detailed) ||
          detailed.revision !== revision ||
          detailed.status !== "in_progress" ||
          detailed.assignee !== owner(attempt) ||
          detailed.title !== before.title ||
          detailed.description !== before.description ||
          detailed.acceptance_criteria !== before.acceptance_criteria ||
          !isDeepStrictEqual(detailed.metadata, {
            ...before.metadata,
            "pi.attempt": attempt,
          })
        )
          throw new Error(
            "The claimed task authority changed; inspect the retained claim before dispatch",
          );
        return detailed;
      } catch (error) {
        // Only a definite rejected CAS/readiness race permits trying another row.
        // Transport failures retain this actor for ownership reconciliation.
        if (
          error instanceof ClaimRefused &&
          ((error.cause instanceof BeadsError && error.cause.status === 409) ||
            error.message === "Beads reports that this task is not ready")
        )
          continue;
        throw error;
      }
    }
    return undefined;
  }
  async owned(attempt: string): Promise<NativeBead[]> {
    const result = await this.result(
      this.client.GET("/v0/beads/issues", {
        params: { query: { assignee: owner(attempt), limit: 1000 } },
      }),
    );
    if (result.has_more)
      throw new Error(
        "Owned-claim reconciliation is truncated; inspect before retrying",
      );
    return Promise.all(result.items.map((item) => this.get(item.id)));
  }
  async bind(before: NativeBead, attempt: string): Promise<NativeBead> {
    this.requireWritable();
    const result = await this.result(
      this.client.PATCH("/v0/beads/issues/{id}", {
        params: { path: { id: before.id } },
        body: {
          actor: owner(attempt),
          expected_version: before.revision,
          expected_status: "in_progress",
          expected_assignee: owner(attempt),
          force_close_policy: false,
          force_assignee_transfer: false,
          patch: { metadata: { merge: { "pi.attempt": attempt } } },
        },
      }),
    );
    this.requireWritable();
    const current = await this.get(before.id);
    if (current.revision !== result.revision)
      throw new Error("Task changed while binding its native attempt");
    return current;
  }
  async finishAccepted(
    before: NativeBead,
    attempt: string,
    summary: string,
  ): Promise<NativeBead> {
    this.requireWritable();
    const current = await this.get(before.id);
    if (
      current.status === "closed" &&
      current.metadata["studio.completed"] === attempt
    )
      return current;
    await this.requireCurrent(before, before.revision, attempt);
    this.requireWritable();
    const result = await this.result(
      this.client.PATCH("/v0/beads/issues/{id}", {
        params: { path: { id: before.id } },
        body: {
          actor: owner(attempt),
          expected_version: before.revision,
          expected_status: "in_progress",
          expected_assignee: owner(attempt),
          force_close_policy: false,
          force_assignee_transfer: false,
          patch: {
            status: "closed",
            notes: summary,
            metadata: { merge: { "studio.completed": attempt } },
          },
        },
      }),
    );
    const confirmed = await this.get(before.id);
    if (confirmed.revision !== result.revision || confirmed.status !== "closed")
      throw new Error(
        "Completion needs reconciliation against the current task",
      );
    return confirmed;
  }
  async createGraph(
    id: string,
    digest: string,
    title: string,
    draft: LeadDraft,
    ids: Record<string, string>,
    profile?: StudioProfile,
    interactive = false,
  ): Promise<Record<string, string>> {
    this.requireWritable();
    const root = z.string().parse(ids["root"]);
    const mergePolicy =
      draft.pullRequestMerge === undefined
        ? {}
        : { "studio.pullRequestMerge": draft.pullRequestMerge };
    const items: components["schemas"]["ApplyItem"][] = [
      {
        kind: "create",
        create: {
          key: "root",
          id: root,
          title,
          description: draft.summary,
          issue_type: "epic",
          status: "in_progress",
          assignee: owner(id),
          metadata: {
            "studio.graph": id,
            "studio.approval": digest,
            "studio.container": true,
            ...mergePolicy,
          },
          ephemeral: false,
          no_history: false,
        },
      },
    ];
    for (const task of orderedTasks(draft)) {
      const issue = z.string().parse(ids[task.key]);
      items.push(
        {
          kind: "create",
          create: {
            key: task.key,
            id: issue,
            title: task.title,
            description: task.description,
            acceptance_criteria: task.acceptance,
            issue_type: "task",
            status: task.hold === true ? "deferred" : "open",
            ephemeral: false,
            no_history: false,
            metadata: {
              "studio.graph": id,
              "studio.approval": digest,
              "studio.task": task,
              ...mergePolicy,
              ...(profile === undefined ? {} : { "studio.profile": profile }),
              ...(interactive
                ? { "studio.interactive": true, "studio.graph": id }
                : {}),
              "studio.root": root,
            },
          },
        },
        {
          kind: "dep_add",
          dep_add: {
            source: { key: task.key },
            target: { key: "root" },
            type: "parent-child",
          },
        },
      );
      for (const blocker of task.blockedBy)
        items.push({
          kind: "dep_add",
          dep_add: {
            source: { key: task.key },
            target: { key: blocker },
            type: "blocks",
          },
        });
    }
    try {
      const result = await this.result(
        this.client.POST("/v0/beads/issues:batchApply", {
          body: {
            actor: owner(id),
            items,
            force_id_prefix: false,
            skip_per_edge_cycle_check: false,
          },
        }),
      );
      if (
        Object.entries(ids).some(([key, value]) => result.keys[key] !== value)
      )
        throw new Error("Beads returned a different graph identity");
    } catch (error) {
      // Deterministic create-only IDs make retries safe even when the first response is lost.
      if (
        error instanceof BeadsError &&
        ![409, 500, 503].includes(error.status)
      )
        throw error;
      const expected = items.flatMap((item) =>
        item.create === undefined ? [] : [item.create],
      );
      const records = await Promise.all(
        expected.map((item) => this.get(z.string().parse(item.id))),
      );
      const matches = records.every((record, index) => {
        const item = expected[index];
        if (item === undefined) return false;
        return (
          record.title === item.title &&
          record.description === (item.description ?? "") &&
          record.acceptance_criteria === (item.acceptance_criteria ?? "") &&
          record["issue_type"] === item.issue_type &&
          isDeepStrictEqual(
            Object.fromEntries(
              Object.entries(record.metadata).filter(
                ([key]) => !["pi.attempt", "studio.completed"].includes(key),
              ),
            ),
            item.metadata ?? {},
          )
        );
      });
      const actualEdges: string[] = [];
      for (let offset = 0; offset < records.length; offset += 100) {
        const batch = await this.result(
          this.client.GET("/v0/beads/dependencies", {
            params: {
              query: {
                issue_id: records
                  .slice(offset, offset + 100)
                  .map((record) => record.id),
              },
            },
          }),
        );
        if (batch.missing.length > 0)
          throw new Error(
            "Approved graph changed during handoff reconciliation",
          );
        actualEdges.push(
          ...batch.items.map((edge) =>
            JSON.stringify([edge.issue_id, edge.depends_on_id, edge.type]),
          ),
        );
      }
      const expectedEdges = items.flatMap((item) =>
        item.dep_add === undefined
          ? []
          : [
              JSON.stringify([
                ids[z.string().parse(item.dep_add.source.key)],
                ids[z.string().parse(item.dep_add.target.key)],
                item.dep_add.type,
              ]),
            ],
      );
      if (
        !matches ||
        !isDeepStrictEqual(actualEdges.sort(), expectedEdges.sort())
      )
        throw new Error(
          "Graph creation is uncertain or its reviewed brief, metadata, or dependency edges changed; inspect the retained handoff",
        );
    }
    return ids;
  }
}

export async function verifyHeartbeatAuthority(
  project: RuntimeProject,
): Promise<void> {
  // The pinned HTTP surface deliberately has no heartbeat verb. Never guess a route.
  const context = z
    .looseObject({
      project_id: z.string(),
      database: z.string(),
      backend: z.string(),
      dolt_mode: z.string(),
    })
    .parse(
      JSON.parse(
        await run(
          project.beadsExecutable,
          ["-C", project.beadsWorkspace, "context", "--json"],
          { cwd: project.beadsWorkspace, timeout: 15000 },
        ),
      ),
    );
  if (
    context.project_id !== project.id ||
    context.database !== project.beadsDatabase ||
    context.backend !== "dolt" ||
    context.dolt_mode !== "server"
  )
    throw new Error(
      "Heartbeat CLI workspace differs from the configured Beads service project",
    );
  const service = new ExecutionBeads(project.source);
  await service.verifyAuthority();
}
export async function heartbeat(
  project: RuntimeProject,
  attempt: string,
  bead: string,
): Promise<void> {
  if (project.source.reviewOnly === true)
    throw new Error(
      "This Beads authority is review-only; heartbeats are disabled",
    );
  await verifyHeartbeatAuthority(project);
  await run(
    project.beadsExecutable,
    [
      "-C",
      project.beadsWorkspace,
      "--actor",
      owner(attempt),
      "heartbeat",
      bead,
    ],
    { cwd: project.beadsWorkspace, timeout: 15000 },
  );
}
