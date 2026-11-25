import assert from "node:assert/strict";
import { test } from "node:test";
import { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import nord from "../resources/theme.json" with { type: "json" };
import { createHandoffReview } from "../discovery/handoff-review.ts";
import { draftSchema } from "../lead-plan.ts";
import {
  coveragePropertyCatalog,
  coverageToken,
} from "../socrates/assessment.ts";
import { specRecord, SpecStatus } from "../socrates/spec.ts";

const theme = new Theme(nord.colors, nord.colors, "truecolor");
const draft = draftSchema.parse({
  summary: "Publish the handbook and its search index.",
  pullRequestMerge: "manual",
  tasks: [
    { key: "terms", title: "Define glossary" },
    {
      key: "guide",
      title: "Write handbook",
      blockedBy: ["terms"],
      delivery: "pull-request",
    },
    {
      key: "index",
      title: "Index headings",
      blockedBy: ["terms"],
      delivery: "pull-request",
    },
    { key: "notes", title: "Collect notes" },
  ].map((task) => ({
    ...task,
    description: `Prepare the ${task.key} section.`,
    acceptance: `Verify ${task.key} independently.`,
    check: ["bun", "test", `tests/${task.key}.ts`],
    owns: [`docs/${task.key}.md`],
    requirements: ["R1"],
  })),
});
const specification = specRecord.parse({
  status: SpecStatus.Frozen,
  version: 2,
  acceptedRevision: "brief",
  draft: {
    objective: "Publish a searchable handbook.",
    scope: ["Documentation"],
    requirements: [
      {
        id: "R1",
        outcome: "Find each section",
        acceptance: "Search returns matching headings",
      },
    ],
    decisions: [
      {
        id: "D1",
        decision: "Publish the guide and index separately",
        disposition: "resolved",
        basis: "decided",
        evidence: "Owner approved both PRs",
        uncertainty: "None",
      },
    ],
    deliveryPolicy: {
      decisionId: "D1",
      pullRequests: "selected",
      publish: ["guide", "index"],
      merge: "manual",
    },
    blockingQuestions: [],
    coverage: {
      domains: [],
      assessments: coveragePropertyCatalog
        .filter(({ domain }) => domain === "universal")
        .map(({ id }) => ({
          propertyId: id,
          status: "satisfied",
          reason: `The operator reviewed ${id} against R1.`,
        })),
    },
  },
});
specification.coverageRevision = coverageToken(specification);

function review(height: number) {
  const decisions: boolean[] = [];
  const component = createHandoffReview(
    {
      title: "Handbook",
      draft,
      specification,
      project: "/work/handbook",
      sourceId: "handbook-source",
      profile: "personal",
      execution: "background",
    },
    theme,
    () => height,
    (approved) => {
      decisions.push(approved);
    },
    () => undefined,
  );
  return { component, decisions };
}

await test("the handoff opens on the dependency graph and PR contents in the Studio palette", () => {
  const { component } = review(35);
  const rows = component.render(122);
  assert.ok(rows.length <= 35 && rows.every((row) => visibleWidth(row) <= 122));
  const plain = rows.map(stripTerminalSequences).join("\n");
  assert.match(plain, /Approve Handbook/u);
  for (const task of draft.tasks)
    assert.ok(plain.includes(task.title), task.key);
  assert.match(plain, /├─╮/u);
  assert.match(plain, /◆ Frozen.*13 satisfied/u);
  const heading = rows
    .map(stripTerminalSequences)
    .find((row) => row.includes("Implementation") && row.includes("Delivery"));
  assert.ok(heading !== undefined);
  const deliveryStart = heading.indexOf("Delivery");
  const contents = rows
    .map((row) => stripTerminalSequences(row).slice(deliveryStart, -1).trim())
    .filter(Boolean)
    .join("\n");
  assert.match(
    contents,
    /guide\nAlso includes terms\nindex\nAlso includes terms\nStays local\nnotes\n/u,
  );
  assert.ok(
    rows.some((row) => row.includes(theme.getFgAnsi("syntaxNumber"))),
    "branch lanes retain separate Nord colors",
  );
  assert.match(plain, /manual/iu);
  assert.doesNotMatch(
    plain,
    /Verify notes independently|Enter create tasks and implement/u,
  );
});

await test("paging a narrow handoff exposes the full reviewed scope before an explicit confirmation", () => {
  const { component, decisions } = review(17);
  const pages: string[] = [];
  const width = 51;
  for (let page = 0; page < 100; page++) {
    const rows = component.render(width);
    assert.ok(
      rows.length <= 17 && rows.every((row) => visibleWidth(row) <= width),
    );
    const frame = rows.map(stripTerminalSequences).join("\n");
    pages.push(frame);
    if (frame.includes("Enter create tasks and implement")) break;
    component.handleInput("\r");
    component.handleInput("\r");
    assert.deepEqual(
      decisions,
      [],
      "queued input cannot approve an unseen page",
    );
  }
  assert.match(pages.at(-1) ?? "", /Enter create tasks and implement/u);
  const transcript = pages.join("\n");
  for (const required of [
    draft.summary,
    "handbook-source",
    "/work/handbook",
    "personal",
    "background",
    "Search returns matching headings",
    "Owner approved both PRs",
    "Verify notes independently.",
    "tests/index.ts",
    "Included in PR · guide, index",
    "Stays local",
    "docs/guide.md",
  ]) {
    assert.ok(transcript.includes(required), required);
  }
  component.handleInput("\r");
  component.handleInput("\r");
  assert.deepEqual(decisions, [true], "approval is emitted once");
});

await test("Escape can cancel both the first page and the final confirmation", () => {
  for (const atEnd of [false, true]) {
    const { component, decisions } = review(30);
    for (let page = 0; page < 100; page++) {
      const frame = component
        .render(100)
        .map(stripTerminalSequences)
        .join("\n");
      if (!atEnd || frame.includes("Enter create tasks and implement")) break;
      component.handleInput("\r");
    }
    component.handleInput("\x1b");
    assert.deepEqual(decisions, [false]);
  }
});

await test("a wrapped action hint never strands approval in a narrow split", () => {
  const { component, decisions } = review(15);
  let last = "";
  for (let page = 0; page < 100 && decisions.length === 0; page++) {
    const rows = component.render(35);
    last = rows.map(stripTerminalSequences).join("\n");
    assert.ok(
      rows.length <= 15 && rows.every((row) => visibleWidth(row) <= 35),
    );
    component.handleInput("\r");
  }
  assert.deepEqual(decisions, [true], last);
});
