import { readTaskEvidence } from "../tasks/evidence.ts";
import { workerAssignments, type WorkerAssignment } from "../tasks/workers.ts";
import type {
  ReasoningLevel,
  StudioConfig,
  TaskAssignment,
} from "../config.ts";
import { TaskStatus, knownTaskStatus } from "../beads.ts";
import { HandoffPhase, type Discovery } from "../discovery/store.ts";
import {
  LeadMode,
  deliveryOutcome,
  orderedTasks,
  planDigest,
  type LeadDraft,
} from "../lead-plan.ts";
import { taskWaves } from "../smart-plan-graph.ts";
import { TaskBeads, sameBrief, type NativeBead } from "../task-service.ts";
import { propertyGaps, SpecStatus, type LeadSpecification } from "./spec.ts";

type BeadsAuthority = NonNullable<StudioConfig["beadsService"]>;

/** Shared by a private discovery and an existing task-bound lead. */
export interface ImplementationSource {
  revision: string | null;
  specification?: LeadSpecification | undefined;
  leadPlan?: Discovery["leadPlan"] | undefined;
  graph?: Readonly<Record<string, string>> | undefined;
  approved?: string | undefined;
  handoff?: Discovery["handoff"] | undefined;
  source?: BeadsAuthority | undefined;
  bead?: NativeBead | undefined;
}

export enum ImplementationState {
  Proposed = "proposed",
  Unknown = "unknown",
  Open = "open",
  InProgress = "in_progress",
  Blocked = "blocked",
  Deferred = "deferred",
  Closed = "closed",
}

export enum ImplementationPhase {
  NotPlanned = "not-planned",
  Proposed = "proposed",
  HandoffPending = "handoff-pending",
  HandoffUncertain = "handoff-uncertain",
  LinkChanged = "link-changed",
  Loading = "loading",
  Unavailable = "unavailable",
  Tracking = "tracking",
}

type TextField = {
  label:
    | "Acceptance"
    | "Worker"
    | "Model"
    | "Requirements"
    | "Depends on"
    | "Owns"
    | "Admission"
    | "Verification"
    | "Bead";
  value: string;
};

export type ImplementationField =
  | TextField
  | { label: "Reasoning"; value: ReasoningLevel }
  | { label: "Delivery"; value: string; pending: boolean };

export interface ImplementationRow {
  id: string;
  label: string;
  state: ImplementationState;
  status: string;
  wave: number;
  beadId?: string | undefined;
  requirements: readonly string[];
  blockedBy: readonly string[];
  assignment?: TaskAssignment | undefined;
  description: string;
  fields: readonly ImplementationField[];
  issue?: string | undefined;
  details: string;
}

export interface ImplementationRead {
  /** Bind asynchronous observations to this exact plan, authority and task set. */
  key: string;
  authority: BeadsAuthority;
  ids: readonly string[];
  matches(bead: NativeBead): boolean;
}

export type ImplementationObservation =
  | { key: string; state: "loading" }
  | { key: string; state: "unavailable"; message?: string | undefined }
  | {
      key: string;
      state: "current";
      tasks: readonly NativeBead[];
      workers?: readonly WorkerAssignment[];
      workerEvidenceError?: string | undefined;
    };

export interface ImplementationPresentation {
  phase: ImplementationPhase;
  label: string;
  detail: string;
  planSummary?: string | undefined;
  specificationVersion?: number | undefined;
  rows: ImplementationRow[];
  counts: Record<ImplementationState, number>;
}

interface Link {
  authority: BeadsAuthority;
  ids: Readonly<Record<string, string>>;
  digest: string;
  discovery: boolean;
}

/** A confirmed metadata write did not change the brief. No approval or coverage token is minted here. */
export function assessmentRevision(
  source: ImplementationSource,
): string | null {
  const plan = source.leadPlan;
  const spec = source.specification;
  if (
    source.bead === undefined ||
    source.source === undefined ||
    plan?.mode !== LeadMode.Implementing ||
    spec?.status !== SpecStatus.Frozen ||
    plan.specificationVersion !== spec.version ||
    plan.briefRevisionAdvance?.from !== spec.acceptedRevision ||
    plan.briefRevisionAdvance.to !== source.revision ||
    plan.digest !== planDigest(plan.draft)
  )
    return source.revision;
  return spec.acceptedRevision;
}

function approvedLink(source: ImplementationSource): Link | undefined {
  const plan = source.leadPlan;
  if (plan?.draft == null) return undefined;
  const digest = planDigest(plan.draft);
  let link: Link;
  if (source.approved !== undefined || source.handoff !== undefined) {
    const handoff = source.handoff;
    if (
      source.approved !== digest ||
      source.graph === undefined ||
      handoff?.phase !== HandoffPhase.Complete ||
      handoff.digest !== digest ||
      handoff.revision !== source.revision ||
      handoff.target.id !== handoff.target.source.projectId ||
      (source.specification !== undefined &&
        (source.specification.status !== SpecStatus.Frozen ||
          source.specification.acceptedRevision !== source.revision))
    )
      return undefined;
    link = {
      authority: handoff.target.source,
      ids: source.graph,
      digest,
      discovery: true,
    };
  } else {
    if (
      plan.mode !== LeadMode.Implementing ||
      plan.digest !== digest ||
      source.source === undefined ||
      (plan.specificationVersion !== undefined &&
        plan.specificationVersion !== source.specification?.version)
    )
      return undefined;
    link = {
      authority: source.source,
      ids:
        plan.draft.tasks.length === 0 && source.bead !== undefined
          ? { root: source.bead.id }
          : plan.children,
      digest,
      discovery: false,
    };
  }
  const keys =
    plan.draft.tasks.length === 0
      ? ["root"]
      : plan.draft.tasks.map((task) => task.key);
  const ids = keys.map((key) => link.ids[key]);
  return keys.some((key) => !Object.hasOwn(link.ids, key)) ||
    ids.some((id) => id === undefined || id.length === 0) ||
    new Set(ids).size !== ids.length
    ? undefined
    : link;
}

/** Read only linked tasks from the pinned authority, never the global task list. */
export function implementationRead(
  source: ImplementationSource,
): ImplementationRead | undefined {
  const link = approvedLink(source);
  const draft = source.leadPlan?.draft;
  if (link === undefined || draft == null) return undefined;
  const keys =
    draft.tasks.length === 0
      ? ["root"]
      : orderedTasks(draft).map((task) => task.key);
  const keyByBead = new Map(
    keys.flatMap((key) => {
      const id = link.ids[key];
      return id === undefined ? [] : [[id, key] as const];
    }),
  );
  const ids = [...keyByBead.keys()];
  return {
    key: JSON.stringify([
      source.revision,
      link.digest,
      link.authority.url,
      link.authority.projectId,
      ids,
    ]),
    authority: link.authority,
    ids,
    matches(bead) {
      const key = keyByBead.get(bead.id);
      if (key === undefined) return false;
      if (!link.discovery) {
        return key === "root"
          ? source.bead !== undefined && sameBrief(source.bead, bead)
          : bead.metadata["pi.plan"] === link.digest &&
              bead.metadata["pi.plan_key"] === key;
      }
      const task = bead.metadata["studio.task"];
      return (
        bead.metadata["studio.graph"] === source.revision &&
        bead.metadata["studio.approval"] === link.digest &&
        typeof task === "object" &&
        task !== null &&
        "key" in task &&
        task.key === key
      );
    },
  };
}

/** No claims, graph mutations, or runtime changes are made while observing. */
export async function readImplementation(
  source: ImplementationSource,
): Promise<ImplementationObservation | undefined> {
  const request = implementationRead(source);
  if (request === undefined) return undefined;
  try {
    const service = new TaskBeads(request.authority);
    const results = await Promise.allSettled(
      request.ids.map((id) => service.get(id)),
    );
    const tasks = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    if (tasks.length === 0)
      return {
        key: request.key,
        state: "unavailable",
        message: "Current status could not be read for any linked bead.",
      };
    // The lead observes its assigned children. Its own root can also be in progress.
    const children = request.ids.filter((id) => id !== source.bead?.id);
    const confirmed = tasks.filter(
      (bead) =>
        bead.id !== source.bead?.id &&
        request.matches(bead) &&
        knownTaskStatus(bead.status) !== undefined,
    );
    const observed = {
      key: request.key,
      state: "current" as const,
      tasks,
      workerEvidenceError:
        confirmed.length === children.length
          ? undefined
          : "Current status could not be confirmed for every linked bead.",
    };
    const active = confirmed.filter(
      (bead) =>
        knownTaskStatus(bead.status) === TaskStatus.InProgress &&
        bead.assignee.startsWith("pi:"),
    );
    if (active.length === 0) return observed;
    const project = request.authority.projectId;
    const owners = active.map((bead) => bead.assignee.slice("pi:".length));
    const evidence = readTaskEvidence(project, undefined, owners);
    return {
      ...observed,
      workers: workerAssignments(project, active, evidence),
      workerEvidenceError:
        evidence.evidenceError ??
        evidence.interactiveEvidenceError ??
        observed.workerEvidenceError,
    };
  } catch (error) {
    return {
      key: request.key,
      state: "unavailable",
      message:
        error instanceof Error ? error.message : "Beads could not be read.",
    };
  }
}

const statusLabels = {
  [ImplementationState.Proposed]: "Proposed",
  [ImplementationState.Unknown]: "Unknown",
  [ImplementationState.Open]: "Open",
  [ImplementationState.InProgress]: "In progress",
  [ImplementationState.Blocked]: "Blocked",
  [ImplementationState.Deferred]: "Deferred",
  [ImplementationState.Closed]: "Closed",
} satisfies Record<ImplementationState, string>;

const taskStates = {
  [TaskStatus.Open]: ImplementationState.Open,
  [TaskStatus.InProgress]: ImplementationState.InProgress,
  [TaskStatus.Blocked]: ImplementationState.Blocked,
  [TaskStatus.Deferred]: ImplementationState.Deferred,
  [TaskStatus.Closed]: ImplementationState.Closed,
} satisfies Record<TaskStatus, ImplementationState>;

/** Beads reports task state; approval and Socrates assessments never imply it. */
export function implementationPresentation(
  source: ImplementationSource,
  observation?: ImplementationObservation,
): ImplementationPresentation {
  const plan = source.leadPlan;
  const draft = plan?.draft;
  const link = approvedLink(source);
  const request = implementationRead(source);
  const current =
    request !== undefined && observation?.key === request.key
      ? observation
      : undefined;
  let phase: ImplementationPhase;
  let label: string;
  let detail: string;
  if (draft == null) {
    phase = ImplementationPhase.NotPlanned;
    label = "Not planned";
    detail = "No implementation breakdown yet.";
  } else if (source.handoff?.phase === HandoffPhase.Uncertain) {
    phase = ImplementationPhase.HandoffUncertain;
    label = "Handoff needs review";
    detail = "Task creation is unconfirmed. Reconcile the retained handoff.";
  } else if (
    source.handoff?.phase === HandoffPhase.Pending ||
    plan?.mode === LeadMode.Applying
  ) {
    phase = ImplementationPhase.HandoffPending;
    label = "Creating beads";
    detail = "Approval is recorded; task creation is not yet confirmed.";
  } else if (
    source.approved === undefined &&
    source.handoff === undefined &&
    plan?.mode !== LeadMode.Implementing
  ) {
    phase = ImplementationPhase.Proposed;
    if (
      source.bead === undefined &&
      source.specification?.status !== SpecStatus.Frozen
    ) {
      label = source.specification === undefined ? "Local plan" : "Draft";
      detail = "Draft work breakdown";
    } else if (
      source.bead === undefined &&
      source.specification !== undefined &&
      propertyGaps(source.specification, source.revision).length > 0
    ) {
      label = "Review properties";
      detail = "Reassess this breakdown before approval.";
    } else {
      label = "Awaiting approval";
      detail = "Proposed breakdown";
    }
  } else if (request === undefined) {
    phase = ImplementationPhase.LinkChanged;
    label = "Plan link needs review";
    detail = "The saved approval no longer identifies this exact breakdown.";
  } else if (current?.state === "unavailable") {
    phase = ImplementationPhase.Unavailable;
    label = "Beads unavailable";
    detail = current.message ?? "Current task status could not be read.";
  } else if (current?.state !== "current") {
    phase = ImplementationPhase.Loading;
    label = "Reading Beads";
    detail = "Approved breakdown; current task status is not yet observed.";
  } else {
    phase = ImplementationPhase.Tracking;
    label = "Approved";
    detail = "Beads task status";
  }
  const version =
    plan?.mode === LeadMode.Implementing || plan?.mode === LeadMode.Applying
      ? plan.specificationVersion
      : source.specification?.version;
  const observed = new Map(
    current?.state === "current"
      ? current.tasks.map((task) => [task.id, task])
      : [],
  );
  const duplicateIds = new Set<string>();
  if (current?.state === "current") {
    const seen = new Set<string>();
    for (const task of current.tasks) {
      if (seen.has(task.id)) duplicateIds.add(task.id);
      seen.add(task.id);
    }
  }
  const tasks: LeadDraft["tasks"] =
    draft == null
      ? []
      : draft.tasks.length === 0 && source.bead !== undefined
        ? [
            {
              key: "root",
              title: source.bead.title,
              description: draft.summary,
              acceptance: source.bead.acceptance_criteria,
              requirements:
                source.specification?.draft?.requirements.map(({ id }) => id) ??
                [],
              blockedBy: [],
              owns: [],
            },
          ]
        : orderedTasks(draft);
  const waves = taskWaves(tasks);
  const rows = tasks.map((task): ImplementationRow => {
    const beadId = link?.ids[task.key];
    const bead = beadId === undefined ? undefined : observed.get(beadId);
    let state =
      phase === ImplementationPhase.Proposed
        ? ImplementationState.Proposed
        : ImplementationState.Unknown;
    let issue: string | undefined;
    if (phase === ImplementationPhase.Tracking && bead !== undefined) {
      if (request?.matches(bead) !== true || duplicateIds.has(bead.id))
        issue = "The observed bead no longer identifies this approved task.";
      else {
        const known = knownTaskStatus(bead.status);
        if (known === undefined)
          issue = `Unrecognized Beads status: ${bead.status}`;
        else state = taskStates[known];
      }
    } else if (phase === ImplementationPhase.Tracking)
      issue = "No current observation for this bead.";
    const unassigned =
      task.delivery === undefined &&
      phase === ImplementationPhase.Proposed &&
      source.bead === undefined;
    const delivery = unassigned
      ? "To be decided"
      : `${deliveryOutcome(task.delivery)}${task.delivery === undefined ? " (default)" : ""}`;
    const worker =
      link?.discovery === true
        ? source.handoff?.workers?.[task.key]
        : undefined;
    const field = (label: TextField["label"], value?: string) =>
      value === undefined || value === "" ? [] : [{ label, value }];
    const fields: ImplementationField[] = [
      ...field("Acceptance", task.acceptance),
      ...field("Worker", task.assignment?.capability),
      ...(task.assignment === undefined
        ? []
        : [{ label: "Reasoning", value: task.assignment.reasoning } as const]),
      ...field(
        "Model",
        worker === undefined ? undefined : `${worker.provider}/${worker.model}`,
      ),
      ...field("Requirements", task.requirements.join(", ")),
      ...field("Depends on", task.blockedBy.join(", ")),
      ...field(
        "Owns",
        task.owns.length === 0
          ? "Entire isolated checkout"
          : task.owns.join(", "),
      ),
      ...field("Admission", task.hold === true ? "On hold" : undefined),
      { label: "Delivery", value: delivery, pending: unassigned },
      ...field(
        "Verification",
        task.check === undefined || task.check.length === 0
          ? "Independent criterion review; no executable agreed"
          : JSON.stringify(task.check),
      ),
      ...field("Bead", beadId),
    ];
    return {
      id: task.key,
      label: task.title,
      state,
      status: statusLabels[state],
      wave: waves.get(task.key) ?? 1,
      beadId,
      requirements: task.requirements,
      blockedBy: task.blockedBy,
      assignment: task.assignment,
      description: task.description,
      fields,
      issue,
      details: [
        task.description,
        fields.map(({ label, value }) => `${label} · ${value}`).join("\n"),
        issue,
      ]
        .filter((part) => part !== undefined)
        .join("\n\n"),
    };
  });
  const counts = {
    [ImplementationState.Proposed]: 0,
    [ImplementationState.Unknown]: 0,
    [ImplementationState.Open]: 0,
    [ImplementationState.InProgress]: 0,
    [ImplementationState.Blocked]: 0,
    [ImplementationState.Deferred]: 0,
    [ImplementationState.Closed]: 0,
  };
  for (const row of rows) counts[row.state]++;
  return {
    phase,
    label,
    detail,
    planSummary: draft?.summary,
    specificationVersion: version,
    rows,
    counts,
  };
}
