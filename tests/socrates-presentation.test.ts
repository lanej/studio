import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ActivityState, ConditionState } from "@lanej/pi-components";
import { visibleWidth } from "@earendil-works/pi-tui";
import { LeadMode, draftSchema } from "../planning/plan.ts";
import { renderSocratesSections } from "../socrates/sidebar.ts";
import { readySpecification } from "./fixtures/socrates.ts";
import { coverageToken } from "../socrates/assessment.ts";
import { socratesPresentation, type SocratesActivity } from "../socrates/presentation.ts";
import { SpecStatus, specRecord, type LeadSpecification } from "../socrates/spec.ts";

const idle: SocratesActivity = { working: false, paused: false };
const working: SocratesActivity = { working: true, paused: false };
const coverage = {
  domains: [],
  assessments: [
    {
      propertyId: "problem-first",
      status: "satisfied",
      reason: "D1 records that missing transcripts prevent recovery.",
    },
    {
      propertyId: "verification",
      status: "open",
      reason: "R1 needs a check that recovered transcript bytes match the original.",
    },
    {
      propertyId: "stakeholders",
      status: "not-applicable",
      reason: "The operator's private transcript has no additional stakeholders.",
    },
  ],
  focus: "verification",
};

function specification(assessments: unknown = coverage): LeadSpecification {
  const spec = specRecord.parse({
    status: SpecStatus.Interrogating,
    version: 1,
    acceptedRevision: "brief-v1",
    draft: {
      objective: "Preserve transcripts so interrupted sessions can be recovered.",
      scope: ["The operator's local sessions"],
      requirements: [
        {
          id: "R1",
          outcome: "Recover the original transcript",
          acceptance: "Recovered transcript bytes match the archived source",
        },
      ],
      decisions: [],
      blockingQuestions: [],
      ...(assessments === null ? {} : { coverage: assessments }),
    },
  });
  return assessments === null ? spec : { ...spec, coverageRevision: coverageToken(spec) };
}

function present(spec: LeadSpecification, live = idle, revision: string | null = "brief-v1") {
  return socratesPresentation(
    {
      id: "transcript-recovery",
      label: "Transcript recovery",
      revision,
      specification: spec,
    },
    live,
  );
}

await test("working through a property does not change its saved assessment", () => {
  const spec = specification();
  const resting = present(spec);
  const running = present(spec, working);
  assert.deepEqual(running.conditions, resting.conditions);
  assert.equal(running.summary, resting.summary);
  assert.equal(running.conditions.find(({ id }) => id === "verification")?.state, ConditionState.Open);
  assert.equal(running.activity.state, ActivityState.Working);
  assert.equal(running.activity.focusId, "verification");
  assert.equal(resting.activity.state, ActivityState.Idle);
  assert.equal(resting.activity.focusId, undefined);
  assert.match(resting.summary, /1 satisfied/u);
  assert.match(resting.summary, /11 open/u);
  assert.match(resting.summary, /1 not applicable/u);
});

await test("property marks, folded groups, and counts share state colors across both views", () => {
  const spec = specification({
    ...coverage,
    assessments: [
      ...coverage.assessments,
      {
        propertyId: "risk",
        status: "partial",
        reason: "Recovery handles missing files but still needs a corruption check.",
      },
    ],
  });
  const fresh = present(spec);
  for (const [column] of [fresh.columns, fresh.dockColumns]) {
    assert.ok(column !== undefined);
    const items = column.groups.flatMap((group) => group.items);
    for (const [id, label, tone] of [
      ["verification", "open", "error"],
      ["risk", "partial", "warning"],
      ["problem-first", "satisfied", "success"],
      ["stakeholders", "N/A", "muted"],
    ]) {
      assert.equal(items.find((item) => item.id === id)?.status.tone, tone, id);
      assert.equal(column.counts?.find((count) => count.label === label)?.tone, tone, label);
    }
    assert.equal(column.groups.find((group) => group.id === "satisfied")?.tone, "success");
    assert.equal(column.groups.find((group) => group.id === "na")?.tone, "muted");
  }
  const stale = present({ ...spec, coverageRevision: undefined });
  for (const [column] of [stale.columns, stale.dockColumns]) {
    assert.ok(column !== undefined);
    const group = column.groups.find((item) => item.id === "attention");
    assert.equal(group?.items.find((item) => item.id === "problem-first")?.status.tone, "review");
    assert.equal(column.counts?.find((count) => count.label === "recheck")?.tone, "review");
  }
});

await test("a saved focus cannot animate an idle, paused or frozen specification", () => {
  const spec = specification();
  const paused = present(spec, { working: false, paused: true });
  assert.equal(paused.activity.state, ActivityState.Paused);
  assert.equal(paused.activity.focusId, undefined);
  const ready = readySpecification("brief-v1");
  const frozen = present({ ...ready, status: SpecStatus.Frozen }, working);
  assert.equal(frozen.activity.state, ActivityState.Idle);
  assert.equal(frozen.activity.focusId, undefined);
  assert.equal(frozen.activity.label, "Specification frozen");
  assert.deepEqual(frozen.conditions, present(ready).conditions);
});

await test("delivered input shows a single pending review while the recorded statuses stay visible", () => {
  const spec = specification();
  const before = present(spec);
  for (const [cause, active, pending] of [
    ["input", "Reviewing new input", "New input pending review"],
    ["input-and-plan", "Reviewing recent changes", "Changes pending review"],
  ] as const) {
    const changed = {
      ...spec,
      pendingReview: {
        id: randomUUID(),
        cause,
        inputs: [{ timestamp: 1, content: "Which properties remain open?" }],
      },
    };
    for (const [live, label, state] of [
      [working, active, ActivityState.Working],
      [idle, pending, ActivityState.Waiting],
    ] as const) {
      const after = present(changed, live);
      assert.deepEqual(after.conditions, before.conditions);
      assert.equal(after.summary, before.summary);
      assert.deepEqual(after.activity, { state, label });
      assert.equal(after.dockColumns[0]?.summary, label);
      assert.deepEqual(after.dockColumns[0].groups, before.dockColumns[0]?.groups);
    }
  }
});

await test("a changed frozen breakdown keeps its current assessments visible while review holds handoff", () => {
  const ready = readySpecification("brief-v1");
  const spec = {
    ...ready,
    status: SpecStatus.Frozen,
    pendingReview: { id: randomUUID(), cause: "plan" as const },
  };
  const before = socratesPresentation(
    {
      id: "frozen",
      label: "Transcript recovery",
      specification: spec,
      revision: "brief-v1",
      leadPlan: {
        mode: LeadMode.Planning,
        draft: draftSchema.parse({ summary: "Review recovery", tasks: [] }),
      },
    },
    idle,
  );
  assert.equal(before.implementation.label, "Review properties");
  assert.equal(before.prioritizeSpecification, true);
  assert.equal(before.activity.label, "Plan changes pending review");
  assert.equal(before.summary, present(ready).summary);
  assert.deepEqual(before.conditions, present(ready).conditions);
  const after = socratesPresentation(
    {
      id: "handed-off",
      label: "Linked discovery",
      specification: spec,
      revision: "brief-v1",
      approved: "approved-plan",
    },
    idle,
  );
  assert.equal(after.prioritizeSpecification, false);
  assert.equal(after.activity.label, "Specification frozen");
});

await test("waiting for and recording an answer preserve evidence until the answer is incorporated", () => {
  const spec = specification();
  const prompt = {
    decisionId: "D1",
    question: "Should recovery include every original transcript byte?",
    options: [],
  };
  const waiting = specRecord.parse({ ...spec, exchange: { prompt } });
  const awaitingAnswer = present(waiting, working);
  assert.equal(awaitingAnswer.activity.state, ActivityState.Waiting);
  assert.equal(awaitingAnswer.activity.focusId, undefined);
  assert.equal(awaitingAnswer.activity.detail, prompt.question);
  assert.deepEqual(awaitingAnswer.conditions, present(spec).conditions);

  const answered = specRecord.parse({
    ...waiting,
    exchange: {
      prompt,
      answer: { text: "Yes, include every byte", kind: "custom" },
    },
  });
  const updating = present(answered, working);
  assert.equal(updating.activity.state, ActivityState.Working);
  assert.equal(updating.activity.label, "Answer recorded");
  assert.equal(updating.activity.focusId, undefined);
  assert.match(updating.activity.detail ?? "", /incorporation/u);
  assert.deepEqual(updating.conditions, awaitingAnswer.conditions);
  assert.equal(updating.summary, awaitingAnswer.summary);
  assert.equal(present(answered).activity.state, ActivityState.Waiting);
});

await test("reopening or a changed brief makes old evidence inspectable without claiming current satisfaction", () => {
  const spec = specification();
  const reopened = specRecord.parse({ ...spec, version: 2 });
  for (const projected of [present(reopened, working), present(spec, working, "brief-v2")]) {
    assert.equal(projected.conditions.filter(({ stale }) => stale === true).length, 3);
    assert.match(projected.summary, /^0 satisfied/u);
    assert.match(projected.summary, /3 recheck/u);
    assert.equal(projected.activity.focusId, undefined);
    const missing = projected.conditions.find(({ id }) => id === "harmony");
    assert.ok(missing !== undefined);
    assert.equal(missing.state, ConditionState.Open);
    assert.equal(missing.stale, false);
    assert.match(projected.summary, /10 open/u);
  }
  const briefChanged = present(spec, working, "brief-v2");
  assert.equal(briefChanged.activity.state, ActivityState.Paused);
  assert.equal(briefChanged.activity.label, "Brief changed");
  assert.equal(present(spec, working, null).activity.state, ActivityState.Paused);
});

await test("legacy and undrafted specifications surface every missing property as an open gap", () => {
  const legacy = specification(null);
  for (const spec of [legacy, { ...legacy, draft: null }]) {
    const projected = present(spec, working);
    assert.equal(projected.conditions.length, 13);
    assert.equal(
      projected.conditions.every(
        ({ state, stale, details }) => state === ConditionState.Open && stale === false && details.length > 0,
      ),
      true,
    );
    assert.equal(projected.activity.state, ActivityState.Working);
    assert.equal(projected.activity.focusId, undefined);
    assert.match(projected.summary, /13 open/u);
    const group = projected.columns[0]?.groups.find(({ id }) => id === "attention");
    assert.equal(group?.items.length, 13);
    assert.equal(group.collapsed, undefined);
  }
  assert.equal(present({ ...legacy, draft: null }).activity.label, "Specification not drafted");
});

await test("a missing publication decision remains visible after the properties are satisfied", () => {
  const ready = readySpecification("brief-v1");
  const before = present(ready);
  const spec = {
    ...ready,
    draft: { ...ready.draft, deliveryPolicy: undefined },
  };
  const after = present({ ...spec, coverageRevision: coverageToken(spec) });
  assert.equal(after.activity.label, "PR decision open");
  assert.match(after.dockColumns[0]?.summary ?? "", /which beads open PRs/u);
  assert.equal(before.activity.label, "Awaiting review");
  assert.equal(before.prioritizeSpecification, false);
  assert.equal(after.prioritizeSpecification, true);
  assert.deepEqual(after.conditions, before.conditions);
});

await test("the side panel wraps unresolved reasons and fills the remaining rows with the draft graph", () => {
  const plain = (text: string) => text;
  const theme = {
    accent: plain,
    muted: plain,
    warning: plain,
    success: plain,
    error: plain,
    selected: plain,
    bold: plain,
    lane: (_lane: number, text: string) => text,
  };
  const reason =
    "The tests cover opening the current transcript. Reopening the archived copy still needs a comparison against the saved bytes.";
  const ready = readySpecification("brief-v1");
  const spec = specification({
    domains: ["engineering"],
    assessments: [
      ...(ready.draft.coverage?.assessments ?? []).filter(
        ({ propertyId }) => propertyId !== "verification" && propertyId !== "policy-mechanism-separation",
      ),
      { propertyId: "verification", status: "partial", reason },
      {
        propertyId: "policy-mechanism-separation",
        status: "open",
        reason: "Check who decides whether to retry the write.",
      },
    ],
    focus: "policy-mechanism-separation",
  });
  const plan = draftSchema.parse({
    summary: "Review the changes together.",
    tasks: ["schema", "load", "save", "audit"].map((key, index) => ({
      key,
      title: key,
      description: key,
      acceptance: key,
      blockedBy: index === 3 ? ["load", "save"] : index === 0 ? [] : ["schema"],
    })),
  });
  const observe = (specification: LeadSpecification) =>
    socratesPresentation(
      {
        id: "session",
        label: "Plan",
        revision: "brief-v1",
        specification,
        leadPlan: { mode: LeadMode.Planning, draft: plan },
      },
      working,
    );
  const panel = observe(spec);
  assert.equal(panel.prioritizeSpecification, true);
  const rows = renderSocratesSections(panel, theme, 33, 26);
  const text = rows.join(" ").replace(/\s+/gu, " ");
  assert.ok(text.includes(reason), text);
  assert.ok(text.includes("Separation of policy and mechanism"), text);
  assert.ok(text.indexOf("Separation of policy and mechanism") < text.indexOf("Verification"));
  assert.match(rows[0] ?? "", /^Specification +◇ Draft · v1$/u);
  const heading = rows.findIndex((line) => line.startsWith("Implementation"));
  assert.match(rows[heading] ?? "", /^Implementation +◇ Draft$/u);
  assert.match(text, /├─╮.*├─╯.*audit/u);
  const shortGraph = renderSocratesSections(panel, theme, 33, 21);
  assert.match(shortGraph.join(" "), /├─╮.*\+2 more · \/plan/u);
  // With two more rows the preview could reach the next task and its branch.
  assert.ok(21 - shortGraph.length < 2);
  const roomy = renderSocratesSections(panel, theme, 48, 34);
  const roomyText = roomy.join(" ").replace(/\s+/gu, " ");
  assert.ok(roomyText.includes(reason), roomyText);
  assert.match(roomyText, /Implementation +◇ Draft.*schema.*├─╮.*load.*save.*├─╯.*audit/u);
  assert.doesNotMatch(roomyText, /more · \/plan|Proposed beads|\d proposed/u);
  for (const height of [1, 3, 8, 20]) {
    const compact = renderSocratesSections(panel, theme, 57, height, true);
    assert.ok(compact.length <= height);
    assert.ok(compact.every((line) => visibleWidth(line) <= 57));
    if (height >= 3) assert.ok(compact.some((line) => /^Implementation +◇ Draft$/u.test(line)));
    if (height === 20) assert.match(compact.join(" "), /schema/u);
  }
  const readyPanel = observe(ready);
  assert.equal(readyPanel.prioritizeSpecification, false);
  assert.match(renderSocratesSections(readyPanel, theme, 33, 26).join(" "), /├─╯.*audit/u);
  const frozen = observe({ ...ready, status: SpecStatus.Frozen });
  assert.equal(frozen.prioritizeSpecification, false);
  assert.match(renderSocratesSections(frozen, theme, 33, 26).join(" "), /For approval.*├─╯.*audit/u);
  const changedFrozen = present({ ...ready, status: SpecStatus.Frozen }, idle, "new-brief");
  assert.equal(changedFrozen.prioritizeSpecification, true);
  assert.match(renderSocratesSections(changedFrozen, theme, 33, 20).join(" "), /Brief changed.*↺/u);
  const stale = observe({ ...ready, coverageRevision: undefined });
  assert.equal(stale.prioritizeSpecification, true);
  const short = renderSocratesSections(stale, theme, 33, 18).join(" ");
  assert.match(short, /↺.*Previous assessment/u);
  assert.match(short, /\+\d+ more properties/u);
});
