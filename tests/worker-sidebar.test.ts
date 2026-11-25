import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { implementationColumn } from "../socrates/columns.ts";
import {
  implementationPresentation,
  ImplementationState,
} from "../socrates/implementation.ts";
import { LeadMode, draftSchema } from "../lead-plan.ts";
import {
  renderStatusSidebar,
  renderWorkerCompact,
  type WorkerSidebarView,
} from "../socrates/sidebar.ts";
import type { WorkerAssignment } from "../tasks/workers.ts";

const plain = (text: string) => text;
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
const worker: WorkerAssignment = {
  beadId: "bd-restore",
  attemptId: "abfa56-rest",
  title: "Restore graph focus",
  role: "Worker",
  phase: "Needs input",
  activity: "attention",
  question: "Should the parent keep focus?",
  focusable: false,
};
const review: WorkerAssignment = {
  beadId: "bd-verify",
  attemptId: "b22445-rest",
  title: "Verify focus handling",
  role: "Reviewer",
  phase: "Reviewing",
  activity: "active",
  focusable: false,
};
const view: WorkerSidebarView = { rows: [worker, review] };

await test("workers report questions and execution alongside a passive graph", () => {
  const implementation = implementationPresentation({
    revision: null,
    leadPlan: {
      mode: LeadMode.Planning,
      draft: draftSchema.parse({
        summary: "Check focus",
        tasks: [
          {
            key: "restore",
            title: worker.title,
            description: "Restore",
            acceptance: "Keeps focus",
          },
          {
            key: "verify",
            title: review.title,
            description: "Verify",
            acceptance: "Handles stale focus",
          },
        ],
      }),
    },
  });
  for (const row of implementation.rows) {
    row.beadId = `bd-${row.id}`;
    row.state = ImplementationState.InProgress;
  }
  const snapshot = {
    implementation,
    dockColumns: [implementationColumn(implementation)],
    prioritizeSpecification: false,
  };
  const render = (workers?: WorkerSidebarView) =>
    renderStatusSidebar(snapshot, theme, 49, 24, workers).join("\n");
  assert.equal(render(), render({ ...view, rows: [] }));
  const output = render(view);
  assert.match(
    output,
    /Implementation[\s\S]*Verify focus handling[\s\S]*Workers/u,
  );
  assert.doesNotMatch(output, /›|Alt\+W|Enter inspect|▸ Workers|▾ Workers/u);
  assert.match(output, /1 active · 1 needs you/u);
  assert.match(output, /Needs input {2}Worker · abfa56/u);
  assert.match(output, /Should the parent keep focus\?/u);
  assert.match(output, /Reviewing {2}Reviewer · b22445/u);
});

await test("compact workers prioritize operator questions, respect bounds and distinguish missing evidence", () => {
  const short = renderWorkerCompact(view, theme, 33, 2);
  assert.match(short[0] ?? "", /1 needs you/u);
  assert.equal(short[1], worker.question);
  const failed = { ...view, evidenceError: "Invalid record" };
  assert.match(
    renderWorkerCompact({ ...failed, rows: [] }, theme, 33, 3).join(" "),
    /Worker status unavailable/u,
  );
  assert.match(
    renderWorkerCompact(failed, theme, 33, 8, true).join(" "),
    /Workers · partial[\s\S]*Reviewing/u,
  );
  const partial = renderWorkerCompact(failed, theme, 33, 2);
  assert.match(partial[0] ?? "", /partial.*1 needs you/u);
  assert.equal(partial[1], worker.question);
  assert.doesNotMatch(short.join(" "), /Reviewer|Verify focus/u);
  const limited = renderWorkerCompact(view, theme, 33, 5, true).join(" ");
  assert.match(limited, /Should the parent keep focus\?[\s\S]*\+1 more/u);
  assert.doesNotMatch(limited, /Alt\+W|select/u);
  for (const width of [12, 24, 33, 56]) {
    for (const height of [1, 2, 3, 5, 8, 20]) {
      const rows = renderWorkerCompact(view, theme, width, height, true);
      assert.ok(rows.length <= height);
      assert.ok(rows.every((line) => visibleWidth(line) <= width));
    }
  }
});
