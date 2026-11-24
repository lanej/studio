import { expect, test } from "bun:test";
import {
  describePlan,
  draftSchema,
  planDigest,
  reviseDelivery,
} from "../lead-plan.ts";

test("delivery revisions change the approved draft and retain the explicit default", () => {
  const draft = draftSchema.parse({
    summary: "Mixed plan",
    tasks: [
      { key: "one", title: "One", description: "First", acceptance: "Done" },
      {
        key: "two",
        title: "Two",
        description: "Second",
        acceptance: "Done",
        delivery: "pull-request",
      },
    ],
  });
  expect(describePlan(draft)).toContain(
    "Local integration only — no PR (default)",
  );
  expect(describePlan(draft)).toContain("Opens a PR");
  const revised = reviseDelivery(draft, "one pull-request");
  expect(planDigest(revised)).not.toBe(planDigest(draft));
  expect(draft.tasks[0]?.delivery).toBeUndefined();
  expect(() => reviseDelivery(draft, "missing local")).toThrow();
  expect(() => reviseDelivery(draft, "one unknown")).toThrow();
});
