import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  ProcessTerminal,
  setKeybindings,
  TuiMainScreen,
  type EditorTheme,
} from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { HistoryBindings } from "../keybindings.ts";

const identity = (text: string) => text;
const theme: EditorTheme = {
  borderColor: identity,
  selectList: {
    selectedPrefix: identity,
    selectedText: identity,
    description: identity,
    scrollInfo: identity,
    noMatch: identity,
  },
};

await test("Pi's actual CustomEditor uses native history actions before model cycling", () => {
  const original = getKeybindings();
  const manager = new KeybindingsManager();
  setKeybindings(manager);
  try {
    const editor = new CustomEditor(new TuiMainScreen(new ProcessTerminal()), theme, manager);
    editor.addToHistory("older prompt");
    editor.addToHistory("newer prompt");
    let cycles = 0;
    let pickers = 0;
    editor.onAction("app.model.cycleForward", () => {
      cycles++;
    });
    editor.onAction("app.model.select", () => {
      pickers++;
    });
    editor.handleInput("\x10");
    assert.equal(cycles, 1, "unmodified Pi defaults really do cycle models");
    assert.equal(editor.getText(), "");
    const layer = new HistoryBindings(manager);
    layer.apply();
    editor.handleInput("\x10");
    assert.equal(editor.getText(), "newer prompt");
    editor.handleInput("\x10");
    assert.equal(editor.getText(), "older prompt");
    editor.handleInput("\x0e");
    assert.equal(editor.getText(), "newer prompt");
    editor.handleInput("\x0e");
    assert.equal(editor.getText(), "");
    assert.equal(cycles, 1, "history adds zero model cycles");
    editor.handleInput("\x0c");
    assert.equal(pickers, 1, "the existing model-picker action remains bound");
    for (let i = 0; i < 20; i++) layer.apply();
    assert.deepEqual(manager.getKeys("tui.editor.historyPrevious"), ["ctrl+p"]);
    assert.deepEqual(manager.getKeys("tui.editor.historyNext"), ["ctrl+n"]);
    assert.deepEqual(manager.getUserBindings(), {
      "tui.editor.historyPrevious": "ctrl+p",
      "tui.editor.historyNext": "ctrl+n",
    });
  } finally {
    setKeybindings(original);
  }
});

await test("authored reloads, empty actions and explicit conflicting claims remain authoritative", () => {
  const directory = mkdtempSync(join(tmpdir(), "studio-history-bindings-"));
  try {
    const path = join(directory, "keybindings.json");
    const manager = KeybindingsManager.create(directory);
    const layer = new HistoryBindings(manager);
    layer.apply();
    const authored = {
      "tui.editor.historyPrevious": ["ctrl+p"],
      "tui.editor.historyNext": [],
      "app.model.cycleForward": ["ctrl+p"],
      "app.tools.expand": "alt+o",
    };
    writeFileSync(path, JSON.stringify(authored));
    manager.reload();
    const source = manager.getUserBindings();
    const copy = manager.getUserBindings();
    assert.notEqual(source, copy, "Pi returns a new top-level configuration object");
    assert.equal(
      source["tui.editor.historyPrevious"],
      copy["tui.editor.historyPrevious"],
      "Pi retains nested binding arrays; the layer must not mutate them",
    );
    layer.apply();
    assert.equal(manager.getUserBindings()["tui.editor.historyPrevious"], source["tui.editor.historyPrevious"]);
    assert.deepEqual(manager.getUserBindings(), authored);
    layer.apply();
    assert.deepEqual(
      manager.getUserBindings(),
      authored,
      "reapplication preserves an authored binding equal to the Studio default",
    );

    const conflicting = {
      "app.model.cycleForward": "ctrl+p",
      "app.tools.expand": "ctrl+n",
    };
    writeFileSync(path, JSON.stringify(conflicting));
    manager.reload();
    layer.apply();
    assert.deepEqual(manager.getUserBindings(), conflicting);
    assert.deepEqual(manager.getKeys("tui.editor.historyPrevious"), []);
    assert.deepEqual(manager.getKeys("tui.editor.historyNext"), []);
    layer.apply();
    assert.deepEqual(manager.getUserBindings(), conflicting);
    assert.equal(readFileSync(path, "utf8"), JSON.stringify(conflicting));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
