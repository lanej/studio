import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { realpathSync, existsSync } from "node:fs";
import { z } from "zod";
import { loadConfig } from "../config.ts";
import { ExecutionBeads, requireUnattendedTask } from "./beads.ts";
import { retryWriterFence } from "./recovery.ts";
import {
  ExecutionStore,
  ExecutionPhase,
  latestDecision,
  hasUnappliedAnswer,
  pendingDecision,
  operatorDecisionSchema,
  type Execution,
  type OperatorDecision,
} from "./store.ts";

/** Excludes process/lease/result fields, which legitimately change while the accepted contract is retained. */
export function decisionContract(record: Execution): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        project: record.project,
        bead: record.bead,
        revision: record.revision,
        profile: record.profile,
        owns: record.owns,
        check: record.check,
        checkout: record.checkout,
        controller: record.controller,
        worker: record.worker,
        reviewer: record.reviewer,
        interactive: record.interactive,
      }),
    )
    .digest("hex");
}
export function recordDecision(
  store: ExecutionStore,
  id: string,
  question: string,
): void {
  const before = store.attempt(id);
  if (
    before.phase !== ExecutionPhase.Running ||
    before.interactive !== undefined ||
    before.bead === undefined ||
    before.revision === undefined ||
    before.launchToken === undefined
  )
    throw new Error(
      "Operator decisions require an admitted background worker launch",
    );
  if (pendingDecision(before) !== undefined)
    throw new Error("An operator decision is already pending");
  const request = operatorDecisionSchema.parse({
    id: randomUUID(),
    question,
    at: new Date().toISOString(),
    binding: {
      project: before.project,
      bead: before.bead.id,
      revision: before.revision,
      launchToken: before.launchToken,
      contract: decisionContract(before),
    },
  });
  store.change(id, (row) => {
    if (!isDeepStrictEqual(row, before))
      throw new Error("Attempt changed before recording the operator decision");
    row.operatorDecisions = z
      .array(operatorDecisionSchema)
      .max(8)
      .parse([...(row.operatorDecisions ?? []), request]);
    row.phase = ExecutionPhase.AwaitingDecision;
    row.message =
      "Worker requested an operator decision; claim and checkout remain retained";
  });
}
/** An answer is context, never permission to replace a retained publication identity. */
export function requireDecisionPublicationReconciled(
  record: Execution,
  directory: string,
): void {
  if (
    hasUnappliedAnswer(record) &&
    (record.publication !== undefined ||
      record.mergeReceipt !== undefined ||
      existsSync(join(directory, "delivery", record.id, "publication.json")))
  )
    throw new Error(
      "Operator answer retained but the prior publication must be reconciled before revising its approved head",
    );
}
const answerText = z
  .string()
  .min(1)
  .max(4000)
  .refine((value) => /\S/u.test(value), "Enter a nonblank answer");
function receipt(attempt: string, request: OperatorDecision) {
  if (request.answer === undefined) throw new Error("No answer receipt");
  return { attempt, request: request.id, answeredAt: request.answer.at };
}
export async function answerDecision(
  id: string,
  requestId: string,
  input: string,
) {
  const text = answerText.parse(input);
  z.uuid().parse(requestId);
  const store = new ExecutionStore();
  let result: ReturnType<typeof receipt>;
  try {
    const before = store.attempt(id);
    const request = latestDecision(before);
    if (request?.id !== requestId)
      throw new Error(
        "This decision request is stale or superseded; refresh the task",
      );
    if (request.answer !== undefined) {
      if (request.answer.text !== text)
        throw new Error("This request already has a different answer");
      return receipt(id, request); // Lost acknowledgements have no second queue or scheduler effect.
    }
    if (
      before.phase !== ExecutionPhase.AwaitingDecision ||
      before.interactive !== undefined
    )
      throw new Error(
        "The pending decision is not settled for answering; inspect its writer and authority first",
      );
    if (
      before.bead === undefined ||
      before.revision === undefined ||
      request.binding.project !== before.project ||
      request.binding.bead !== before.bead.id ||
      request.binding.revision !== before.revision ||
      request.binding.launchToken !== before.launchToken ||
      request.binding.contract !== decisionContract(before)
    )
      throw new Error(
        "The admitted decision binding or scope changed; reconcile before answering",
      );
    requireUnattendedTask(before.bead);
    if (await retryWriterFence(before))
      throw new Error(
        "The prior host/verifier may still be live or uncertain; answer was not queued",
      );
    const project = store.project(before.project);
    const configuration = await loadConfig();
    if (
      !configuration.runtime.projects.some(
        (configured) =>
          realpathSync(configured.root) === project.root &&
          isDeepStrictEqual(configured.source, project.source) &&
          configured.source.reviewOnly !== true,
      )
    )
      throw new Error(
        "This project's configured task authority changed; reconcile before answering",
      );
    await new ExecutionBeads(project.source).requireCurrent(
      before.bead,
      before.revision,
      id,
    );
    if (await retryWriterFence(before))
      throw new Error("A prior writer appeared during answer validation");
    const answered = {
      ...request,
      answer: { text, at: new Date().toISOString() },
    };
    const accepted = store.transaction(() => {
      const row = store.attempt(id);
      const current = latestDecision(row);
      if (current?.id === requestId && current.answer !== undefined) {
        if (current.answer.text !== text)
          throw new Error("This request already has a different answer");
        return { queued: false, receipt: receipt(id, current) };
      }
      // The supervisor can renew the paused attempt's lease during the Beads read.
      if (
        !isDeepStrictEqual(row, { ...before, heartbeatAt: row.heartbeatAt }) ||
        !isDeepStrictEqual(store.project(before.project), project)
      )
        throw new Error(
          "The attempt or project changed during answer validation; refresh and retry",
        );
      row.operatorDecisions = [
        ...(row.operatorDecisions ?? []).slice(0, -1),
        answered,
      ];
      row.phase = ExecutionPhase.Queued;
      row.launchToken = undefined;
      row.launchSettled = true;
      row.pid = undefined;
      row.started = undefined;
      row.message =
        "Operator answer recorded; same attempt queued with verification and review still required";
      store.saveAttempt(row);
      return { queued: true, receipt: receipt(id, answered) };
    });
    if (!accepted.queued) return accepted.receipt;
    result = accepted.receipt;
  } finally {
    store.close();
  }
  try {
    await (await import("./supervisor.ts")).ensureRuntime();
  } catch (error) {
    throw new Error(
      `Answer recorded and queued, but the runtime did not start: ${error instanceof Error ? error.message : String(error)}. Start the runtime after resolving this.`,
      { cause: error },
    );
  }
  return result;
}
