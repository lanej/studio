import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Input,
  ProcessTerminal,
  TuiMainScreen,
  stripTerminalSequences,
  type OverlayHandle,
} from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { paneKeybindingsSchema } from "../pane-keybindings-config.ts";
import { pickLeadPane } from "../floating-pane-picker.ts";

await test("the Studio picker accepts same-read mnemonics, limits allowed choices and restores the draft at its cursor", async () => {
  class TestTui extends TuiMainScreen {
    override requestRender(): void {}
  }
  const terminal = new ProcessTerminal();
  terminal.hideCursor = () => {};
  const tui = new TestTui(terminal);
  const lead = new Input();
  lead.handleInput("keep draft");
  tui.setFocus(lead);
  lead.handleInput("\x1b[D");
  initTheme("dark", false);
  const theme = getThemeByName("dark");
  assert.ok(theme !== undefined);
  type UI = ExtensionContext["ui"];
  let guard: Parameters<UI["onTerminalInput"]>[0] | undefined;
  const custom: UI["custom"] = (factory, options) =>
    new Promise((resolve, reject) => {
      assert.equal(options?.overlay, true);
      let handle: OverlayHandle | undefined;
      let closed = false;
      void Promise.resolve(
        factory(tui, theme, new KeybindingsManager(), (value) => {
          closed = true;
          handle?.hide();
          resolve(value);
        }),
      ).then((view) => {
        if (closed) return;
        handle = tui.showOverlay(view);
        options.onHandle?.(handle);
      }, reject);
    });
  const ctx = {
    ui: {
      custom,
      onTerminalInput: (handler: NonNullable<typeof guard>) => {
        guard = handler;
        return () => {
          guard = undefined;
        };
      },
    },
  };
  const send = (input: string) => {
    if (guard?.(input)?.consume !== true) tui.getFocusedComponent()?.handleInput?.(input);
  };

  for (const [key, expected] of [
    ["w", "workers"],
    ["t", "tasks"],
    ["s", "status"],
  ] as const) {
    const pick = pickLeadPane(ctx, ["workers", "tasks", "status"]);
    send("\x1b[32;5:3u"); // A release event must never choose a pane.
    send(key);
    assert.equal(await pick, expected);
    assert.equal(guard, undefined);
    assert.equal(tui.getFocusedComponent(), lead);
  }

  const pick = pickLeadPane(ctx, ["tasks", "status"]);
  await Promise.resolve();
  const picker = tui.getFocusedComponent();
  assert.ok(picker !== null && picker !== lead);
  assert.equal(guard, undefined);
  const rows = picker.render(28).map(stripTerminalSequences).join("\n");
  assert.match(rows, /Studio panes[\s\S]*t {2}Tasks[\s\S]*s {2}Toggle status/u);
  assert.doesNotMatch(rows, /Workers/u);
  send("w");
  send("\x1b[B");
  send("k");
  send("j");
  send("\r");
  assert.equal(await pick, "status");
  const cancel = pickLeadPane(ctx, ["tasks"]);
  await Promise.resolve();
  send("\x1b");
  assert.equal(await cancel, undefined);
  const bindings = paneKeybindingsSchema.parse({
    lead: { openPicker: "f7" },
    picker: { workers: "y", tasks: [], status: [] },
    pane: { down: "n", activate: "o", close: "x" },
  });
  const customPick = pickLeadPane(ctx, ["workers", "tasks"], bindings);
  await Promise.resolve();
  const remapped = tui.getFocusedComponent();
  assert.ok(remapped !== null && remapped !== lead);
  const labels = remapped.render(28).map(stripTerminalSequences).join("\n");
  assert.match(labels, /y {2}Workers/u);
  assert.match(labels, /x close/u);
  assert.doesNotMatch(labels, /w {2}Workers|t {2}Tasks|Esc close/u);
  for (const key of ["w", "t", "\x00", "\x1b", "\r", "\x1b[B"]) send(key);
  assert.equal(tui.getFocusedComponent(), remapped);
  send("n");
  send("o");
  assert.equal(await customPick, "tasks");
  const sameRead = pickLeadPane(ctx, ["workers", "tasks"], bindings);
  send("y");
  assert.equal(await sameRead, "workers");
  const repeat = pickLeadPane(ctx, ["tasks"], bindings);
  send("\x1b[18~");
  assert.equal(await repeat, undefined);
  assert.equal(tui.getFocusedComponent(), lead);
  send("!");
  assert.equal(lead.getValue(), "keep draf!t");
});
