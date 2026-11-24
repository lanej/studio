import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThemeBg, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  createTaskDrawer,
  type EmptyTaskAction,
  type TaskDrawerItem,
} from "../task-drawer.ts";

const plain = {
  fg: (_tone: ThemeColor, value: string) => value,
  bg: (_tone: ThemeBg, value: string) => value,
  bold: (value: string) => value,
};

const selected = {
  row: {
    depth: 0,
    task: {
      id: "ui-1",
      title: "Inline limits\x1b[2J",
      status: "in_progress",
      description: "Choose one layout rule.",
      acceptance_criteria: "Preserve word boundaries.",
    },
  },
  canFocus: false,
  review: {
    finding:
      "Duplicated rule in `fit()` and `render()`.\x1b]52;c;private-data\x07",
  },
};

const related = {
  row: {
    depth: 1,
    branch: "└─ ",
    task: {
      id: "ui-2",
      title: "Wide 漢字",
      status: "in_progress",
      description: "Independent evidence for wide glyphs.",
    },
  },
  canFocus: true,
  review: { finding: undefined },
};

function drawer(
  items: readonly TaskDrawerItem[] = [selected, related],
  {
    detailOnly = false,
    height = 24,
    emptyAction,
    project = "studio",
  }: {
    detailOnly?: boolean;
    height?: number;
    emptyAction?: EmptyTaskAction | undefined;
    project?: string;
  } = {},
) {
  const calls: string[] = [];
  const component = createTaskDrawer({
    items,
    theme: plain,
    project,
    emptyAction,
    detailOnly,
    limitReached: false,
    height: () => height,
    onInspect(index) {
      calls.push(`inspect ${String(index)}`);
    },
    onFocus(index) {
      calls.push(`focus ${String(index)}`);
    },
    onCancel() {
      calls.push("cancel");
    },
    requestRender() {},
  });
  return { component, calls };
}

await test("the task drawer keeps one title and review state per task at either width", () => {
  const { component } = drawer();
  for (const width of [46, 72]) {
    const rows = component.render(width);
    assert(rows.length <= 24);
    assert(rows.every((line) => visibleWidth(line) <= width));
    const text = rows.join("\n");
    assert.equal(text.match(/Inline limits/gu)?.length, 1);
    assert.equal(text.match(/Changes requested/giu)?.length, 1);
    assert.match(text, /Reviewing/iu);
    assert.match(text, /Duplicated rule/u);
    assert.match(text, /fit\(\)/u);
    assert(!text.includes("\x1b"));
    assert(!text.includes("private-data"));
  }
});

await test("preview follows selection and pane focus stays with its owning task", () => {
  const { component, calls } = drawer();
  component.render(60);
  component.handleInput("\x1b[C");
  assert.deepEqual(calls, []);
  component.handleInput("j");
  const second = component.render(60).join("\n");
  assert.match(second, /Independent evidence/u);
  assert.doesNotMatch(second, /Duplicated rule/u);
  component.handleInput("\x1b[C");
  component.handleInput("\r");
  component.handleInput("\x1b[A");
  assert.match(component.render(60).join("\n"), /Duplicated rule/u);
  component.handleInput("\x1b");
  assert.deepEqual(calls, ["focus 1", "inspect 1", "cancel"]);
});

await test("a short detail view can scroll past a long title to the acceptance criteria", () => {
  const longTitle = {
    ...selected,
    row: {
      ...selected.row,
      task: {
        ...selected.row.task,
        title: "Longest possible title. ".repeat(16),
      },
    },
  };
  const { component, calls } = drawer([longTitle, related], {
    detailOnly: true,
    height: 7,
  });
  const before = component.render(38);
  assert.doesNotMatch(before.join("\n"), /Preserve word boundaries/u);
  const seen: string[] = [];
  for (let step = 0; step < 40; step++) {
    component.handleInput("j");
    const rows = component.render(38);
    assert(rows.length <= 7);
    assert(rows.every((line) => visibleWidth(line) <= 38));
    seen.push(...rows);
  }
  assert.match(seen.join("\n"), /Preserve word boundaries/u);
  for (let step = 0; step < 40; step++) component.handleInput("k");
  assert.deepEqual(component.render(38), before);
  component.handleInput("\x1b");
  assert.deepEqual(calls, ["cancel"]);
});

await test("an empty project keeps its source, shows the available next step, and dismisses without selecting a task", () => {
  for (const emptyAction of ["draft", "review", undefined] as const) {
    const { component, calls } = drawer([], {
      emptyAction,
      project: "my-project\x1b[2J",
    });
    for (const width of [46, 72]) {
      const rows = component.render(width);
      assert(rows.every((line) => visibleWidth(line) === width));
      const text = rows.join("\n");
      assert.match(text, /No tasks yet/u);
      assert.match(text, /my-project/u);
      assert.match(text, /Esc Close/u);
      if (emptyAction === "draft") {
        assert.match(text, /Draft a plan with \/plan-draft/u);
        assert.match(text, /<description>/u);
      } else if (emptyAction === "review") {
        assert.match(text, /Review your draft with \/plan\./u);
        assert.doesNotMatch(text, /plan-draft/u);
      } else {
        assert.match(text, /Tasks added in Beads will appear here/u);
        assert.doesNotMatch(text, /plan-draft/u);
      }
      assert.doesNotMatch(
        text,
        /Review finding|Acceptance criteria|Focus pane|▌/u,
      );
      assert(!text.includes("\x1b"));
    }
    for (const key of ["k", "j", "\x1b[C", "\r"]) component.handleInput(key);
    assert.deepEqual(calls, []);
    component.handleInput("\x1b");
    assert.deepEqual(calls, ["cancel"]);
  }
  assert.match(
    drawer([], { height: 1 }).component.render(30).join(""),
    /No tasks yet/u,
  );
});

await test("a title-only task is distinct from an empty project", () => {
  const task = { id: "ui-9", title: "Resize panes", status: "open" };
  const item = { row: { task, depth: 0 }, canFocus: false };
  for (const detailOnly of [false, true]) {
    const text = drawer([item], { detailOnly }).component.render(50).join("\n");
    assert.match(text, /Resize panes/u);
    assert.match(text, /ui-9/u);
    assert.match(text, /No details recorded\./u);
    assert.doesNotMatch(
      text,
      /No tasks yet|Review finding|Acceptance criteria/u,
    );
  }
});
