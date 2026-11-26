import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "bun:test";
import { draftSchema } from "../lead-plan.ts";
import { renderPlanReview, type PlanReview } from "../plan-review.ts";
import { createPlanApproval } from "../ui.ts";

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
        description: "Keep the first scope local.\nPreserve the next paragraph.",
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
  ],
  publications: [{ label: "PR from publish", value: "Includes source, publish" }],
  specification: "Objective · Scope is frozen.\n\nDecision · Merge manually.",
};

function stacked(plan: PlanReview, width: number): string[] {
  const { overview, details } = renderPlanReview(plan, theme, width);
  return [...overview, "", ...details];
}

test("approval displays the colored dependency graph and complete structured context", () => {
  const rendered = stacked(review, 80);
  const plain = rendered.map(stripTerminalSequences);
  const graphStart = plain.indexOf("Task dependencies");
  expect(plain.slice(graphStart + 1, graphStart + 6)).toEqual([
    "●    Prepare the source",
    "├─╮",
    "● │  Review the implementation  on hold",
    "  │",
    "  ●  Publish the result",
  ]);
  expect(graphStart).toBeLessThan(plain.indexOf("PR publication"));
  const exactContext = stacked(
    {
      ...review,
      context: [{ label: "Project", value: "/example/\x1b[31mproject" }],
    },
    80,
  )
    .map(stripTerminalSequences)
    .join("\n");
  expect(exactContext).toContain("/example/\\u001b[31mproject");
  const literalContext = stacked(
    {
      ...review,
      context: [{ label: "Project", value: "/example/\\u001b[31mproject" }],
    },
    80,
  )
    .map(stripTerminalSequences)
    .join("\n");
  expect(literalContext).toContain("/example/\\\\u001b[31mproject");
  expect(literalContext).not.toBe(exactContext);

  const raw = rendered.join("\n");
  expect(raw).toContain("\x1b[36m├");
  expect(raw).toContain("\x1b[33m╮");
  expect(raw).toContain("\x1b[1msource · Prepare the source");
  expect(raw).not.toContain("\x1b[35m");
  const all = plain.join("\n");
  for (const expected of [
    "Execution  interactive in Zellij work, tab 2",
    "Project    /example/local-project",
    "Beads      example-beads",
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

  const narrow = stacked(review, 24);
  expect(narrow.every((line) => visibleWidth(line) <= 24)).toBe(true);
  const narrowPlain = narrow.map(stripTerminalSequences).join("\n");
  expect(narrowPlain).toContain("├─╮");
  expect(narrowPlain).toContain("Decision · Merge\nmanually.");
  expect(narrowPlain).toContain("src/source.ts");
});

function mountReview(rows = 11, plan = review) {
  const result: { decision?: boolean } = {};
  const terminal = { rows };
  const component = createPlanApproval(
    { terminal, requestRender() {} },
    theme,
    (decision) => {
      result.decision = decision;
    },
    "Approve the change",
    plan,
    "start implementation",
  );
  return { component, result, terminal };
}

test("review requires a rendered final viewport and Escape cancels at any position", () => {
  const approving = mountReview();
  const enter = "\r";
  approving.component.handleInput?.(enter);
  expect(approving.result.decision).toBeUndefined();
  expect(approving.component.render(80).map(stripTerminalSequences).at(-2)).toContain("Enter next page");
  approving.component.handleInput?.(enter);
  expect(approving.result.decision).toBeUndefined();
  expect(approving.component.render(42).every((line) => visibleWidth(line) <= 42)).toBe(true);

  // Buffered input can advance once, then waits for the next page to render.
  for (let i = 0; i < 100; i++) approving.component.handleInput?.(enter);
  expect(approving.result.decision).toBeUndefined();
  expect(approving.component.render(42).map(stripTerminalSequences).at(-2)).toContain("↓ More");
  for (let i = 0; i < 100; i++) {
    approving.component.handleInput?.(enter);
    const footer = approving.component.render(42).map(stripTerminalSequences).at(-2);
    if (footer?.includes("Enter confirm") === true) break;
  }
  const final = approving.component
    .render(42)
    .slice(1, -1)
    .map((line) => stripTerminalSequences(line).slice(1, -1).trim());
  expect(final).toContain("Decision · Merge manually.");
  expect(final.at(-1)).toBe("Enter confirm · Esc cancel");
  approving.component.handleInput?.(enter);
  expect(approving.result.decision).toBe(true);

  const cancelling = mountReview();
  cancelling.component.render(24);
  cancelling.component.handleInput?.("\x1b");
  expect(cancelling.result.decision).toBe(false);
});

test("wide review uses the whole terminal and keeps the overview visible while details scroll", () => {
  const { component, result, terminal } = mountReview(28);
  const wide = component.render(128);
  const plain = wide.map(stripTerminalSequences);
  expect(plain).toHaveLength(28);
  expect(wide.every((line) => visibleWidth(line) <= 128)).toBe(true);
  expect(plain[2]).toContain("Execution");
  expect(plain[2]).toContain("│  Task details");
  expect(plain.some((line) => line.includes("Task dependencies"))).toBe(true);
  expect(plain.some((line) => line.includes("Local integration is verified."))).toBe(true);
  expect(plain[0]).toMatch(/^╭─ Approve the change .*╮$/u);
  expect(plain.at(-2)).toContain("Enter next page");
  expect(plain.at(-1)).toMatch(/^╰─+╯$/u);

  component.handleInput?.("\r");
  const end = component.render(128).map(stripTerminalSequences).join("\n");
  expect(end).toContain("Task dependencies");
  expect(end).toContain("Decision · Merge manually.");
  expect(end).toContain("Enter start implementation");
  expect(result.decision).toBeUndefined();

  terminal.rows = 20;
  const narrow = component.render(60).map(stripTerminalSequences);
  expect(narrow).toHaveLength(20);
  expect(narrow.some((line) => line.includes("Execution"))).toBe(true);
  expect(narrow.some((line) => line.includes("Task details"))).toBe(false);
  expect(narrow.at(-2)).toContain("Enter next page");
  component.handleInput?.("\x1b");
  expect(result.decision).toBe(false);
});

test("wide review waits for the longer overview when all details already fit", () => {
  const { component, result } = mountReview(14, {
    ...review,
    draft: {
      summary: Array.from({ length: 40 }, (_, i) => `Summary line ${String(i + 1)}`).join("\n"),
      tasks: [],
    },
  });
  const plain = () => component.render(120).map(stripTerminalSequences).join("\n");
  expect(plain()).toContain("Decision · Merge manually.");
  component.handleInput?.("\r");
  const middle = plain();
  expect(middle).toContain("Decision · Merge manually.");
  expect(middle).toContain("Enter next page");
  expect(result.decision).toBeUndefined();

  for (let i = 0; i < 20 && !plain().includes("Enter start implementation"); i++) component.handleInput?.("\r");
  const end = plain();
  expect(end).toContain("Summary line 40");
  expect(end).toContain("Decision · Merge manually.");
  expect(end).toContain("Enter start implementation");
  expect(result.decision).toBeUndefined();
  component.handleInput?.("\r");
  expect(result.decision).toBe(true);
});
