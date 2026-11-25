import assert from "node:assert/strict";
import { test } from "node:test";
import {
  initTheme,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  ProcessTerminal,
  TuiAltScreen,
  Text,
  stripTerminalSequences,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { reviewPlan, showTask } from "../ui.ts";

function view(columns: number, rows: number) {
  const dimensions = { columns, rows };
  const terminal = new ProcessTerminal();
  Object.defineProperties(terminal, {
    columns: { get: () => dimensions.columns },
    rows: { get: () => dimensions.rows },
  });
  const tui = new TuiAltScreen(terminal);
  // A retained dock must not consume any of the modal's advertised review rows.
  tui.addChild(
    new Text(Array.from({ length: 8 }, () => "Retained dock").join("\n"), 0, 0),
  );
  let component: Component | undefined;
  let result: unknown;
  const ui: Pick<ExtensionUIContext, "custom"> = {
    custom(factory, options) {
      assert.equal(options?.overlay, true);
      assert.deepEqual(options.overlayOptions, {
        width: "100%",
        maxHeight: "100%",
        margin: 1,
      });
      return new Promise((resolve, reject) => {
        const created = factory(
          tui,
          theme,
          new KeybindingsManager(),
          (value) => {
            result = value;
            resolve(value);
          },
        );
        void Promise.resolve(created).then((value) => {
          component = value;
        }, reject);
      });
    },
  };
  return {
    ctx: { ui },
    dimensions,
    result: () => result,
    render: () => {
      assert.ok(component !== undefined);
      const lines = component
        .render(dimensions.columns - 2)
        .map(stripTerminalSequences);
      assert.ok(lines.length <= Math.max(1, dimensions.rows - 2));
      assert.ok(
        lines.every((line) => visibleWidth(line) <= dimensions.columns - 2),
      );
      return lines.map((line) => line.trimEnd());
    },
    input: (key: string) => {
      assert.ok(component !== undefined);
      component.handleInput?.(key);
    },
  };
}

await test("bounded approval modal keeps its action visible and pages every row before Enter approves", async () => {
  initTheme("dark", false);
  const details = Array.from(
    { length: 70 },
    (_, index) => `Review item ${String(index).padStart(2, "0")}`,
  );
  for (const [columns, rows] of [
    [80, 32],
    [28, 12],
    [28, 5],
  ] as const) {
    const current = view(columns, rows);
    const outcome = reviewPlan(
      current.ctx,
      "Review specification",
      details.join("\n"),
      "freeze spec",
    );
    await Promise.resolve();
    current.input("\r");
    assert.equal(
      current.result(),
      undefined,
      "Enter before the first render cannot approve",
    );
    const seen = new Set<string>();
    for (let count = 0; count < 100; count++) {
      const lines = current.render();
      for (const line of lines)
        if (line.startsWith("Review item")) seen.add(line);
      const footer = lines.at(-1) ?? "";
      assert.match(footer, /(?:More|Enter freeze spec).*Esc/u);
      assert.equal(current.result(), undefined);
      current.input("\r");
      if (current.result() === true) break;
      for (let buffered = 0; buffered < 5; buffered++) current.input("j");
      current.input("\r");
      assert.equal(
        current.result(),
        undefined,
        "Buffered Enter cannot approve an unseen final page",
      );
    }
    assert.deepEqual([...seen], details);
    assert.equal(await outcome, true);
  }
});

await test("narrow-to-wide resizing restarts wrapped review without skipping text", async () => {
  initTheme("dark", false);
  const current = view(24, 10);
  const details = Array.from(
    { length: 70 },
    (_, index) =>
      `Review item ${String(index).padStart(2, "0")} with additional wrapped review detail`,
  );
  const outcome = reviewPlan(
    current.ctx,
    "Review",
    details.join("\n"),
    "approve",
  );
  await Promise.resolve();
  const seen = new Set<string>();
  const observe = () => {
    const lines = current.render();
    for (const line of lines) {
      const match = /^Review item (\d+)/u.exec(line);
      if (match?.[1] !== undefined) seen.add(match[1]);
    }
    return lines;
  };
  for (let page = 0; page < 3; page++) {
    observe();
    current.input("\r");
  }
  observe();
  current.dimensions.columns = 80;
  assert.match(observe()[1] ?? "", /^Review item 00/u);
  for (let page = 0; page < 100; page++) {
    observe();
    current.input("\r");
    if (current.result() === true) break;
  }
  assert.deepEqual(
    [...seen],
    Array.from({ length: 70 }, (_, index) => String(index).padStart(2, "0")),
  );
  assert.equal(await outcome, true);
});

await test("review resize and cancellation preserve authority, and task details use the same bounded surface", async () => {
  initTheme("dark", false);
  const current = view(40, 12);
  const outcome = reviewPlan(
    current.ctx,
    "Review",
    "First\nSecond\nThird",
    "approve",
  );
  await Promise.resolve();
  current.render();
  current.dimensions.rows = 4;
  assert.match(current.render().join("\n"), /Enlarge terminal/u);
  current.input("\r");
  assert.equal(current.result(), undefined);
  current.input("\x1b");
  assert.equal(await outcome, false);
  const details = view(28, 8);
  const closed = showTask(
    details.ctx,
    Array.from({ length: 30 }, (_, index) => `Detail ${String(index)}`).join(
      "\n",
    ),
  );
  await Promise.resolve();
  assert.equal(details.render()[0], "Detail 0");
  details.input("j");
  assert.equal(details.render()[0], "Detail 1");
  details.input("k");
  assert.equal(details.render()[0], "Detail 0");
  details.input("\x1b");
  await closed;
});
