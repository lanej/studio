import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { initTheme, SettingsManager, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  getCellDimensions,
  ProcessTerminal,
  setCapabilities,
  setCellDimensions,
  TuiMainScreen,
} from "@earendil-works/pi-tui";

await test("inline screenshots fit their source and pane, with explicit magnification", async (t) => {
  const capabilities = getCapabilities();
  const cell = getCellDimensions();
  t.after(() => {
    setCapabilities(capabilities);
    setCellDimensions(cell);
  });
  initTheme("dark", false);
  setCellDimensions({ widthPx: 9, heightPx: 18 });
  const screenshot = await readFile(new URL("../docs/assets/tasks-100.png", import.meta.url), "base64");
  const settings = SettingsManager.inMemory();
  assert.equal(settings.getImageWidthCells(), "auto");
  const ui = new TuiMainScreen(new ProcessTerminal());
  for (const protocol of ["kitty", "iterm2"] as const) {
    setCapabilities({ ...capabilities, images: protocol });
    const preview = new ToolExecutionComponent(
      "read",
      "screenshot",
      { path: "tasks-100.png" },
      { imageWidthCells: settings.getImageWidthCells() },
      undefined,
      ui,
      process.cwd(),
    );
    preview.updateResult({
      content: [{ type: "image", data: screenshot, mimeType: "image/png" }],
      isError: false,
    });
    const columns = (width: number) => {
      const image = preview.render(width).join("\n");
      return Number(/(?:,c=|;width=)(\d+)/u.exec(image)?.[1]);
    };
    assert.equal(columns(162), 100, "900 source pixels at nine pixels per cell");
    assert.equal(columns(42), 40, "resize leaves the two terminal padding cells");
    setCellDimensions({ widthPx: 13, heightPx: 26 });
    preview.invalidate();
    assert.equal(columns(162), 69, "a font change chooses the nearest cell to 900 source pixels");
    setCellDimensions({ widthPx: 9, heightPx: 18 });
    preview.invalidate();
    preview.setExpanded(true);
    assert.equal(columns(162), 160, "expand to magnify beyond native size");
    preview.setExpanded(false);
    assert.equal(columns(162), 100);
    settings.setImageWidthCells(60);
    preview.setImageWidthCells(settings.getImageWidthCells());
    preview.setExpanded(true);
    assert.equal(columns(162), 60, "a chosen width survives expansion");
    settings.setImageWidthCells("auto");
    preview.setImageWidthCells(settings.getImageWidthCells());
    assert.equal(columns(162), 160);
    preview.setShowImages(false);
    assert.match(preview.render(162).join("\n"), /image\/png/u);
  }
});
