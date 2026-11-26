import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { ExecutionPhase, ExecutionStore, executionSchema, pendingDecision } from "../execution/store.ts";
import { StudioProfile } from "../config.ts";
import { CURSOR_MARKER, ProcessTerminal, getKeybindings, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { paneKeybindingsSchema } from "../pane-keybindings-config.ts";
import { DecisionEditor } from "../tasks/decision-editor.ts";
import { TaskBrowser } from "../tasks/browser.ts";
import { decisionDetails, taskNarrative, type TaskSnapshot } from "../tasks/model.ts";
import { recordDecision } from "../execution/decisions.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const theme: Pick<Theme, "fg" | "bg" | "bold" | "getBgAnsi"> = {
  fg: (_tone, value) => value,
  bg: (_tone, value) => value,
  bold: (value) => value,
  getBgAnsi: () => "",
};
await test("long questions scroll independently of multiline answers, and Escape discards the draft", () => {
  class TestTui extends TuiMainScreen {
    override requestRender(): void {}
  }
  const tui = new TestTui(new ProcessTerminal());
  const results: (string | undefined)[] = [];
  const question = "Question begins " + "Which contract should be kept? ".repeat(56) + "Final option?";
  const editor = new DecisionEditor(tui, theme, question, (answer) => {
    results.push(answer);
  });
  editor.focused = true;
  const render = () => editor.render(36).join("\n");
  const frame = editor.render(36);
  assert.match(frame[0] ?? "", /^╭─ Worker question .*╮$/u);
  assert.ok(frame.slice(1, -1).every((row) => row.startsWith("│") && row.endsWith("│")));
  assert.match(frame.at(-1) ?? "", /^╰─ Enter submit .*╯$/u);
  assert.match(render(), /Question begins/u);
  assert.equal(
    editor.handleMouse({
      type: "wheel",
      button: "none",
      x: 5,
      y: 2,
      screenX: 7,
      screenY: 6,
      width: 36,
      height: 18,
      shift: false,
      alt: false,
      ctrl: false,
      wheelDelta: 3,
    }).handled,
    true,
  );
  assert.doesNotMatch(render(), /Question begins/u);
  for (let index = 0; index < 20; index++) editor.handleInput("\x1b[6~");
  assert.match(render(), /Final option/u);
  const first = "Keep this requirement. ".repeat(20);
  editor.handleInput("\x1b[200~" + first + "\x1b[201~");
  editor.handleInput("\x1b[13;2u");
  editor.handleInput("Second line");
  assert.match(render(), /Second line/u);
  assert.ok(editor.render(36).every((line) => visibleWidth(line) === 36));
  editor.handleInput("\r");
  assert.deepEqual([...results], [first + "\nSecond line"]);
  const cancelled = new DecisionEditor(tui, theme, question, (answer) => {
    results.push(answer);
  });
  cancelled.handleInput("Unsubmitted answer");
  cancelled.handleInput("\x1b");
  assert.deepEqual(results, [first + "\nSecond line", undefined]);
});

await test("the reply cursor stays inside the drawer when the terminal shrinks", () => {
  class ResizableTerminal extends ProcessTerminal {
    rowCount = 24;
    override get rows(): number {
      return this.rowCount;
    }
  }
  class TestTui extends TuiMainScreen {
    override requestRender(): void {}
  }
  const terminal = new ResizableTerminal();
  const tui = new TestTui(terminal);
  const editor = new DecisionEditor(tui, theme, "A long question ".repeat(10), () => {});
  editor.focused = true;
  for (let i = 0; i < 10; i++) {
    editor.handleInput("Wrapped answer ".repeat(3));
    editor.handleInput("\x1b[13;2u");
  }
  editor.handleInput("Last line");
  for (const height of [1, 6, 9, 12, 24, 60]) {
    terminal.rowCount = height;
    for (const width of [1, 2, 3, 4, 6, 7, 8, 16, 60, 80]) {
      const rows = editor.render(width);
      assert.ok(rows.length <= Math.max(1, Math.min(12, Math.floor(height / 3))));
      assert.ok(
        rows.every((row) => visibleWidth(row) === width),
        `Width ${String(width)} at ${String(height)} rows`,
      );
      assert.equal(
        rows.filter((row) => row.includes(CURSOR_MARKER)).length,
        1,
        `Cursor at ${String(width)}×${String(height)}`,
      );
    }
  }
});

await test("the answer editor follows Pi text bindings and keeps pane mnemonics available as prose", () => {
  class TestTui extends TuiMainScreen {
    override requestRender(): void {}
  }
  const tui = new TestTui(new ProcessTerminal());
  const keys = getKeybindings();
  const previous = keys.getUserBindings();
  const bindings = paneKeybindingsSchema.parse({
    decision: { pageUp: "f2", pageDown: "f5" },
  });
  const results: (string | undefined)[] = [];
  const open = () =>
    new DecisionEditor(
      tui,
      theme,
      "First option? " + "Which contract should we keep? ".repeat(100) + "Last option?",
      (answer) => {
        results.push(answer);
      },
      bindings,
    );
  try {
    keys.setUserBindings({
      ...previous,
      "tui.input.submit": "f2",
      "tui.input.newLine": "f3",
      "tui.select.cancel": "f4",
    });
    const editor = open();
    const view = () => editor.render(80).join("\n");
    assert.match(view(), /F2 submit {2}F3 newline {2}F4 cancel/u);
    assert.match(view(), /F5 scroll question/u);
    assert.doesNotMatch(view(), /F2\/F5|PgUp|Esc cancel/u);
    editor.handleInput("\x1b[6~");
    assert.match(view(), /First option/u);
    editor.handleInput("\x1b[15~");
    assert.doesNotMatch(view(), /First option/u);
    for (const character of "qjk wts") editor.handleInput(character);
    editor.handleInput("\x1bOR"); // F3
    editor.handleInput("continue");
    editor.handleInput("\x1bOQ"); // F2 also appears in decision.pageUp
    assert.deepEqual([...results], ["qjk wts\ncontinue"]);
    const cancel = open();
    cancel.handleInput("\x1bOS"); // F4
    assert.deepEqual(results, ["qjk wts\ncontinue", undefined]);
  } finally {
    keys.setUserBindings(previous);
  }
});

await test("only explicit owned decisions offer Answer and capture the original request across a dialog refresh", async () => {
  const directory = await mkdtemp(join(tmpdir(), "decision-ui-"));
  const store = new ExecutionStore(directory);
  try {
    const id = randomUUID(),
      project = randomUUID();
    const task = {
      id: "task",
      title: "Operator decision task",
      status: "in_progress",
      assignee: `pi:${id}`,
    };
    const attempt = executionSchema.parse({
      id,
      project,
      profile: StudioProfile.Personal,
      phase: ExecutionPhase.Running,
      message: "working",
      launchToken: randomUUID(),
      launchSettled: true,
      revision: "r",
      bead: { ...task, revision: "r" },
    });
    store.saveAttempt(attempt);
    recordDecision(store, id, "Which accepted marker?");
    const waiting = store.attempt(id),
      request = pendingDecision(waiting);
    assert.ok(request !== undefined);
    let snapshot: TaskSnapshot = {
      tasks: [task],
      attempts: [waiting],
      observedAt: "native",
      focusable: new Set(),
      limitReached: false,
    };
    assert.match(decisionDetails(task, snapshot) ?? "", /Which accepted marker/u);
    assert.match(taskNarrative(task, snapshot), /awaiting an explicit operator decision/u);
    assert.equal(
      decisionDetails(task, {
        ...snapshot,
        attempts: [
          {
            ...attempt,
            phase: ExecutionPhase.Parked,
            message: "operator decision maybe",
          },
        ],
      }),
      undefined,
    );
    const calls: {
      id: string;
      request: string;
      question: string;
      taskTitle: string;
    }[] = [];
    let release: (() => void) | undefined;
    const dialog = new Promise<void>((resolve) => {
      release = resolve;
    });
    const browser = new TaskBrowser(
      snapshot,
      {
        label: "Fixture",
        identity: project,
        load: () => Promise.resolve(snapshot),
        show: () => Promise.resolve(task),
        answer: async (id, request, question, taskTitle) => {
          calls.push({ id, request, question, taskTitle });
          await dialog;
          throw new Error("This decision request is stale; refresh");
        },
      },
      theme,
      () => 40,
      () => {},
      () => {},
      task.id,
      paneKeybindingsSchema.parse({
        pane: { activate: "o" },
        tasks: { nextLink: "n", previousLink: "p" },
      }),
    );
    const instructions = browser.render(100).join("\n");
    assert.match(instructions, /n links {2}o open/u);
    browser.handleInput("\t");
    assert.equal(browser.render(100).join("\n"), instructions);
    let selected = false;
    for (let i = 0; i < 16; i++) {
      browser.render(100);
      browser.handleInput("n");
      if (browser.render(100).join("\n").includes("› ↗ Answer operator decision")) {
        selected = true;
        break;
      }
    }
    assert.ok(selected);
    const text = browser.render(100).join("\n");
    assert.match(text, /including other ready work/u);
    assert.doesNotMatch(text, /Retry attempt/u);
    browser.handleInput("\r");
    assert.equal(calls.length, 0);
    browser.handleInput("o");
    await Promise.resolve();
    assert.deepEqual(calls, [
      {
        id,
        request: request.id,
        question: request.question,
        taskTitle: task.title,
      },
    ]);
    snapshot = {
      ...snapshot,
      attempts: [
        {
          ...waiting,
          operatorDecisions: [{ ...request, id: randomUUID(), question: "Changed question" }],
        },
      ],
    };
    release?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.length, 1);
    assert.match(browser.render(100).join("\n"), /stale/u);
    for (const state of [
      { ...snapshot, answerBlocked: new Map([[id, "writer is uncertain"]]) },
      { ...snapshot, tasks: [{ ...task, assignee: "another-owner" }] },
    ]) {
      const view = new TaskBrowser(
        state,
        {
          label: "Fixture",
          identity: project,
          load: () => Promise.resolve(state),
          show: () => Promise.resolve(task),
          answer: () => Promise.resolve(true),
        },
        theme,
        () => 40,
        () => {},
        () => {},
        task.id,
      );
      assert.doesNotMatch(view.render(100).join("\n"), /↗ Answer operator decision/u);
      view.dispose();
    }
    browser.dispose();
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
