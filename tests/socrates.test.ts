import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyDraftUpdate,
  assessedSpecDraft,
  DecisionDisposition,
  SpecStatus,
  preserveDecisions,
  specDraft,
  specificationGaps,
  specRecord,
  specText,
  type LeadSpecification,
} from "../socrates/spec.ts";
import {
  coverageFresh,
  coverageProperties,
  coveragePropertyCatalog,
  savedCoverageSchema,
  coverageSchema,
  coverageToken,
} from "../socrates/assessment.ts";

import { readySpecification } from "./fixtures/socrates.ts";

const legacy = {
  objective: "Preserve the transcript",
  scope: ["Managed checkout"],
  requirements: [
    {
      id: "R1",
      outcome: "Keep the transcript",
      acceptance: "Open the archive",
    },
  ],
  decisions: [
    {
      decision: "Keep archives locally",
      basis: "decided",
      evidence: "Operator brief",
    },
  ],
  blockingQuestions: [],
};

await test("a frozen specification from the previous driver still loads unchanged", () => {
  const attempt = {
    status: SpecStatus.Frozen,
    version: 1,
    draft: legacy,
    acceptedRevision: "old",
    approvalAt: "2026-11-21T00:00:00.000Z",
  };
  assert.deepEqual(specRecord.parse(attempt), attempt);
});

await test("a settled decision can change through a linked successor", () => {
  const settled = specDraft.parse({
    ...legacy,
    decisions: [
      {
        ...legacy.decisions[0],
        id: "D1",
        disposition: DecisionDisposition.Resolved,
        uncertainty: "None",
      },
    ],
  });
  const first = settled.decisions[0];
  if (first === undefined) throw new Error("Missing fixture decision");
  assert.throws(() => {
    preserveDecisions(settled, {
      ...settled,
      decisions: [{ ...first, decision: "Delete archives" }],
    });
  }, /Preserve settled decision D1/u);
  const updated = specDraft.parse({
    ...settled,
    decisions: [
      { ...first, disposition: DecisionDisposition.Superseded },
      {
        ...first,
        id: "D2",
        supersedes: "D1",
        decision: "Keep archives in the workspace",
      },
    ],
  });
  preserveDecisions(settled, updated);
});

const coverage = {
  domains: ["engineering"],
  assessments: [
    {
      propertyId: "problem-first",
      status: "satisfied",
      reason:
        "The operator identified missing archived transcripts as the problem.",
    },
    {
      propertyId: "verification",
      status: "open",
      reason: "R1 needs an observable check of the recovered transcript.",
    },
    {
      propertyId: "stakeholders",
      status: "not-applicable",
      reason:
        "This private local transcript has no additional affected stakeholders.",
    },
  ],
  focus: "verification",
};

function assessedSpecification(): LeadSpecification {
  const spec = specRecord.parse({
    status: SpecStatus.Interrogating,
    version: 1,
    acceptedRevision: "brief-v1",
    draft: { ...legacy, decisions: [], coverage },
  });
  return { ...spec, coverageRevision: coverageToken(spec) };
}

await test("startup and sparse historical coverage expose each missing property as an explicit open gap", () => {
  const spec = assessedSpecification();
  const rows = coverageProperties(spec.draft);
  assert.equal(rows.length, 19);
  assert.equal(
    rows.find(({ id }) => id === "problem-first")?.status,
    "satisfied",
  );
  assert.equal(rows.find(({ id }) => id === "harmony")?.status, "open");
  assert.equal(rows.find(({ id }) => id === "modularity")?.status, "open");
  assert.equal(
    rows.some(({ id }) => id === "audience"),
    false,
  );

  assert.equal(rows.find(({ id }) => id === "harmony")?.recorded, false);
  assert.equal(rows.find(({ id }) => id === "verification")?.recorded, true);
  assert.match(
    rows.find(({ id }) => id === "modularity")?.reason ?? "",
    /boundaries/u,
  );
  const initial = coverageProperties(null);
  assert.equal(initial.length, 13);
  assert.ok(
    initial.every(
      ({ status, reason, recorded }) =>
        status === "open" && reason.length > 0 && !recorded,
    ),
  );
  const replacement = specDraft.parse({ ...legacy, decisions: [] });
  assert.equal(
    coverageProperties(replacement).every(({ status }) => status === "open"),
    true,
  );
  assert.equal(coverageProperties(replacement).length, 13);
  const mixed = specDraft.parse({
    ...replacement,
    coverage: {
      domains: ["writing", "research", "engineering"],
      assessments: [],
    },
  });
  assert.equal(coverageProperties(mixed).length, 27);
  assert.equal(new Set(coverageProperties(mixed).map(({ id }) => id)).size, 27);
});

await test("assessments require evidence and cannot hide outside the selected property sets", () => {
  for (const status of ["satisfied", "partial", "open", "not-applicable"]) {
    assert.equal(
      savedCoverageSchema.safeParse({
        domains: [],
        assessments: [{ propertyId: "risk", status }],
      }).success,
      false,
    );
    assert.equal(
      savedCoverageSchema.safeParse({
        domains: [],
        assessments: [{ propertyId: "risk", status, reason: "  " }],
      }).success,
      false,
    );
  }
  assert.equal(
    savedCoverageSchema.safeParse({
      domains: [],
      assessments: [{ propertyId: "risk", status: "unknown" }],
    }).success,
    true,
  );
  assert.equal(
    savedCoverageSchema.safeParse({
      domains: [],
      assessments: [
        {
          propertyId: "modularity",
          status: "open",
          reason: "A boundary remains unclear.",
        },
      ],
    }).success,
    false,
  );
  assert.equal(
    savedCoverageSchema.safeParse({
      domains: [],
      assessments: [],
      focus: "audience",
    }).success,
    false,
  );
  assert.equal(
    savedCoverageSchema.safeParse({
      ...coverage,
      assessments: [...coverage.assessments, ...coverage.assessments],
    }).success,
    false,
  );
  assert.equal(
    savedCoverageSchema.safeParse({
      ...coverage,
      domains: ["engineering", "engineering"],
    }).success,
    false,
  );
  assert.equal(
    savedCoverageSchema.safeParse({
      domains: [],
      assessments: [{ propertyId: "made-up", status: "unknown" }],
    }).success,
    false,
  );
});

await test("complete coverage requires every universal and selected-domain property, with a rationale", () => {
  const ready = readySpecification("brief-v1").draft;
  assert.ok(assessedSpecDraft.safeParse(ready).success);
  assert.ok(
    !assessedSpecDraft.safeParse({ ...ready, coverage: undefined }).success,
  );
  assert.ok(!coverageSchema.safeParse(coverage).success);
  const domains = ["engineering", "research", "writing"] as const;
  const all = coveragePropertyCatalog.map(({ id, gap }) => ({
    propertyId: id,
    status: "open",
    reason: gap,
  }));
  const snapshot = { domains, assessments: all };
  assert.ok(coverageSchema.safeParse(snapshot).success);
  for (const property of ["harmony", "repair", "causation", "action"]) {
    const remaining = all.filter(({ propertyId }) => propertyId !== property);
    const incomplete = coverageSchema.safeParse({
      ...snapshot,
      assessments: remaining,
    });
    assert.ok(
      !incomplete.success && incomplete.error.message.includes(property),
    );
    for (const assessment of [
      { propertyId: property, status: "unknown", reason: "Need evidence." },
      { propertyId: property, status: "open", reason: "  " },
    ])
      assert.ok(
        !coverageSchema.safeParse({
          ...snapshot,
          assessments: [...remaining, assessment],
        }).success,
      );
  }
});

await test("a substantive draft edit updates affected evidence and preserves other properties", () => {
  const spec = readySpecification("brief-v1");
  const [requirement] = spec.draft.requirements;
  const initial = spec.draft.coverage;
  assert.ok(requirement !== undefined && initial !== undefined);
  const timeRequirement = {
    ...requirement,
    id: "R2",
    acceptance: "The transcript exists.",
  };
  spec.draft.requirements.push(timeRequirement);
  const original = initial.assessments.find(
    ({ propertyId }) => propertyId === "verification",
  );
  assert.ok(original !== undefined);
  original.reason = "R1/R2 verify transcript recovery.";
  spec.coverageRevision = coverageToken(spec);
  const verification = {
    propertyId: "verification",
    status: "partial",
    reason:
      "R2 now includes timestamps. The test only compares transcript bytes.",
  };
  const draft = {
    ...spec.draft,
    requirements: [
      requirement,
      {
        ...timeRequirement,
        acceptance: "Both timestamps and transcript bytes match.",
      },
    ],
    coverage: { domains: initial.domains, assessments: [verification] },
  };
  assert.throws(
    () =>
      applyDraftUpdate(spec, spec.acceptedRevision, {
        ...draft,
        coverage: { domains: initial.domains, assessments: [] },
      }),
    /verification \(R2\)/u,
  );
  const updated = applyDraftUpdate(spec, spec.acceptedRevision, draft);
  assert.deepEqual(updated.requirements, draft.requirements);
  assert.deepEqual(
    updated.coverage.assessments,
    initial.assessments.map((item) =>
      item.propertyId === "verification" ? verification : item,
    ),
  );
  for (const baseline of [
    { ...spec, version: spec.version + 1 },
    { ...spec, coverageRevision: undefined },
    assessedSpecification(),
  ])
    assert.throws(
      () => applyDraftUpdate(baseline, spec.acceptedRevision, draft),
      /Assess every property/u,
    );
});

await test("deleted requirements and superseded decisions require targeted updates even inside citation ranges", () => {
  const spec = readySpecification("brief-v1");
  const initial = spec.draft.coverage;
  const [requirement] = spec.draft.requirements;
  const [decision] = spec.draft.decisions;
  assert.ok(
    initial !== undefined &&
      requirement !== undefined &&
      decision !== undefined,
  );
  for (const id of ["R2", "R3", "R4", "R5"])
    spec.draft.requirements.push({ ...requirement, id });
  const predecessor = { ...decision, id: "D1" };
  spec.draft.decisions.push(predecessor);
  function withReason(propertyId: string, reason: string) {
    const item = initial?.assessments.find(
      (entry) => entry.propertyId === propertyId,
    );
    assert.ok(item !== undefined);
    item.reason = reason;
    return item;
  }
  const clarity = withReason("clarity", "R2–R5 define the exchange.");
  const success = withReason("success", "R2-R5 specify observable outcomes.");
  const scope = withReason("scope", "D1/D20 define the milestone.");
  withReason("risk", "Issue #3 and the external MR3 report document the risk.");
  spec.coverageRevision = coverageToken(spec);
  const draft = {
    ...spec.draft,
    requirements: spec.draft.requirements.filter(({ id }) => id !== "R3"),
    decisions: [
      decision,
      { ...predecessor, disposition: "superseded" },
      { ...predecessor, id: "D21", supersedes: "D1" },
    ],
  };
  const apply = (assessments: unknown[]) =>
    applyDraftUpdate(spec, spec.acceptedRevision, {
      ...draft,
      coverage: { domains: initial.domains, assessments },
    });
  assert.throws(
    () => apply([]),
    /clarity \(R3\).*scope \(D1\).*success \(R3\)/u,
  );
  const revisions = [
    { ...clarity, reason: "R2/R4 define the remaining exchange." },
    {
      ...success,
      status: "open",
      reason: "R3 was dropped. Confirm the acceptance test.",
    },
  ];
  for (const reason of [scope.reason, "D1 settles the milestone."])
    assert.throws(
      () => apply([...revisions, { ...scope, reason }]),
      /scope.*D1/u,
    );
  assert.throws(
    () =>
      apply([...revisions, { ...scope, reason: "R3 defines the milestone." }]),
    /scope.*R3/u,
  );
  const updated = apply([
    ...revisions,
    { ...scope, reason: "D21 superseded D1 and defines the new milestone." },
  ]);
  assert.equal(updated.coverage.assessments.length, initial.assessments.length);
});

await test("coverage follows the draft and brief instead of a reusable lifecycle version", () => {
  const spec = assessedSpecification();
  assert.equal(coverageFresh(spec, "brief-v1"), true);
  assert.equal(coverageFresh(spec, "brief-v2"), false);
  assert.equal(coverageFresh({ ...spec, version: 2 }, "brief-v1"), false);
  assert.equal(
    coverageFresh({ ...spec, acceptedRevision: "brief-v2" }, "brief-v2"),
    false,
  );
  assert.equal(
    coverageFresh({ ...spec, coverageRevision: undefined }, "brief-v1"),
    false,
  );
  assert.equal(
    coverageFresh(
      {
        ...spec,
        status: SpecStatus.Frozen,
        approvalAt: "2026-11-24T00:00:00Z",
      },
      "brief-v1",
    ),
    true,
  );
  assert.equal(
    coverageFresh(
      {
        ...spec,
        draft: specDraft.parse({
          ...spec.draft,
          objective: "Delete the transcript",
        }),
      },
      "brief-v1",
    ),
    false,
  );
  assert.equal(
    coverageFresh(
      {
        ...spec,
        draft: specDraft.parse({
          ...spec.draft,
          requirements: [
            {
              id: "R1",
              outcome: "Keep the transcript",
              acceptance: "Find the original transcript bytes",
            },
          ],
        }),
      },
      "brief-v1",
    ),
    false,
  );
});

await test("a recorded answer blocks readiness until it is incorporated in a saved draft", () => {
  const spec = assessedSpecification();
  const exchange = {
    prompt: {
      decisionId: "D1",
      question: "Which transcript must the archive preserve?",
      options: [],
    },
  };
  const waiting = specRecord.parse({ ...spec, exchange });
  assert.equal(coverageFresh(waiting, "brief-v1"), true);
  const answered = specRecord.parse({
    ...waiting,
    exchange: {
      ...exchange,
      answer: { text: "The original session transcript", kind: "custom" },
    },
  });
  assert.equal(coverageFresh(answered, "brief-v1"), false);
  assert.throws(
    () =>
      applyDraftUpdate(answered, "brief-v1", {
        coverage: { domains: ["engineering"], assessments: [] },
      }),
    /recorded answer/u,
  );
  assert.match(
    specText(answered),
    /Operator answer · The original session transcript/u,
  );
  assert.match(specText(answered), /R1 needs an observable check/u);
  assert.match(specText(answered), /Harmony · open · Check/u);

  const updated = specRecord.parse({
    ...answered,
    exchange: undefined,
    draft: {
      ...answered.draft,
      objective: "Preserve the original session transcript",
    },
  });
  assert.equal(coverageFresh(updated, "brief-v1"), false);
  updated.coverageRevision = coverageToken(updated);
  assert.equal(coverageFresh(updated, "brief-v1"), true);
});

await test("Socrates readiness requires current evidence for every applicable property", () => {
  const spec = readySpecification("brief-v1");
  assert.deepEqual(specificationGaps(spec, "brief-v1"), []);
  assert.ok(specificationGaps(spec, "new brief").length > 0);
  assert.ok(specificationGaps({ ...spec, version: 2 }, "brief-v1").length > 0);
  const coverage = spec.draft.coverage;
  assert.ok(coverage !== undefined);
  for (const status of ["missing", "partial", "open", "unknown"]) {
    const assessments = coverage.assessments.filter(
      ({ propertyId }) => propertyId !== "modularity",
    );
    const draft = specDraft.parse({
      ...spec.draft,
      coverage: {
        ...coverage,
        assessments:
          status === "missing"
            ? assessments
            : [
                ...assessments,
                {
                  propertyId: "modularity",
                  status,
                  reason: "Need to settle the module boundary.",
                },
              ],
      },
    });
    const changed = { ...spec, draft };
    assert.match(
      specificationGaps(
        { ...changed, coverageRevision: coverageToken(changed) },
        "brief-v1",
      ).join("\n"),
      /modularity/iu,
      status,
    );
  }
});

await test("a pending question or open decision blocks an otherwise assessed specification", () => {
  const spec = readySpecification("brief-v1");
  const question = "Where should the transcript be stored?";
  const waiting = {
    ...spec,
    exchange: { prompt: { decisionId: "D1", question, options: [] } },
  };
  assert.ok(specificationGaps(waiting, "brief-v1").length > 0);
  for (const draft of [
    { ...spec.draft, blockingQuestions: [question] },
    {
      ...spec.draft,
      decisions: [
        {
          id: "D1",
          basis: "observed",
          decision: question,
          evidence: "Operator request",
          disposition: DecisionDisposition.Open,
          uncertainty: "Storage location",
        },
      ],
    },
  ]) {
    const changed = { ...spec, draft: specDraft.parse(draft) };
    assert.ok(
      specificationGaps(
        { ...changed, coverageRevision: coverageToken(changed) },
        "brief-v1",
      ).length > 0,
    );
  }
});

await test("a daily-driver freeze requires explicit evidenced PR and merge boundaries", () => {
  const spec = readySpecification("brief");
  const assess = (changes: object) => {
    const draft = specDraft.parse({ ...spec.draft, ...changes });
    const next = { ...spec, draft };
    return specificationGaps(
      { ...next, coverageRevision: coverageToken(next) },
      spec.acceptedRevision,
    );
  };
  assert.match(
    assess({ deliveryPolicy: undefined }).join(" "),
    /which beads produce pull requests/u,
  );
  const [source] = spec.draft.decisions;
  assert.ok(source !== undefined);
  for (const changes of [
    { decisions: [] },
    { decisions: [{ ...source, basis: "assumed" }] },
    { decisions: [{ ...source, disposition: "open" }] },
    { decisions: [{ ...source, disposition: "accepted-uncertainty" }] },
  ])
    assert.match(assess(changes).join(" "), /resolved decision D20/u);
  assert.deepEqual(
    assess({
      decisions: [
        {
          ...source,
          basis: "observed",
          evidence: "CONTRIBUTING.md requires a PR for each change",
        },
      ],
      deliveryPolicy: {
        decisionId: source.id,
        pullRequests: "per-bead",
        merge: "project-policy",
      },
    }),
    [],
  );
  for (const invalid of [
    { pullRequests: "none", merge: "manual" },
    { pullRequests: "per-bead" },
    { pullRequests: "selected", publish: ["docs"] },
    { pullRequests: "selected", merge: "manual", publish: [] },
    { pullRequests: "selected", merge: "manual", publish: ["patch", "patch"] },
    { pullRequests: "selected", merge: "manual", publish: ["root"] },
  ])
    assert.equal(
      specDraft.safeParse({
        ...spec.draft,
        deliveryPolicy: { decisionId: source.id, ...invalid },
      }).success,
      false,
    );
});

await test("the reviewed publishing beads, merge rule and source decision are part of the specification", () => {
  const spec = readySpecification("brief");
  const withPolicy = (policy: object) => ({
    ...spec,
    draft: specDraft.parse({ ...spec.draft, deliveryPolicy: policy }),
  });
  const selected = {
    decisionId: "D20",
    pullRequests: "selected",
    merge: "manual",
    publish: ["ui", "api"],
  };
  const draft = withPolicy(selected);
  const token = coverageToken(draft);
  assert.equal(
    coverageToken({
      ...draft,
      draft: {
        ...draft.draft,
        deliveryPolicy: {
          pullRequests: "selected",
          merge: "manual",
          publish: ["ui", "api"],
          decisionId: "D20",
        },
      },
    }),
    token,
  );
  assert.match(specText(draft), /Open PRs for api, ui/u);
  assert.match(specText(draft), /Manual merge · D20/u);
  assert.notEqual(token, coverageToken(spec));
  assert.equal(
    token,
    coverageToken(withPolicy({ ...selected, publish: ["api", "ui"] })),
  );
  for (const change of [
    { merge: "project-policy" },
    { publish: ["api"] },
    { decisionId: "D21" },
  ])
    assert.notEqual(
      token,
      coverageToken(withPolicy({ ...selected, ...change })),
    );
});

await test("revising a settled publication policy requires a resolved successor decision", () => {
  const spec = readySpecification("brief");
  const prior = spec.draft;
  const [current] = prior.decisions;
  assert.ok(current !== undefined);
  const policy = {
    decisionId: "D21",
    pullRequests: "per-bead",
    merge: "manual",
  };
  const replacement = {
    ...current,
    id: "D21",
    decision: "Open one PR per bead for manual merge",
    supersedes: current.id,
  };
  const superseded = {
    ...current,
    disposition: DecisionDisposition.Superseded,
  };
  for (const change of [
    { deliveryPolicy: undefined },
    { deliveryPolicy: { ...policy, decisionId: current.id } },
    {
      deliveryPolicy: policy,
      decisions: [current, { ...replacement, supersedes: undefined }],
    },
    {
      deliveryPolicy: policy,
      decisions: [
        superseded,
        { ...replacement, disposition: DecisionDisposition.Open },
      ],
    },
    {
      deliveryPolicy: policy,
      decisions: [superseded, { ...replacement, basis: "assumed" }],
    },
  ])
    assert.throws(() => {
      preserveDecisions(prior, specDraft.parse({ ...prior, ...change }));
    }, /Supersede delivery decision/u);
  const authorized = specDraft.parse({
    ...prior,
    deliveryPolicy: policy,
    decisions: [superseded, replacement],
  });
  preserveDecisions(prior, authorized);
  const questioning = specDraft.parse({
    ...prior,
    deliveryPolicy: undefined,
    decisions: [{ ...current, disposition: DecisionDisposition.Open }],
  });
  preserveDecisions(questioning, prior);
});
