import { Key } from "@earendil-works/pi-tui";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configSchema, exampleConfig, loadConfig } from "../config.ts";
import { paneKeybindingsSchema } from "../pane-keybindings-config.ts";
import {
  defaultPaneKeybindings,
  matchesPaneKey,
  paneKeyHint,
  paneKeyLabel,
  paneKeyPair,
} from "../pane-keybindings.ts";

await test("old configs and the CLI example leave all lead shortcuts available", () => {
  const defaults = configSchema.parse({}).keybindings;
  assert.deepEqual(defaults, defaultPaneKeybindings);
  assert.deepEqual(configSchema.parse(exampleConfig).keybindings, defaults);
  assert.deepEqual(defaults.lead, {
    openPicker: [],
    openWorkers: [],
    openTasks: [],
    toggleStatus: [],
  });
  assert.deepEqual(defaults.picker, {
    workers: ["w"],
    tasks: ["t"],
    status: ["s"],
  });
  assert.equal(matchesPaneKey("\x00", defaults.lead.openPicker), false);
});

await test("TOML and JSON resolve the same aliases, replacements, and disabled actions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-pane-keys-"));
  try {
    const toml = join(directory, "config.toml");
    const json = join(directory, "config.json");
    const bindings = {
      lead: { openWorkers: ["shift+Ctrl+f9", "ctrl+;"] },
      pane: { up: "i", close: ["esc", "ESC"] },
      picker: { tasks: [] },
    };
    await writeFile(json, JSON.stringify({ keybindings: bindings }));
    await writeFile(
      toml,
      [
        "[keybindings.lead]",
        'openWorkers = ["shift+Ctrl+f9", "ctrl+;"]',
        "[keybindings.pane]",
        'up = "i"',
        'close = ["esc", "ESC"]',
        "[keybindings.picker]",
        "tasks = []",
      ].join("\n"),
    );
    const a = (await loadConfig(toml)).keybindings;
    const b = (await loadConfig(json)).keybindings;
    assert.deepEqual(a, b);
    assert.deepEqual(a.lead.openWorkers, ["ctrl+shift+f9", "ctrl+;"]);
    assert.deepEqual(a.pane.close, ["escape"]);
    assert.deepEqual(a.picker.tasks, []);
    assert.deepEqual(a.pane.up, ["i"]);
    assert.deepEqual(a.pane.down, ["down", "j"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("Pi key identifiers cover modifiers, punctuation, aliases and function keys", () => {
  for (const key of Object.values(Key)) {
    if (typeof key !== "string") continue;
    // The status toggle is evaluated only in the lead draft.
    assert.equal(
      paneKeybindingsSchema.safeParse({ lead: { toggleStatus: key } }).success,
      true,
      key,
    );
  }
  const { lead } = paneKeybindingsSchema.parse({
    lead: {
      openWorkers: [
        "Alt+shift+Ctrl+super++",
        "+",
        "ctrl++",
        "return",
        "F12",
        "PageUP",
      ],
    },
  });
  assert.deepEqual(lead.openWorkers, [
    "ctrl+shift+alt+super++",
    "+",
    "ctrl++",
    "enter",
    "f12",
    "pageUp",
  ]);
  for (const value of [
    "",
    " ",
    "g g",
    "hyper+x",
    "ctrl+ctrl+p",
    "ctrl+escape",
    "shift+alt+esc",
    "ctrl+",
    "f13",
    '"',
    "ctrl+down+j",
  ]) {
    assert.equal(
      paneKeybindingsSchema.safeParse({ lead: { openWorkers: value } }).success,
      false,
      value,
    );
  }
});

await test("overlapping actions reject conflicts with other overrides and inherited defaults", () => {
  for (const bindings of [
    { lead: { openTasks: "ctrl+shift+f9", openWorkers: "shift+ctrl+f9" } },
    { lead: { openPicker: "w" } },
    { picker: { tasks: "up" } },
    { pane: { up: "right" } },
    { tasks: { refresh: "q" } },
    { decision: { pageUp: "pagedown" } },
  ]) {
    assert.throws(
      () => paneKeybindingsSchema.parse(bindings),
      /conflicts with/u,
    );
  }
  const bindings = paneKeybindingsSchema.parse({
    lead: { openTasks: "q", openPicker: "escape" },
    picker: { tasks: "r" },
    tasks: { quit: "escape" },
  });
  assert.deepEqual(bindings.picker.tasks, bindings.tasks.refresh);
  assert.deepEqual(bindings.lead.openPicker, bindings.tasks.quit);
  assert.throws(
    () => paneKeybindingsSchema.parse({ picker: { workerz: "x" } }),
    /workerz/u,
  );
  for (const pageUp of ["j", "shift+x", "space"]) {
    assert.throws(
      () => paneKeybindingsSchema.parse({ decision: { pageUp } }),
      /non-printing/u,
    );
  }
});

await test("matching delegates terminal decoding to Pi and hints track configured keys", () => {
  const { pane, lead } = paneKeybindingsSchema.parse({
    pane: { close: ["ctrl+;", "escape"] },
    lead: { openTasks: "ctrl+space" },
  });
  assert.equal(matchesPaneKey("\x1b[59;5u", pane.close), true);
  assert.equal(matchesPaneKey("\x1b", pane.close), true);
  assert.equal(matchesPaneKey("\x03", pane.close), false);
  assert.equal(matchesPaneKey("\x1b[32;5u", lead.openTasks), true);
  assert.equal(paneKeyLabel(["ctrl++"]), "Ctrl++");
  assert.equal(paneKeyLabel(["ctrl+shift+f9"]), "Ctrl+Shift+F9");
  assert.equal(paneKeyHint(pane.close, "close"), "Ctrl+; close");
  assert.equal(paneKeyHint([], "close"), "");
  assert.equal(paneKeyPair(pane.up, pane.down), "↑↓");
  assert.equal(paneKeyPair([], ["j"]), "j");
});
