import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  defaultPaneKeybindings,
  paneKeybindingsSchema,
} from "../pane-keybindings-config.ts";
import { TaskBrowser } from "../tasks/browser.ts";
import { currentReviewFinding, type TaskSnapshot } from "../tasks/model.ts";
import {
  hasInteractivePane,
  focusInteractivePane,
} from "../execution/interactive-target.ts";
import { executionSchema, ExecutionPhase } from "../execution/store.ts";

const theme: Pick<Theme, "fg" | "bg" | "bold" | "getBgAnsi"> = {
  fg: (_tone, value) => value,
  bg: (_tone, value) => value,
  bold: (value) => value,
  getBgAnsi: () => "",
};
const owner = "ddd6fcba-a459-4dc3-808e-2ffaf8ab784b";
const selected = {
  id: "ui-1",
  title: "Inline limits\x1b[2J",
  status: "in_progress",
  assignee: `pi:${owner}`,
  description: "Choose one layout rule.",
  acceptance_criteria: "Preserve word boundaries.",
};
const related = {
  id: "ui-2",
  title: "Wide 漢字",
  status: "in_progress",
  description: "Independent evidence for wide glyphs.",
};
const finding =
  "Duplicated rule in `fit()` and `render()`.\x1b]52;c;private-data\x07";
const attempt = executionSchema.parse({
  id: owner,
  project: "a93fe08d-5663-4c9b-bf6e-97a846663808",
  bead: { ...selected, revision: "r1" },
  profile: "personal",
  phase: ExecutionPhase.Running,
  message: "Repair requested",
  reviewFinding: finding,
});
const snapshot: TaskSnapshot = {
  tasks: [selected, related],
  attempts: [attempt],
  observedAt: "12:00",
  limitReached: false,
  focusable: new Set([related.id]),
};
function browser(
  data = snapshot,
  initial?: string,
  emptyHint?: string,
  height = 24,
  bindings = defaultPaneKeybindings,
) {
  const calls: string[] = [];
  const component = new TaskBrowser(
    data,
    {
      label: "studio\x1b[2J",
      identity: "private-project",
      ...(emptyHint === undefined ? {} : { emptyHint }),
      load: () => Promise.resolve(data),
      show: (id) =>
        Promise.resolve(data.tasks.find((task) => task.id === id) ?? selected),
    },
    theme,
    () => height,
    () => {},
    (id) => {
      calls.push(id ?? "cancel");
    },
    initial,
    bindings,
  );
  return { component, calls };
}

await test("the compact inspector preserves the current owner's reviewer finding and strips terminal payloads", () => {
  for (const width of [80, 60]) {
    const { component } = browser(snapshot, selected.id);
    const rows = component.render(width);
    const text = rows.join("\n");
    assert(rows.length <= 24);
    assert(rows.every((line) => visibleWidth(line) === width));
    assert.match(text, /The reviewer found:/u);
    assert.match(text, /Duplicated rule/u);
    assert.match(text, /fit\(\)/u);
    assert.equal(text.includes("\x1b"), false, text);
    assert.doesNotMatch(text, /Changes requested|private-data/u);
  }
  assert.equal(
    currentReviewFinding({ ...selected, assignee: "another-owner" }, snapshot),
    undefined,
  );
  assert.equal(
    currentReviewFinding({ ...selected, status: "closed" }, snapshot),
    undefined,
  );
});

await test("pane focus follows the selected task and wide titles remain bounded", () => {
  const bindings = paneKeybindingsSchema.parse({
    pane: { up: [], down: [], activate: "o", focusWorker: "g", close: [] },
    tasks: { quit: "x", refresh: [] },
  });
  const { component, calls } = browser(
    snapshot,
    undefined,
    undefined,
    24,
    bindings,
  );
  const view = () => component.render(60).join("\n");
  const initial = view();
  assert.match(initial, /o inspect {2}x close/u);
  assert.doesNotMatch(initial, /move|refresh|Esc close/u);
  for (const key of ["j", "\x1b[B", "r", "\r", "\x1b", "q"])
    component.handleInput(key);
  assert.equal(view(), initial);
  component.handleInput("\x1b[C");
  assert.deepEqual(calls, []);
  assert.equal(
    component.handleMouse({
      type: "wheel",
      button: "none",
      x: 5,
      y: 3,
      screenX: 7,
      screenY: 6,
      width: 60,
      height: 24,
      shift: false,
      alt: false,
      ctrl: false,
      wheelDelta: 1,
    }).handled,
    true,
  );
  assert.match(component.render(60).join("\n"), /Wide 漢字/u);
  component.handleInput("\x1b[C");
  assert.deepEqual(calls, []);
  component.handleInput("g");
  assert.deepEqual(calls, [related.id]);
});

await test("empty projects retain their source-specific planning guidance and never select or approve work", () => {
  const empty = {
    ...snapshot,
    tasks: [],
    attempts: [],
    focusable: new Set<string>(),
  };
  for (const hint of [
    "Draft a plan with /plan-draft <description>.",
    "Review your draft with /plan.",
    undefined,
  ]) {
    const { component, calls } = browser(empty, undefined, hint);
    for (const width of [80, 60]) {
      const rows = component.render(width);
      const text = rows.join("\n");
      assert(rows.every((line) => visibleWidth(line) === width));
      assert.match(text, /No tasks yet/u);
      assert.equal(text.includes("\x1b"), false, text);
      assert(text.includes(hint ?? "Tasks added in Beads will appear here."));
      assert.doesNotMatch(
        text,
        /private-project|Execution evidence|Changes requested/u,
      );
    }
    for (const key of ["k", "j", "\x1b[C", "\r"]) component.handleInput(key);
    assert.deepEqual(calls, []);
    component.handleInput("\x1b");
    assert.deepEqual(calls, ["cancel"]);
  }
  const tiny = browser(empty, undefined, undefined, 1).component.render(30);
  assert.equal(tiny.length, 1);
  assert.match(tiny.join(""), /No tasks yet/u);
});

await test("production pane eligibility keeps headless and reviewer tasks out of browser focus", async () => {
  const previous = process.env["ZELLIJ_SESSION_NAME"];
  process.env["ZELLIJ_SESSION_NAME"] = "task-owned-gating-fixture";
  try {
    const background = { ...attempt, reviewFinding: undefined };
    const interactive = {
      ...background,
      interactive: {
        session: "task-owned-gating-fixture",
        socket: "fixture",
        tab: 0,
      },
      pane: 7,
      workerSessionFile: "fixture-transcript",
      launchSettled: false,
    };
    const cases = [
      { record: background, eligible: false },
      { record: interactive, eligible: true },
      {
        record: { ...interactive, phase: ExecutionPhase.Reviewing },
        eligible: false,
      },
      {
        record: { ...interactive, phase: ExecutionPhase.Complete },
        eligible: false,
      },
      { record: { ...interactive, launchSettled: true }, eligible: false },
      {
        record: { ...interactive, workerSessionFile: undefined },
        eligible: false,
      },
      {
        record: {
          ...interactive,
          interactive: {
            ...interactive.interactive,
            session: "another-session",
          },
        },
        eligible: false,
      },
    ];
    for (const { record, eligible } of cases) {
      // Exercise the predicate used by the extension's runtime-attempt route, not a supplied empty set.
      const available = hasInteractivePane(record);
      assert.equal(available, eligible);
      const { component, calls } = browser(
        {
          ...snapshot,
          tasks: [selected],
          attempts: [record],
          focusable: new Set(available ? [selected.id] : []),
        },
        selected.id,
        undefined,
        40,
      );
      const text = component.render(100).join("\n").replace(/\s+/gu, " ");
      if (record === background)
        assert.match(
          text,
          /Interactive guidance is unavailable for a background worker/u,
        );
      component.handleInput("\x1b[C");
      assert.deepEqual(calls, eligible ? [selected.id] : []);
    }
    await assert.rejects(
      focusInteractivePane(background, "/fixture-not-opened"),
      /has no live worker in this session/u,
    );
  } finally {
    if (previous === undefined) delete process.env["ZELLIJ_SESSION_NAME"];
    else process.env["ZELLIJ_SESSION_NAME"] = previous;
  }
});
