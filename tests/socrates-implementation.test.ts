import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { HandoffPhase } from "../discovery/store.ts";
import { runtimeProjectSchema, StudioProfile } from "../config.ts";
import { LeadMode, draftSchema, planDigest } from "../lead-plan.ts";
import { beadSchema, TaskBeads } from "../task-service.ts";
import { SpecStatus, specRecord } from "../socrates/spec.ts";
import { coverageFresh, coverageToken } from "../socrates/assessment.ts";
import {
  ImplementationPhase,
  ImplementationState,
  assessmentRevision,
  implementationPresentation,
  implementationRead,
  readImplementation,
  type ImplementationSource,
  type ImplementationObservation,
} from "../socrates/implementation.ts";
import {
  fitSidebarGraph,
  renderSidebarGraph,
  renderSocratesDock,
  renderStatusSidebar,
} from "../socrates/sidebar.ts";
import { renderBeadProgress } from "../socrates/bead-progress.ts";
import { implementationColumn } from "../socrates/columns.ts";
import { createImplementationWatch } from "../socrates/implementation-watch.ts";

const revision = randomUUID();
const projectId = randomUUID();
const authority = { url: "http://127.0.0.1:9", projectId };
const draft = draftSchema.parse({
  summary: "Recover transcripts without losing evidence.",
  tasks: [
    {
      key: "restore",
      title: "Restore transcripts",
      description: "Read the saved archive.",
      acceptance: "Recovered bytes match the original.",
      requirements: ["R1"],
    },
    {
      key: "verify",
      title: "Verify recovery",
      description: "Exercise interrupted sessions.",
      acceptance: "Interrupted recovery remains repeatable.",
      requirements: ["R1"],
      blockedBy: ["restore"],
    },
  ],
});
const specification = specRecord.parse({
  status: SpecStatus.Frozen,
  version: 1,
  acceptedRevision: revision,
  draft: null,
});
const proposed: ImplementationSource = {
  revision,
  specification,
  leadPlan: { mode: LeadMode.Planning, draft },
};
const digest = planDigest(draft);
const approved: ImplementationSource = {
  ...proposed,
  approved: digest,
  graph: { root: "bd-root", restore: "bd-restore", verify: "bd-verify" },
  handoff: {
    operation: randomUUID(),
    revision,
    digest,
    phase: HandoffPhase.Complete,
    target: {
      ...runtimeProjectSchema.parse({
        root: "/project",
        source: authority,
        profile: StudioProfile.Personal,
        base: "main",
        beadsWorkspace: "/project",
        beadsDatabase: "fixture",
      }),
      id: projectId,
    },
  },
};

function observed(key: string, status: string) {
  return beadSchema.parse({
    id: `bd-${key}`,
    title: key,
    status,
    revision: "native-version",
    metadata: {
      "studio.graph": revision,
      "studio.approval": digest,
      "studio.task": { key },
    },
  });
}

await test("a frozen specification and proposed breakdown never imply execution", () => {
  const display = implementationPresentation(proposed);
  assert.equal(display.phase, ImplementationPhase.Proposed);
  assert.equal(display.label, "Review properties");
  assert.equal(display.counts[ImplementationState.Proposed], 2);
  assert.equal(display.counts[ImplementationState.InProgress], 0);
  assert.equal(implementationRead(proposed), undefined);
  assert.deepEqual(
    display.rows.map(({ wave }) => wave),
    [1, 2],
  );
  assert.match(display.rows[1]?.details ?? "", /Requirements · R1/u);
  assert.match(display.rows[1]?.details ?? "", /Depends on · restore/u);
});

await test("sidebar draws dependency forks and joins, clipping at task boundaries", () => {
  const plain = (value: string) => value;
  const theme = {
    accent: plain,
    bold: plain,
    muted: plain,
    success: plain,
    error: plain,
    warning: plain,
    selected: plain,
    lane: (_lane: number, value: string) => value,
  };
  const tasks = [
    { key: "merge", title: "Verify together", blockedBy: ["mac", "linux"] },
    { key: "setup", title: "Prepare", blockedBy: [] },
    { key: "mac", title: "Run on macOS", blockedBy: ["setup"] },
    { key: "linux", title: "Run on Linux", blockedBy: ["setup"] },
  ].map((task) => ({
    ...task,
    description: task.title,
    acceptance: task.title,
  }));
  const implementation = implementationPresentation({
    revision,
    leadPlan: {
      mode: LeadMode.Planning,
      draft: draftSchema.parse({ summary: "Portability check", tasks }),
    },
  });
  const graph = renderSidebarGraph(implementation, theme, 35);
  assert.deepEqual(
    graph.lines.map((line) => line.trimEnd()),
    [
      "◇    Prepare",
      "├─╮",
      "◇ │  Run on macOS",
      "│ │",
      "│ ◇  Run on Linux",
      "├─╯",
      "◇    Verify together",
    ],
  );
  assert.deepEqual(graph.nodeLines, [0, 2, 4, 6]);
  // If the next task cannot fit with its connector and overflow count,
  // stop at the previous task. At seven rows the whole graph fits exactly.
  for (const [height, expected] of [
    [0, []],
    [1, graph.lines.slice(0, 1)],
    [2, [...graph.lines.slice(0, 1), "+3 more · /plan"]],
    [3, [...graph.lines.slice(0, 1), "+3 more · /plan"]],
    [4, [...graph.lines.slice(0, 3), "+2 more · /plan"]],
    [5, [...graph.lines.slice(0, 3), "+2 more · /plan"]],
    [6, [...graph.lines.slice(0, 5), "+1 more · /plan"]],
    [7, graph.lines],
  ] as const) {
    assert.deepEqual(fitSidebarGraph(graph, height, theme), expected);
  }
  const snapshot = {
    implementation,
    dockColumns: [implementationColumn(implementation)],
    prioritizeSpecification: false,
  };
  const sidebar = renderStatusSidebar(snapshot, theme, 35, 24).join("\n");
  assert.match(sidebar, /├─╮/u);
  assert.match(sidebar, /├─╯/u);
  assert.doesNotMatch(sidebar, /Wave|Local integration/u);
  for (const row of implementation.rows) row.state = ImplementationState.Closed;
  const live = renderSidebarGraph(implementation, theme, 35);
  assert.equal(live.lines[2], "● │  Run on macOS");
  assert.equal(
    renderSidebarGraph(implementation, theme, 17).lines[2],
    "● │  Run on macOS",
  );
  assert.equal(live.lines[1], graph.lines[1]);
  assert.equal(live.lines[5], graph.lines[5]);
});

await test("linked native bead states remain independent of approval and dependencies", () => {
  const request = implementationRead(approved);
  assert.ok(request !== undefined);
  assert.deepEqual(request.authority, authority);
  assert.deepEqual(request.ids, ["bd-restore", "bd-verify"]);
  const loading = implementationPresentation(approved);
  assert.equal(loading.phase, ImplementationPhase.Loading);
  assert.equal(loading.counts[ImplementationState.Unknown], 2);
  const display = implementationPresentation(approved, {
    key: request.key,
    state: "current",
    tasks: [observed("restore", "closed"), observed("verify", "open")],
  });
  assert.equal(display.phase, ImplementationPhase.Tracking);
  assert.equal(display.specificationVersion, 1);
  assert.equal(display.rows[0]?.status, "Closed");
  assert.equal(display.rows[1]?.status, "Open");
  assert.equal(display.counts[ImplementationState.Closed], 1);
  assert.equal(display.counts[ImplementationState.Open], 1);
  assert.equal(display.counts[ImplementationState.InProgress], 0);
});

await test("linked beads wrap in plan order within the available columns and rows", () => {
  const identity = (s: string) => s;
  const theme = {
    bold: identity,
    muted: identity,
    success: identity,
    accent: identity,
    selected: identity,
    error: identity,
    warning: identity,
    lane: (_: number, s: string) => s,
  };
  const request = implementationRead(approved);
  assert.ok(request !== undefined);
  const impl = implementationPresentation(approved, {
    key: request.key,
    state: "current",
    tasks: [observed("restore", "closed"), observed("verify", "in_progress")],
  });
  const [closed, active] = impl.rows;
  assert.ok(closed !== undefined && active !== undefined);
  const open = { ...closed, state: ImplementationState.Open };
  const eleven = {
    ...impl,
    rows: [
      closed,
      active,
      ...Array.from({ length: 9 }, (_, index) => ({
        ...open,
        id: `task-${String(index)}`,
      })),
    ],
  };
  assert.deepEqual(renderBeadProgress(eleven, theme, 48, 3), [
    "Beads  ●◐○○○○○○○○",
    "       ○",
  ]);
  assert.deepEqual(renderBeadProgress(eleven, theme, 11, 3), [
    "Beads  ●◐○○",
    "       ○○○○",
    "       ○○○",
  ]);
  assert.deepEqual(renderBeadProgress(eleven, theme, 48, 1), [
    "Beads  ●◐○○○○○○○○ +1",
  ]);
  assert.deepEqual(renderBeadProgress(eleven, theme, 11, 1), ["Beads  +11"]);
  assert.deepEqual(
    renderBeadProgress(implementationPresentation(approved), theme, 40, 3),
    [],
  );
  assert.deepEqual(renderBeadProgress(eleven, theme, 0, 3), []);
  const large = { ...eleven, rows: Array.from({ length: 61 }, () => active) };
  const rows = renderBeadProgress(large, theme, 40, 20);
  assert.equal(rows.length, 3);
  assert.equal(rows.at(-1), "       ◐◐◐◐◐◐◐◐◐◐ +31");
  const snapshot = {
    implementation: eleven,
    prioritizeSpecification: false,
    dockColumns: [implementationColumn(eleven)],
  };
  assert.deepEqual(
    renderSocratesDock(snapshot, theme, 48, 1, false),
    renderBeadProgress(eleven, theme, 48, 1),
  );
  assert.match(
    renderStatusSidebar(snapshot, theme, 45, 14).join("\n"),
    /Beads {2}●◐○○○○○○○○/u,
  );
  const spec = {
    id: "specification",
    title: "Specification",
    groups: [],
    summary: "Awaiting operator input",
  };
  const priority = {
    ...snapshot,
    dockColumns: [spec, implementationColumn(eleven)],
    prioritizeSpecification: true,
  };
  assert.deepEqual(renderSocratesDock(priority, theme, 57, 2, false), [
    "Specification",
    "Beads  ●◐○○○○○○○○ +1",
  ]);
  assert.deepEqual(
    renderSocratesDock(
      { ...priority, implementation: impl },
      theme,
      57,
      3,
      false,
    ),
    ["Specification", "Beads  ●◐", "Awaiting operator input"],
  );
  const partial = implementationPresentation(approved, {
    key: request.key,
    state: "current",
    tasks: [observed("restore", "closed")],
  });
  assert.deepEqual(renderBeadProgress(partial, theme, 48, 1), ["Beads  ●?"]);
});

await test("stale, missing and mismatched observations cannot preserve a completed state", () => {
  const request = implementationRead(approved);
  assert.ok(request !== undefined);
  const wrongKey = implementationPresentation(approved, {
    key: "another-plan",
    state: "current",
    tasks: [observed("restore", "closed")],
  });
  assert.equal(wrongKey.counts[ImplementationState.Unknown], 2);
  const changed = observed("restore", "closed");
  changed.metadata["studio.approval"] = "old-digest";
  const mismatch = implementationPresentation(approved, {
    key: request.key,
    state: "current",
    tasks: [changed],
  });
  assert.equal(mismatch.counts[ImplementationState.Unknown], 2);
  const unavailable = implementationPresentation(approved, {
    key: request.key,
    state: "unavailable",
  });
  assert.equal(unavailable.label, "Beads unavailable");
  assert.equal(unavailable.counts[ImplementationState.Unknown], 2);
  const changedPlan = { ...approved, approved: "old-digest" };
  assert.equal(implementationRead(changedPlan), undefined);
  assert.equal(
    implementationPresentation(changedPlan).phase,
    ImplementationPhase.LinkChanged,
  );
});

await test("pending and uncertain handoffs retain task uncertainty", () => {
  assert.ok(approved.handoff !== undefined);
  for (const [handoff, phase] of [
    [HandoffPhase.Pending, ImplementationPhase.HandoffPending],
    [HandoffPhase.Uncertain, ImplementationPhase.HandoffUncertain],
  ] as const) {
    const source: ImplementationSource = {
      ...approved,
      handoff: { ...approved.handoff, phase: handoff },
    };
    const display = implementationPresentation(source);
    assert.equal(display.phase, phase);
    assert.equal(display.counts[ImplementationState.Unknown], 2);
    assert.equal(implementationRead(source), undefined);
  }
  const empty = implementationPresentation({ revision });
  assert.equal(empty.phase, ImplementationPhase.NotPlanned);
  assert.deepEqual(empty.rows, []);
});

await test("task-bound approval preserves its explicit spec version and supports no child breakdown", () => {
  const bead = beadSchema.parse({
    id: "bd-parent",
    title: "Restore transcript",
    status: "in_progress",
    revision: "accepted-version",
  });
  const direct = draftSchema.parse({
    summary: "Restore the current bead.",
    tasks: [],
  });
  const source: ImplementationSource = {
    revision: "approval-version",
    specification,
    source: authority,
    bead,
    leadPlan: {
      mode: LeadMode.Implementing,
      draft: direct,
      digest: planDigest(direct),
      specificationVersion: 1,
      children: {},
    },
  };
  const request = implementationRead(source);
  assert.ok(request !== undefined);
  assert.deepEqual(request.ids, [bead.id]);
  const display = implementationPresentation(source, {
    key: request.key,
    state: "current",
    tasks: [{ ...bead, revision: "completion-version", status: "closed" }],
  });
  assert.equal(display.specificationVersion, 1);
  assert.equal(display.rows[0]?.status, "Closed");
  assert.equal(
    implementationRead({
      ...source,
      specification: { ...specification, version: 2 },
    }),
    undefined,
  );
});

await test("only the confirmed metadata revision preserves existing coverage on an approved task-bound plan", () => {
  const frozen = specRecord.parse({
    ...specification,
    draft: {
      objective: "Recover transcripts.",
      scope: ["Local sessions"],
      requirements: [
        { id: "R1", outcome: "Recover bytes", acceptance: "Byte equality" },
      ],
      decisions: [],
      blockingQuestions: [],
      coverage: {
        domains: [],
        assessments: [
          {
            propertyId: "verification",
            status: "satisfied",
            reason: "R1 requires byte equality.",
          },
        ],
      },
    },
  });
  frozen.coverageRevision = coverageToken(frozen);
  const plan = {
    mode: LeadMode.Implementing as const,
    draft,
    digest,
    specificationVersion: frozen.version,
    briefRevisionAdvance: { from: frozen.acceptedRevision, to: "metadata-v2" },
    children: { restore: "bd-restore", verify: "bd-verify" },
  };
  const source: ImplementationSource = {
    revision: "metadata-v2",
    specification: frozen,
    source: authority,
    bead: observed("parent", "in_progress"),
    leadPlan: plan,
  };
  assert.equal(coverageFresh(frozen, assessmentRevision(source)), true);
  const invalidated = { ...frozen, coverageRevision: undefined };
  assert.equal(
    coverageFresh(
      invalidated,
      assessmentRevision({ ...source, specification: invalidated }),
    ),
    false,
  );
  for (const unconfirmed of [
    { ...source, revision: "changed-after-approval" },
    { ...source, leadPlan: { ...plan, briefRevisionAdvance: undefined } },
    { ...source, leadPlan: { ...plan, digest: "different-draft" } },
    { ...source, leadPlan: { ...plan, specificationVersion: 2 } },
  ])
    assert.equal(coverageFresh(frozen, assessmentRevision(unconfirmed)), false);
});

await test("a switched graph ignores a late read and polling failure replaces confirmed states", async () => {
  const requests: {
    key: string;
    finish: (value: ImplementationObservation) => void;
    fail: (error: Error) => void;
  }[] = [];
  const waitFor = async (matches: () => boolean) => {
    for (let count = 0; count < 100 && !matches(); count++)
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    assert.ok(matches());
  };
  const watch = createImplementationWatch({
    changed: () => {},
    pollMs: 4,
    read: (source) =>
      new Promise((finish, fail) => {
        const request = implementationRead(source);
        assert.ok(request !== undefined);
        requests.push({ key: request.key, finish, fail });
      }),
  });
  try {
    watch.setSource(proposed);
    assert.equal(watch.observation(), undefined);
    watch.setSource(approved);
    watch.setSource(approved);
    await waitFor(() => requests.length === 1);
    const old = requests[0];
    assert.ok(old !== undefined);
    const other = {
      ...approved,
      graph: { ...approved.graph, verify: "bd-other" },
    };
    watch.setSource(other);
    await waitFor(() => requests.length === 2);
    const next = requests[1];
    assert.ok(next !== undefined);
    old.finish({
      key: old.key,
      state: "current",
      tasks: [observed("restore", "closed")],
    });
    next.finish({
      key: next.key,
      state: "current",
      tasks: [observed("restore", "in_progress")],
    });
    await waitFor(() => watch.observation()?.state === "current");
    assert.equal(watch.observation()?.key, next.key);
    assert.equal(
      implementationPresentation(other, watch.observation()).rows[0]?.status,
      "In progress",
    );
    await waitFor(() => requests.length === 3);
    assert.equal(watch.observation()?.state, "current");
    requests[2]?.fail(new Error("Offline"));
    await waitFor(() => watch.observation()?.state === "unavailable");
    assert.equal(
      implementationPresentation(other, watch.observation()).counts[
        ImplementationState.Unknown
      ],
      2,
    );
    watch.setSource(undefined);
    assert.equal(watch.observation(), undefined);
  } finally {
    watch.dispose();
  }
});

await test("the worker roster distinguishes an empty plan from partial and failed Beads reads", async (ctx) => {
  const active = {
    ...observed("restore", "in_progress"),
    assignee: `pi:${randomUUID()}`,
  };
  const finished = observed("verify", "closed");
  const served = new Map([
    [active.id, active],
    [finished.id, finished],
  ]);
  ctx.mock.method(TaskBeads.prototype, "get", (id: string) => {
    const row = served.get(id);
    return row === undefined
      ? Promise.reject(new Error("Beads unavailable"))
      : Promise.resolve(row);
  });

  const initial = await readImplementation(approved);
  assert.ok(initial?.state === "current");
  assert.equal(initial.workerEvidenceError, undefined);
  assert.deepEqual(
    initial.workers?.map((worker) => worker.beadId),
    [active.id],
  );

  served.delete(finished.id);
  const partial = await readImplementation(approved);
  assert.ok(partial?.state === "current");
  assert.ok(partial.workerEvidenceError !== undefined);
  assert.deepEqual(
    partial.workers?.map((worker) => worker.beadId),
    [active.id],
  );

  served.set(finished.id, finished);
  served.delete(active.id);
  const lost = await readImplementation(approved);
  assert.ok(lost?.state === "current");
  assert.ok(lost.workerEvidenceError !== undefined);
  assert.deepEqual(lost.workers ?? [], []);

  served.set(active.id, {
    ...active,
    metadata: { ...active.metadata, "studio.graph": "replaced" },
  });
  const foreign = await readImplementation(approved);
  assert.ok(foreign?.state === "current");
  assert.ok(foreign.workerEvidenceError !== undefined);
  assert.deepEqual(foreign.workers ?? [], []);

  served.clear();
  const unavailable = await readImplementation(approved);
  assert.ok(unavailable?.state === "unavailable");
  assert.ok(unavailable.message !== undefined);

  served.set(active.id, { ...active, status: "closed" });
  served.set(finished.id, finished);
  const recovered = await readImplementation(approved);
  assert.ok(recovered?.state === "current");
  assert.equal(recovered.workerEvidenceError, undefined);
  assert.deepEqual(recovered.workers ?? [], []);
});
