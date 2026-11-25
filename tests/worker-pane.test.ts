import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Input,
  ProcessTerminal,
  TuiMainScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { floatingPaneHeight } from "../floating-pane.ts";
import { WorkerPane } from "../socrates/worker-pane.ts";
import type { WorkerAssignment } from "../tasks/workers.ts";

const working: WorkerAssignment = {
  beadId: "st-one",
  attemptId: "run-one",
  title: "First assignment",
  phase: "Implementing",
  role: "Worker",
  activity: "active",
  focusable: true,
};

const blocked: WorkerAssignment = {
  ...working,
  beadId: "st-two",
  attemptId: "run-two",
  title: "Second assignment",
  phase: "Needs input",
  activity: "attention",
  focusable: false,
  question: "Which terminal size?",
};

function setup(
  focus?: (row: WorkerAssignment, signal: AbortSignal) => Promise<void>,
) {
  const terminal = new ProcessTerminal();
  terminal.hideCursor = () => {};
  const tui = new TuiMainScreen(terminal);
  const lead = new Input();
  lead.setValue("unsent lead draft");
  tui.addChild(lead);
  tui.setFocus(lead);
  const pane = new WorkerPane();
  const events: string[] = [];
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    getBgAnsi: () => "",
  };
  const open = () => {
    pane.open(tui, theme, {
      inspect(row) {
        events.push(`inspect ${row.beadId}`);
      },
      focusPane(row, signal) {
        events.push(`focus ${row.attemptId}`);
        return focus?.(row, signal) ?? Promise.resolve();
      },
      onError(error) {
        events.push(String(error));
      },
    });
  };
  const type = (key: string) => tui.getFocusedComponent()?.handleInput?.(key);
  const render = (width = 100) =>
    tui.getFocusedComponent()?.render(width) ?? [];
  return { pane, tui, lead, events, open, type, render };
}

await test("the workers float shows details, preserves selection across refreshes and restores the lead draft", async () => {
  const { pane, tui, lead, events, open, type, render } = setup();
  pane.setRows([working, blocked]);
  assert.equal(tui.getFocusedComponent(), lead);
  open();
  const surface = tui.getFocusedComponent();
  open();
  assert.equal(surface, tui.getFocusedComponent());
  assert.match(render()[0] ?? "", /Workers/u);
  assert.match(render().join("\n"), /› First assignment.*│ First assignment/u);
  const dialog = new Input();
  const modal = tui.showOverlay(dialog);
  type("j");
  assert.equal(dialog.getValue(), "j");
  modal.hide();
  type("j");
  pane.setRows([{ ...blocked, question: "Use the new size?" }, working]);
  const wide = render().join("\n");
  assert.match(wide, /› Second assignment.*│ Second assignment/u);
  assert.match(wide, /Use the new size\?/u);
  assert.match(wide, /↑↓ select · Enter inspect · Esc close/u);
  type("\x1b[C");
  assert.equal(pane.focused, true);
  type("\r");
  assert.deepEqual(events, ["inspect st-two"]);
  assert.equal(tui.getFocusedComponent(), lead);
  open();
  type("\x1b[B");
  assert.match(render().join("\n"), /→ pane/u);
  type("\x1b[C");
  await Promise.resolve();
  assert.deepEqual(events, ["inspect st-two", "focus run-one"]);
  assert.equal(tui.getFocusedComponent(), lead);
  open();
  type("\x1b");
  assert.equal(pane.focused, false);
  assert.equal(tui.getFocusedComponent(), lead);
  assert.equal(lead.getValue(), "unsent lead draft");
});

await test("lost ownership disables actions until a current assignment is explicitly selected", () => {
  const { pane, events, open, type, render } = setup();
  pane.setRows([working]);
  open();
  pane.setRows([]);
  type("j");
  pane.setRows([{ ...working, beadId: "st-other" }]);
  assert.equal(pane.focused, true);
  assert.match(render().join("\n"), /Assignment changed/u);
  type("\r");
  type("\x1b[C");
  assert.deepEqual(events, []);
  type("j");
  assert.doesNotMatch(render().join("\n"), /Assignment changed/u);
  pane.setRows([{ ...working, beadId: "st-other", attemptId: "replacement" }]);
  type("\x1b[C");
  assert.deepEqual(events, []);
  type("k");
  type("\x1b[C");
  assert.deepEqual(events, ["focus replacement"]);
});

await test("the float can open before the first assignment and report stale evidence", () => {
  const { pane, tui, lead, open, render, type } = setup();
  open();
  assert.match(render().join("\n"), /No current assignments/u);
  pane.setRows([], undefined, true);
  assert.match(render().join("\n"), /Loading worker assignments/u);
  assert.doesNotMatch(render().join("\n"), /No current assignments/u);
  pane.setRows([], "timeout");
  assert.match(render().join("\n"), /Worker status unavailable/u);
  assert.doesNotMatch(render().join("\n"), /No current assignments/u);
  pane.setRows([blocked]);
  assert.match(render().join("\n"), /› Second assignment/u);
  pane.reset();
  assert.equal(tui.getFocusedComponent(), lead);
  open();
  assert.match(render().join("\n"), /No current assignments/u);
  type("\x03");
  assert.equal(tui.getFocusedComponent(), lead);
});

await test("the narrow float stacks a scrolling assignment list over sanitized details within the viewport", () => {
  const { pane, tui, open, type, render } = setup();
  const rows = Array.from({ length: 35 }, (_, i) => ({
    ...blocked,
    attemptId: String(i),
    title: `項目 ${String(i)}\x1b[2J\nnew`,
  }));
  pane.setRows(rows);
  open();
  for (let i = 0; i < rows.length; i++) type("j");
  for (const width of [36, 56, 100]) {
    const lines = render(width);
    assert.ok(lines.length <= floatingPaneHeight(tui.terminal.rows));
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.match(lines.join("\n"), /› 項目 34 new/u);
    assert.match(lines.join("\n"), /Which terminal size/u);
    assert.ok(
      lines.every((line) => !line.includes("\x1b[2J") && !line.includes("\n")),
    );
    if (width === 56) {
      const row = lines.findIndex((line) => line.includes("› 項目 34"));
      const detail = lines.findIndex((line) =>
        line.includes("Which terminal size"),
      );
      assert.ok(detail > row);
    }
  }
  pane.close();
});

await test("long decision questions can be read in full without leaving the selected worker", () => {
  const { pane, open, type, render } = setup();
  pane.setRows([
    { ...blocked, question: `${"Continue ".repeat(180)}Finished?` },
    working,
  ]);
  open();
  const initial = render(56).join("\n");
  assert.match(initial, /PgUp\/PgDn scroll/u);
  assert.doesNotMatch(initial, /Finished/u);
  for (let i = 0; i < 30; i++) type("\x1b[6~");
  assert.match(render(56).join("\n"), /Finished\?/u);
  type("\x1b[5~");
  assert.doesNotMatch(render(56).join("\n"), /Finished/u);
  type("j");
  type("k");
  assert.equal(render(56).join("\n"), initial);
  pane.close();
});

await test("a wheel over the worker pane scrolls its preview and consumes the event at both ends", () => {
  const { pane, tui, open, render } = setup();
  pane.setRows([
    { ...blocked, question: `${"Continue ".repeat(180)}Finished?` },
  ]);
  open();
  const surface = tui.getFocusedComponent();
  assert.ok(surface !== null);
  const wheel = (wheelDelta: number) =>
    surface.handleMouse?.({
      type: "wheel",
      button: "none",
      x: 20,
      y: 5,
      screenX: 32,
      screenY: 10,
      width: 56,
      height: 14,
      shift: false,
      alt: false,
      ctrl: false,
      wheelDelta,
    });
  assert.doesNotMatch(render(56).join("\n"), /Finished/u);
  assert.equal(wheel(-100)?.handled, true);
  assert.equal(wheel(100)?.handled, true);
  assert.match(render(56).join("\n"), /Finished/u);
  assert.equal(wheel(1)?.handled, true);
  assert.equal(wheel(-100)?.handled, true);
  assert.doesNotMatch(render(56).join("\n"), /Finished/u);
  pane.close();
});

await test("worker pane focus is single-flight, stays open on failure and honors cancellation before switching", async () => {
  let pending:
    | {
        signal: AbortSignal;
        resolve: () => void;
        reject: (reason: Error) => void;
      }
    | undefined;
  const { pane, open, render, type, events, tui, lead } = setup(
    (_row, signal) =>
      new Promise<void>((resolve, reject) => {
        pending = { signal, resolve, reject };
      }),
  );
  pane.setRows([working, blocked]);
  open();
  type("\x1b[C");
  type("j");
  type("\r");
  type("\x1b[C");
  assert.deepEqual(events, ["focus run-one"]);
  assert.match(render().join("\n"), /Focusing worker pane/u);
  assert.ok(pending !== undefined);
  pending.reject(new Error("Pane exited"));
  await Promise.resolve();
  assert.equal(pane.focused, true);
  assert.match(render().join("\n"), /› First assignment/u);
  assert.deepEqual(events, ["focus run-one", "Error: Pane exited"]);
  type("\x1b[C");
  const escaped = pending;
  type("\x1b");
  assert.equal(escaped.signal.aborted, true);
  assert.equal(tui.getFocusedComponent(), lead);
  open();
  escaped.resolve();
  await Promise.resolve();
  assert.equal(pane.focused, true);
  type("\x1b[C");
  pane.setRows([blocked]);
  assert.equal(pending.signal.aborted, true);
  pending.resolve();
  await Promise.resolve();
  assert.match(render().join("\n"), /Assignment changed/u);
  assert.equal(pane.focused, true);
  pane.close();
});
