import assert from "node:assert/strict";
import { test } from "node:test";
import { ActivityState, ConditionState } from "@lanej/pi-components";
import { readySpecification } from "./fixtures/socrates.ts";
import { coverageToken } from "../socrates/assessment.ts";
import {
  socratesPresentation,
  type SocratesActivity,
} from "../socrates/presentation.ts";
import {
  SpecStatus,
  specRecord,
  type LeadSpecification,
} from "../socrates/spec.ts";

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
      reason:
        "R1 needs a check that recovered transcript bytes match the original.",
    },
    {
      propertyId: "stakeholders",
      status: "not-applicable",
      reason:
        "The operator's private transcript has no additional stakeholders.",
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
      objective:
        "Preserve transcripts so interrupted sessions can be recovered.",
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
  return assessments === null
    ? spec
    : { ...spec, coverageRevision: coverageToken(spec) };
}

function present(
  spec: LeadSpecification,
  live = idle,
  revision: string | null = "brief-v1",
) {
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
  assert.equal(
    running.conditions.find(({ id }) => id === "verification")?.state,
    ConditionState.Open,
  );
  assert.equal(running.activity.state, ActivityState.Working);
  assert.equal(running.activity.focusId, "verification");
  assert.equal(resting.activity.state, ActivityState.Idle);
  assert.equal(resting.activity.focusId, undefined);
  assert.match(resting.summary, /1 satisfied/u);
  assert.match(resting.summary, /1 open/u);
  assert.match(resting.summary, /10 not assessed/u);
  assert.match(resting.summary, /1 not applicable/u);
});

await test("a saved focus cannot animate an idle, paused or frozen specification", () => {
  const spec = specification();
  const paused = present(spec, { working: false, paused: true });
  assert.equal(paused.activity.state, ActivityState.Paused);
  assert.equal(paused.activity.focusId, undefined);
  const frozen = present({ ...spec, status: SpecStatus.Frozen }, working);
  assert.equal(frozen.activity.state, ActivityState.Idle);
  assert.equal(frozen.activity.focusId, undefined);
  assert.equal(frozen.activity.label, "Specification frozen");
  assert.deepEqual(frozen.conditions, present(spec).conditions);
});

await test("waiting for an answer preserves evidence but recording it requires reassessment", () => {
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
  const previous = updating.conditions.find(({ id }) => id === "problem-first");
  assert.ok(previous !== undefined);
  assert.equal(previous.state, ConditionState.Satisfied);
  assert.equal(previous.stale, true);
  assert.match(previous.details ?? "", /D1 records/u);
  assert.match(updating.summary, /^0 satisfied/u);
  assert.match(updating.summary, /3 recheck/u);
  assert.equal(present(answered).activity.state, ActivityState.Waiting);
});

await test("reopening or a changed brief makes old evidence inspectable without claiming current satisfaction", () => {
  const spec = specification();
  const reopened = specRecord.parse({ ...spec, version: 2 });
  for (const projected of [
    present(reopened, working),
    present(spec, working, "brief-v2"),
  ]) {
    assert.equal(
      projected.conditions.filter(({ stale }) => stale === true).length,
      3,
    );
    assert.match(projected.summary, /^0 satisfied/u);
    assert.match(projected.summary, /3 recheck/u);
    assert.equal(projected.activity.focusId, undefined);
    const unknown = projected.conditions.find(({ id }) => id === "harmony");
    assert.ok(unknown !== undefined);
    assert.equal(unknown.state, ConditionState.Unknown);
    assert.equal(unknown.stale, false);
  }
  const briefChanged = present(spec, working, "brief-v2");
  assert.equal(briefChanged.activity.state, ActivityState.Paused);
  assert.equal(briefChanged.activity.label, "Brief changed");
  assert.equal(
    present(spec, working, null).activity.state,
    ActivityState.Paused,
  );
});

await test("legacy and undrafted specifications remain unassessed even when work is active", () => {
  const legacy = specification(null);
  for (const spec of [legacy, { ...legacy, draft: null }]) {
    const projected = present(spec, working);
    assert.equal(projected.conditions.length, 13);
    assert.equal(
      projected.conditions.every(
        ({ state, stale }) =>
          state === ConditionState.Unknown && stale === false,
      ),
      true,
    );
    assert.equal(projected.activity.state, ActivityState.Working);
    assert.equal(projected.activity.focusId, undefined);
    assert.match(projected.summary, /13 not assessed/u);
  }
  assert.equal(
    present({ ...legacy, draft: null }).activity.label,
    "Specification not drafted",
  );
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
  assert.deepEqual(after.conditions, before.conditions);
});
