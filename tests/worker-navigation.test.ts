import assert from "node:assert/strict";
import { test } from "node:test";
import { Input, ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import type { WorkerAssignment } from "../tasks/workers.ts";
import { WorkerNavigation } from "../socrates/worker-navigation.ts";

await test("worker keyboard focus follows the selected attempt across refreshes and returns to the lead", () => {
  const working: WorkerAssignment = {
    beadId: "st-one",
    attemptId: "run-one",
    title: "First",
    phase: "Implementing",
    role: "Worker",
    activity: "active",
    focusable: true,
  };
  const blocked: WorkerAssignment = {
    ...working,
    beadId: "st-two",
    attemptId: "run-two",
    title: "Second",
    focusable: false,
  };
  const terminal = new ProcessTerminal();
  terminal.hideCursor = () => {};
  const tui = new TuiMainScreen(terminal);
  const lead = new Input();
  lead.setValue("unsent lead draft");
  tui.addChild(lead);
  tui.setFocus(lead);
  const type = (key: string) => tui.getFocusedComponent()?.handleInput?.(key);
  const events: string[] = [];
  const actions = {
    changed() {},
    inspect: (row: WorkerAssignment) => {
      events.push(`inspect ${row.beadId}`);
    },
    focusPane: (row: WorkerAssignment) => {
      events.push(`focus ${row.attemptId}`);
    },
  };
  const roster = new WorkerNavigation();
  roster.toggleFocus(tui, actions);
  assert.equal(roster.focused, false);
  roster.setRows([working, blocked]);
  assert.equal(roster.focused, false);
  roster.toggleFocus(tui, actions);
  assert.equal(roster.focused, true);
  assert.deepEqual(tui.getFocusedComponent()?.render(80), []);
  const modalInput = new Input();
  const modal = tui.showOverlay(modalInput);
  type("j");
  assert.equal(modalInput.getValue(), "j");
  assert.equal(roster.selectedAttemptId, working.attemptId);
  modal.hide();
  assert.equal(roster.focused, true);
  type("j");
  assert.equal(roster.selectedAttemptId, blocked.attemptId);
  roster.setRows([blocked, working]);
  type("\x1b[C");
  assert.equal(roster.focused, true);
  type(" ");
  assert.equal(roster.collapsed, true);
  type("\r");
  assert.deepEqual(events, []);
  type(" ");
  type("\r");
  assert.deepEqual(events, ["inspect st-two"]);
  assert.equal(roster.focused, false);
  roster.toggleFocus(tui, actions);
  type("j");
  type("\x1b[C");
  assert.deepEqual(events, ["inspect st-two", "focus run-one"]);
  assert.equal(roster.focused, false);
  roster.toggleFocus(tui, actions);
  roster.setRows([{ ...working, attemptId: "replacement" }]);
  type("\x1b[C");
  assert.deepEqual(events, ["inspect st-two", "focus run-one"]);
  assert.equal(roster.selectedAttemptId, undefined);
  assert.equal(roster.focused, false);
  roster.toggleFocus(tui, actions);
  type("\x1b");
  assert.equal(roster.focused, false);
  assert.equal(tui.getFocusedComponent(), lead);
  assert.equal(lead.getValue(), "unsent lead draft");
});
