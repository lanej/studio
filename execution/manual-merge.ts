import { realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { loadConfig } from "../config.ts";
import { sha } from "../delivery-record.ts";
import { owner } from "../task-service.ts";
import { ExecutionBeads } from "./beads.ts";
import {
  ExecutionPhase,
  ExecutionStore,
  type Execution,
  type RuntimeProject,
} from "./store.ts";

export async function requireManualMergeAuthority(
  project: RuntimeProject,
): Promise<void> {
  const config = await loadConfig();
  const configured = config.runtime.projects.find(
    (item) => item.source.projectId === project.id,
  );
  if (
    !config.runtime.enabled ||
    !config.integrations.octo.enabled ||
    configured === undefined ||
    realpathSync(configured.root) !== project.root ||
    configured.base !== project.base ||
    configured.source.reviewOnly === true ||
    !isDeepStrictEqual(project.source, configured.source)
  )
    throw new Error(
      "Manual merge approval requires the enabled runtime, Octo, and this attempt's enrolled writable project",
    );
}

export function hasManualMergeApproval(
  attempt: Execution,
  notice: { id: string; head: string },
): boolean {
  const approval = attempt.manualMergeApproval;
  return (
    approval !== undefined &&
    approval.head === attempt.head &&
    approval.head === notice.head &&
    approval.notice === notice.id &&
    approval.pr === attempt.pr &&
    approval.agent === attempt.agent
  );
}

function manualMergeSubject(row: Execution, head: string) {
  if (row.phase !== ExecutionPhase.Delivery || row.merged !== undefined)
    throw new Error(
      "Only a delivery-pending attempt can receive merge approval",
    );
  const bead = row.bead;
  if (
    bead === undefined ||
    row.revision === undefined ||
    bead.status !== "in_progress" ||
    bead.assignee !== owner(row.id) ||
    bead.metadata["pi.attempt"] !== row.id
  )
    throw new Error("The attempt lacks its admitted task owner or revision");
  if (bead.metadata["studio.pullRequestMerge"] !== "manual")
    throw new Error(
      "This plan does not reserve PR merge approval for the operator",
    );
  if (
    row.head !== head ||
    row.readyNotice?.head !== head ||
    (row.review?.trim().length ?? 0) === 0 ||
    row.reviewFinding !== undefined ||
    row.agent === undefined ||
    row.pr === undefined ||
    row.url === undefined ||
    row.publication === undefined
  )
    throw new Error(
      "The supplied head is not the independently reviewed, ready head of this tracked PR",
    );
  if (
    row.mergeReceipt !== undefined &&
    !hasManualMergeApproval(row, row.readyNotice)
  )
    throw new Error(
      "Reconcile the existing merge intent before approving another one",
    );
  return {
    bead,
    revision: row.revision,
    project: row.project,
    review: row.review,
    notice: row.readyNotice.id,
    head,
    pr: row.pr,
    agent: row.agent,
    url: row.url,
    publication: row.publication,
    session: row.controllerSession,
  };
}

export async function recordManualMergeApproval(
  id: string,
  head: string,
): Promise<void> {
  sha.parse(head);
  const store = new ExecutionStore();
  try {
    const target = manualMergeSubject(store.attempt(id), head);
    const project = store.project(target.project);
    await requireManualMergeAuthority(project);
    const currentBead = await new ExecutionBeads(project.source).requireCurrent(
      target.bead,
      target.revision,
      id,
    );
    if (currentBead.metadata["studio.pullRequestMerge"] !== "manual")
      throw new Error(
        "The current bead no longer reserves merge approval for the operator",
      );
    await requireManualMergeAuthority(project);
    store.change(id, (row) => {
      const current = manualMergeSubject(row, head);
      if (
        !isDeepStrictEqual(current, target) ||
        !isDeepStrictEqual(store.project(target.project), project)
      )
        throw new Error(
          "The attempt or project changed during manual merge approval",
        );
      if (!hasManualMergeApproval(row, { id: current.notice, head })) {
        row.manualMergeApproval = {
          notice: current.notice,
          head,
          pr: current.pr,
          agent: current.agent,
          actor: userInfo().username,
          at: new Date().toISOString(),
        };
        row.message = `Operator approved merge of ${head}; waiting for the current Octo merge gate`;
      }
    });
  } finally {
    store.close();
  }
}
