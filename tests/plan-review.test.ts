import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { expect, test } from "bun:test";
import { draftSchema } from "../lead-plan.ts";
import { renderPlanReview, type PlanReview } from "../plan-review.ts";
import { reviewPlan } from "../ui.ts";

type TestTheme = Pick<Theme, "fg" | "bold">;
const theme: TestTheme = {
  fg(tone, text) {
    const code = tone === "border" ? 36 : tone === "syntaxNumber" ? 33 : 37;
    return `\x1b[${String(code)}m${text}\x1b[39m`;
  },
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
};

const review: PlanReview = {
  draft: draftSchema.parse({
    summary: "Implement the bounded change with a separate publishing task.",
    pullRequestMerge: "manual",
    tasks: [
      {
        key: "source",
        title: "Prepare \x1b[35mthe source\x1b[0m",
        description:
          "Keep the first scope local.\nPreserve the next paragraph.",
        acceptance: "Local integration is verified.",
        requirements: ["R1"],
        owns: ["src/source.ts"],
        check: ["bun", "test", "source"],
      },
      {
        key: "review",
        title: "Review the implementation",
        description: "Read the result.",
        acceptance: "Review evidence is saved.",
        hold: true,
        blockedBy: ["source"],
      },
      {
        key: "publish",
        title: "Publish the result",
        description: "Open the approved pull request.",
        acceptance: "The published change meets R1.",
        blockedBy: ["source"],
        delivery: "pull-request",
      },
    ],
  }),
  context: [
    { label: "Execution", value: "interactive in Zellij work, tab 2" },
    { label: "Project", value: "/example/local-project" },
    { label: "Beads", value: "example-beads" },
    { label: "Profile", value: "personal" },
    { label: "PR from publish", value: "Includes source, publish" },
  ],
  specification: "Objective · Scope is frozen.\n\nDecision · Merge manually.",
};

test("approval displays the colored dependency graph and complete structured context", () => {
  const rendered = renderPlanReview(review, theme, 80);
  const plain = rendered.map(stripTerminalSequences);
  const graphStart = plain.indexOf("Task dependencies");
  expect(plain.slice(graphStart + 1, graphStart + 6)).toEqual([
    "●    Prepare the source",
    "├─╮",
    "● │  Review the implementation  on hold",
    "  │",
    "  ●  Publish the result",
  ]);
  const raw = rendered.join("\n");
  expect(raw).toContain("\x1b[36m├");
  expect(raw).toContain("\x1b[33m╮");
  expect(raw).toContain("\x1b[1msource · Prepare the source");
  expect(raw).not.toContain("\x1b[35m");
  const all = plain.join("\n");
  for (const expected of [
    "Execution        interactive in Zellij work, tab 2",
    "Project          /example/local-project",
    "Beads            example-beads",
    "Profile          personal",
    "PR from publish  Includes source, publish",
    "Keep the first scope local.\nPreserve the next paragraph.",
    "Acceptance    Local integration is verified.",
    "Requirements  R1",
    "Owns          src/source.ts",
    "Admission     on hold",
    "Delivery      Local integration only — no PR (default)",
    "Delivery      Opens a PR",
    'Verification  ["bun","test","source"]',
    "Blocked by    source",
    "PR merge  manual",
    "Specification\nObjective · Scope is frozen.\n\nDecision · Merge manually.",
  ])
    expect(all).toContain(expected);

  const narrow = renderPlanReview(review, theme, 24);
  expect(narrow.every((line) => visibleWidth(line) <= 24)).toBe(true);
  const narrowPlain = narrow.map(stripTerminalSequences).join("\n");
  expect(narrowPlain).toContain("├─╮");
  expect(narrowPlain).toContain("Decision · Merge\nmanually.");
  expect(narrowPlain).toContain("src/source.ts");
});

function mountReview() {
  const mounted: { component?: Component; decision?: boolean } = {};
  const terminal = { rows: 11 };
  const ctx = {
    ui: {
      custom(
        mount: (
          tui: { terminal: typeof terminal; requestRender: () => void },
          theme: TestTheme,
          keys: undefined,
          done: (decision: boolean) => void,
        ) => Component,
      ) {
        return new Promise<boolean>((resolve) => {
          mounted.component = mount(
            { terminal, requestRender() {} },
            theme,
            undefined,
            (decision) => {
              mounted.decision = decision;
              resolve(decision);
            },
          );
        });
      },
    },
  } as unknown as ExtensionContext;
  const approval = reviewPlan(
    ctx,
    "Approve the change",
    review,
    "start implementation",
  );
  const component = mounted.component;
  if (component === undefined)
    throw new Error("Review component was not mounted");
  return { component, approval, mounted };
}

test("review requires a rendered final viewport and Escape cancels at any position", async () => {
  const approving = mountReview();
  const enter = "\r";
  approving.component.handleInput?.(enter);
  expect(approving.mounted.decision).toBeUndefined();
  expect(
    approving.component.render(80).map(stripTerminalSequences).at(-1),
  ).toContain("Enter next page");
  approving.component.handleInput?.(enter);
  expect(approving.mounted.decision).toBeUndefined();
  expect(
    approving.component.render(42).every((line) => visibleWidth(line) <= 42),
  ).toBe(true);

  // Repeated input may reach the end before the terminal has drawn it.
  for (let i = 0; i < 100; i++) approving.component.handleInput?.(enter);
  expect(approving.mounted.decision).toBeUndefined();
  const final = approving.component.render(42).map(stripTerminalSequences);
  expect(final).toContain("Decision · Merge manually.");
  expect(final.at(-1)).toBe("Enter start implementation · Esc cancel");
  approving.component.handleInput?.(enter);
  expect(await approving.approval).toBe(true);

  const cancelling = mountReview();
  cancelling.component.render(24);
  cancelling.component.handleInput?.("\x1b");
  expect(await cancelling.approval).toBe(false);
});
