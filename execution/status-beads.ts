import { isDeepStrictEqual } from "node:util";
import { realpathSync } from "node:fs";
import { BeadsError } from "@lanej/task-runtime/beads";
import { z } from "zod";
import { knownTaskStatus, TaskStatus } from "../beads.ts";
import { loadConfig } from "../config.ts";
import { beadSchema, TaskBeads, type NativeBead } from "../task-service.ts";
import { ExecutionPhase } from "./phase.ts";
import { ExecutionStore } from "./store.ts";
import type { RuntimeProject } from "./target.ts";

export const beadEditSchema = z.strictObject({
  title: z
    .string()
    .trim()
    .min(1)
    .regex(/^[^\p{Cc}\u2028\u2029]+$/u, "Enter a single-line title")
    .optional(),
  description: z.string().optional(),
  acceptance_criteria: z.string().optional(),
  priority: z.number().int().min(0).max(4).optional(),
});
export type BeadEdit = z.infer<typeof beadEditSchema>;
export type BeadAction = { kind: "close"; reason: string } | { kind: "delete" } | { kind: "edit"; patch: BeadEdit };

type BeadTarget = { project: string; id: string };
export interface RuntimeBead {
  target: BeadTarget;
  source: RuntimeProject["source"];
  bead: NativeBead;
  blocked: string | undefined;
}

class RuntimeBeads extends TaskBeads {
  constructor(
    readonly source: RuntimeProject["source"],
    readonly enrollmentBlock?: string,
  ) {
    super(source);
  }

  async change(bead: NativeBead, action: BeadAction): Promise<NativeBead | undefined> {
    await this.verifyAuthority();
    try {
      if (action.kind === "close") {
        const receipt = await this.result(
          this.client.POST("/v0/beads/issues/{id}:close", {
            params: { path: { id: bead.id } },
            body: {
              actor: "studio-runtime-operator",
              expected_version: bead.revision,
              reason: action.reason,
              force: false,
            },
          }),
        );
        const closed = beadSchema.parse({ ...receipt.issue, revision: receipt.revision });
        if (closed.id === bead.id && knownTaskStatus(closed.status) === TaskStatus.Closed) return closed;
      } else if (action.kind === "delete") {
        const receipt = await this.result(
          this.client.POST("/v0/beads/issues:delete", {
            body: {
              actor: "studio-runtime-operator",
              ids: [bead.id],
              expected_version: bead.revision,
              force: false,
              cascade: false,
              dry_run: false,
            },
          }),
        );
        if (!receipt.dry_run && receipt.deleted === 1) return undefined;
      } else {
        const patch = beadEditSchema.parse(action.patch);
        const receipt = await this.result(
          this.client.PATCH("/v0/beads/issues/{id}", {
            params: { path: { id: bead.id } },
            body: {
              actor: "studio-runtime-operator",
              expected_version: bead.revision,
              expected_status: bead.status,
              expected_assignee: bead.assignee,
              force_close_policy: false,
              force_assignee_transfer: false,
              patch: {
                ...(patch.title === undefined ? {} : { title: patch.title }),
                ...(patch.description === undefined ? {} : { description: patch.description }),
                ...(patch.acceptance_criteria === undefined ? {} : { acceptance_criteria: patch.acceptance_criteria }),
                ...(patch.priority === undefined ? {} : { priority: patch.priority }),
              },
            },
          }),
        );
        const edited = beadSchema.parse({ ...receipt.issue, revision: receipt.revision });
        if (edited.id === bead.id) return edited;
      }
      throw new Error("Beads returned an unexpected receipt");
    } catch (cause) {
      if (cause instanceof BeadsError && cause.status < 500) {
        const problem = z.object({ detail: z.string().trim().min(1) }).safeParse(cause.problem);
        if (!problem.success) throw cause;
        const detail = problem.data.detail.replace(/[\p{Cc}\s]+/gu, " ");
        throw new Error(`${cause.message.trim()} · ${detail}`, { cause });
      }
      throw new Error("Beads did not confirm the outcome. Reload the bead before deciding whether to try again.", {
        cause,
      });
    }
  }
}

function retainedBlocker(target: BeadTarget): string | undefined {
  const store = new ExecutionStore(undefined, true);
  try {
    const allocation = store.allocationOwner();
    const holder = store
      .attempts()
      .find(
        (attempt) =>
          attempt.project === target.project &&
          attempt.bead?.id === target.id &&
          (attempt.phase !== ExecutionPhase.Complete || allocation?.attempt === attempt.id),
      );
    return holder === undefined
      ? undefined
      : `Studio still retains ownership or recovery state for attempt ${holder.id}`;
  } finally {
    store.close();
  }
}

function beadBlocker(source: RuntimeProject["source"], bead: NativeBead): string | undefined {
  if (source.reviewOnly === true) return "This Beads authority is review-only";
  const status = knownTaskStatus(bead.status);
  if (status === undefined) return "Beads reports an unrecognized task status";
  if (status === TaskStatus.InProgress || (status !== TaskStatus.Closed && bead.assignee !== ""))
    return "This bead has an active assignment";
  return undefined;
}

async function runtimeBeads(projectId: string): Promise<RuntimeBeads> {
  const config = await loadConfig();
  const store = new ExecutionStore(undefined, true);
  try {
    const enrolled = store.projects().find(({ id }) => id === projectId);
    const configured = config.runtime.projects.find(({ source }) => source.projectId === projectId);
    if (
      enrolled === undefined ||
      configured === undefined ||
      realpathSync(configured.root) !== enrolled.root ||
      !isDeepStrictEqual(configured.source, enrolled.source)
    )
      throw new Error("The project must have a matching Studio enrollment and Beads configuration");
    const enrollmentBlock =
      "claimLabel" in enrolled && enrolled.claimLabel !== undefined
        ? "Legacy enrollment has a retained claim label. Reconcile its claim scope before changing beads."
        : undefined;
    return new RuntimeBeads(configured.source, enrollmentBlock);
  } finally {
    store.close();
  }
}

export async function inspectRuntimeBead(target: BeadTarget): Promise<RuntimeBead> {
  const service = await runtimeBeads(target.project);
  const bead = await service.get(target.id);
  return {
    target,
    source: service.source,
    bead,
    blocked: service.enrollmentBlock ?? beadBlocker(service.source, bead) ?? retainedBlocker(target),
  };
}

export async function changeRuntimeBead(before: RuntimeBead, action: BeadAction): Promise<NativeBead | undefined> {
  const current = await inspectRuntimeBead(before.target);
  if (!isDeepStrictEqual(current.source, before.source) || current.bead.revision !== before.bead.revision)
    throw new Error("The bead or its authority changed. Reload it and review the current record.");
  if (current.blocked !== undefined) throw new Error(current.blocked);
  if (action.kind === "close") {
    if (knownTaskStatus(current.bead.status) === TaskStatus.Closed) throw new Error("The bead is already closed");
    if (action.reason.trim() === "" || /[\p{Cc}\u2028\u2029]/u.test(action.reason))
      throw new Error("Enter a nonempty, single-line close reason");
  }
  const service = new RuntimeBeads(current.source);
  return service.change(current.bead, action);
}
