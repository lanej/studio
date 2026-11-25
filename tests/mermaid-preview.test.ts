import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  Image,
  needsZellijImageProbe,
  resetCapabilitiesCache,
  ScrollView,
  setCapabilities,
  setCapabilityOverrides,
  setZellijKittySupport,
  TuiAltScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { queryPaneGraphics } from "../diagram/mermaid-preview.ts";

function terminal(timeout: number) {
  let listener:
    | Parameters<ExtensionUIContext["onTerminalInput"]>[0]
    | undefined;
  let request = "";
  const probe = queryPaneGraphics(
    (handler) => {
      listener = handler;
      return () => {
        listener = undefined;
      };
    },
    (payload) => {
      request = payload;
    },
    timeout,
  );
  const id = /,i=(\d+),/u.exec(request)?.[1];
  assert.ok(id !== undefined);
  return {
    ...probe,
    id,
    request,
    input: (text: string) => listener?.(text),
    reply: (text: string) => listener?.(`\x1b_Gi=${id};${text}\x1b\\`),
  };
}

await test("the Zellij query consumes only its own reply, including late replies", async () => {
  const enabled = terminal(500);
  assert.equal(
    enabled.request,
    `\x1b_Ga=q,i=${enabled.id},s=1,v=1,t=d,f=24;AAAA\x1b\\`,
  );
  assert.equal(enabled.input("j"), undefined);
  assert.equal(enabled.input("\x1b_Gi=other;OK\x1b\\"), undefined);
  assert.deepEqual(enabled.reply("OK"), { consume: true });
  assert.equal(await enabled.supported, true);
  assert.equal(enabled.reply("OK"), undefined);
  const disabled = terminal(500);
  assert.deepEqual(disabled.reply("ENOTSUPPORTED: no graphics"), {
    consume: true,
  });
  assert.equal(await disabled.supported, false);
  const silent = terminal(5);
  assert.equal(await silent.supported, false);
  assert.deepEqual(silent.reply("OK"), { consume: true });
  assert.equal(await silent.supported, false);
  const closed = terminal(500);
  closed.dispose();
  assert.equal(await closed.supported, false);
  assert.equal(closed.reply("OK"), undefined);
});

await test("a split fullscreen viewport paints a cropped Kitty image and its sidebar on the same row", async (t) => {
  const saved = getCapabilities();
  t.after(() => {
    setCapabilities(saved);
  });
  setCapabilities({ ...saved, images: "kitty" });
  const data = await readFile(
    new URL("../docs/assets/diagram-containers.png", import.meta.url),
    "base64",
  );
  const image = new Image(data, "image/png", { fallbackColor: (s) => s });
  let output = "";
  const noop = () => undefined;
  const ui = new TuiAltScreen({
    columns: 60,
    rows: 4,
    kittyProtocolActive: false,
    write: (value) => {
      output += value;
    },
    start: noop,
    stop: noop,
    drainInput: () => Promise.resolve(),
    moveBy: noop,
    hideCursor: noop,
    showCursor: noop,
    clearLine: noop,
    clearFromCursor: noop,
    clearScreen: noop,
    setTitle: noop,
    setProgress: noop,
    setProgramStatus: noop,
  });
  const scroll = new ScrollView(image, { follow: "none", scrollbar: "hidden" });
  ui.setLayoutRoot(scroll);
  ui.setRightColumn({ render: () => ["Socrates"], invalidate: noop }, () => 12);
  ui.start();
  t.after(() => {
    ui.stop();
  });
  ui.renderNow();
  const verifySidebar = () => {
    const row = ui.getScreenLines()[0] ?? "";
    const sidebarStart = row.indexOf("Socrates");
    assert.ok(sidebarStart >= 0);
    assert.equal(visibleWidth(row.slice(0, sidebarStart)), 48);
    const sidebarWrite = output.indexOf("Socrates");
    assert.ok(
      sidebarWrite >= 0 && sidebarWrite < output.lastIndexOf("\x1b_Ga="),
    );
  };
  verifySidebar();
  assert.ok(output.includes(data.slice(0, 4096)));
  assert.ok(output.includes(data.slice(-128)));
  assert.match(output, /a=T,[^;]*y=0,h=\d+,r=4/u);
  output = "";
  scroll.scrollBy(2);
  ui.renderNow();
  verifySidebar();
  assert.match(output, /a=p,[\w,=]+y=[1-9]\d*,h=\d+,r=4/u);
  assert.ok(!output.includes(data.slice(0, 4096)));
});

await test("Zellij auto-detection precedes leaked host hints and preserves explicit settings", (t) => {
  const env = process.env;
  const keys = [
    "TERM",
    "TERM_PROGRAM",
    "PI_IMAGE_PROTOCOL",
    "KITTY_WINDOW_ID",
    "TMUX",
    "ZELLIJ",
    "ZELLIJ_PANE_ID",
    "PI_HYPERLINKS",
  ];
  const saved = keys.map((key) => [key, env[key]] as const);
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(env, key);
      else env[key] = value;
    }
    setCapabilityOverrides({});
    setZellijKittySupport(false);
    resetCapabilitiesCache();
  });
  for (const key of keys) Reflect.deleteProperty(env, key);
  env["TERM"] = "xterm-256color";
  env["KITTY_WINDOW_ID"] = "17";
  env["PI_HYPERLINKS"] = "1";
  const images = () => {
    resetCapabilitiesCache();
    return getCapabilities().images;
  };
  setZellijKittySupport(false);
  assert.equal(needsZellijImageProbe(), false);
  assert.equal(images(), "kitty");
  env["ZELLIJ_PANE_ID"] = "0";
  assert.equal(needsZellijImageProbe(), true);
  assert.equal(images(), null);
  setZellijKittySupport(true);
  assert.equal(images(), "kitty");

  for (const [configured, expected] of [
    ["none", null],
    ["kitty", "kitty"],
    ["iterm2", "iterm2"],
  ] as const) {
    env["PI_IMAGE_PROTOCOL"] = configured;
    assert.equal(needsZellijImageProbe(), false);
    assert.equal(images(), expected);
  }
  delete env["PI_IMAGE_PROTOCOL"];
  for (const protocol of [null, "kitty", "iterm2"] as const) {
    setCapabilityOverrides({ images: protocol });
    assert.equal(needsZellijImageProbe(), false);
    assert.equal(images(), protocol);
  }
  setCapabilityOverrides({});
  env["TMUX"] = "outer";
  assert.equal(needsZellijImageProbe(), false);
  assert.equal(images(), null);
  delete env["TMUX"];
  env["TERM"] = "screen-256color";
  assert.equal(needsZellijImageProbe(), false);
  assert.equal(images(), null);
});
