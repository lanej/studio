import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isDeepStrictEqual } from "node:util";
import { describePlan } from "../lead-plan.ts";
import type { SocratesState } from "./controls.ts";
import { missingReviewInput } from "./assessment.ts";
import { reviewInput, specText } from "./spec.ts";

/** Pi delivers operator input before `context`, including steering between tool calls. */
export function registerDiscoveryReview<T extends SocratesState>(
  pi: ExtensionAPI,
  identity: (record: T) => string,
  snapshot: (ctx: ExtensionContext) => T | undefined,
) {
  let observed: { id: string; session: string; record: T } | undefined;
  pi.on("context", (event, ctx) => {
    observed = undefined;
    const record = snapshot(ctx);
    if (!record?.specification || record.handoff || record.approved !== undefined) return;
    const spec = record.specification;
    const plan = record.leadPlan?.draft;
    const summary = [
      "Current saved discovery",
      specText(spec),
      ...(missingReviewInput(spec)
        ? [
            "Earlier operator guidance was not retained by this version of Studio. Recover it from the conversation or clarify it with the operator, then save a complete assessment.",
          ]
        : []),
      plan == null ? "No proposed work breakdown." : describePlan(plan, "proposal"),
    ].join("\n\n");
    const messages = [...event.messages];
    // Reinsert missing inputs in their saved delivery order. A visible input remains at its
    // original position; restoring a compacted or foreign input never splits a tool exchange.
    let cursor = messages.length;
    for (const input of (spec.pendingReview?.inputs ?? []).toReversed()) {
      const index = messages.findLastIndex(
        (message, i) =>
          i < cursor &&
          message.role === "user" &&
          message.timestamp === input.timestamp &&
          isDeepStrictEqual(reviewInput.parse(message).content, input.content),
      );
      if (index >= 0) cursor = index;
      else messages.splice(cursor, 0, { role: "user", ...input });
    }
    const current: ContextEvent["messages"][number] = {
      role: "custom",
      customType: "studio:discovery-review",
      display: false,
      timestamp: 0,
      content: summary,
    };
    observed = {
      id: identity(record),
      session: ctx.sessionManager.getSessionId(),
      record,
    };
    return { messages: [current, ...messages] };
  });
  return (record: T, ctx: ExtensionContext): void => {
    if (
      !observed ||
      observed.session !== ctx.sessionManager.getSessionId() ||
      observed.id !== identity(record) ||
      observed.record.revision !== record.revision ||
      !isDeepStrictEqual(observed.record.specification, record.specification) ||
      !isDeepStrictEqual(observed.record.leadPlan, record.leadPlan)
    )
      throw new Error(
        "The discovery changed since the model's last request. Review the current specification, operator input and work breakdown before retrying.",
      );
  };
}
