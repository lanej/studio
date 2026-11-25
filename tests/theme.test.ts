import assert from "node:assert/strict";
import { test } from "node:test";
import {
  colorToRgb,
  foregroundAnsi,
  indexedColor,
  parseColor,
  type TerminalColorMode,
} from "@earendil-works/pi-tui";
import palette from "../resources/colors.json" with { type: "json" };
import theme from "../resources/theme.json" with { type: "json" };
import { planGraphColor } from "../plan-graph.ts";

function renderedColor(hex: string, mode: TerminalColorMode) {
  const color = parseColor(hex);
  if (mode === "truecolor") return colorToRgb(color);
  // Use the exact xterm index selected by the installed TUI.
  const ansi = foregroundAnsi(color, mode);
  const index = /;5;(\d+)m$/u.exec(ansi)?.[1];
  assert.ok(index !== undefined, ansi);
  return colorToRgb(indexedColor(Number(index)));
}

function luminance({ r, g, b }: ReturnType<typeof colorToRgb>): number {
  function linear(channel: number): number {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

await test("Studio foregrounds remain readable on neutral terminal surfaces", () => {
  const colors = Object.entries(theme.colors);
  const backgrounds = colors.filter(([token]) => token.endsWith("Bg"));
  const foregrounds = colors.filter(([token]) => !token.endsWith("Bg"));
  const decorativeTokens = new Set([
    "border",
    "borderMuted",
    "mdHr",
    "mdQuoteBorder",
    "thinkingOff",
  ]);
  for (const mode of ["truecolor", "256color"] as const) {
    for (const [surface, hex] of [
      ...backgrounds,
      ...Object.entries(theme.export),
    ]) {
      const background = renderedColor(hex, mode);
      assert.equal(background.r, background.g, surface);
      assert.equal(background.g, background.b, surface);
      for (const [token, color] of foregrounds) {
        const foreground = renderedColor(color, mode);
        const contrast =
          (luminance(foreground) + 0.05) / (luminance(background) + 0.05);
        assert.ok(
          contrast >= (decorativeTokens.has(token) ? 3 : 4.5),
          `${mode} ${token} on ${surface} has ${contrast.toFixed(2)}:1 contrast`,
        );
      }
    }
    const tokenColors = new Map(colors);
    const lane = planGraphColor({
      fg: (token) => {
        const color = tokenColors.get(token);
        assert.ok(color !== undefined, token);
        return color;
      },
    });
    const lanes = Array.from({ length: 5 }, (_, index) =>
      foregroundAnsi(parseColor(lane(index, "│")), mode),
    );
    assert.equal(
      new Set(lanes).size,
      lanes.length,
      `Distinct graph lanes in ${mode}`,
    );
  }
});

await test("native terminal captures use the installed Studio palette", () => {
  const { roles } = palette;
  const pairs = {
    surface: theme.export.pageBg,
    "surface.raised": theme.colors.userMessageBg,
    "selection.bg": theme.colors.selectedBg,
    text: theme.colors.text,
    "text.muted": theme.colors.muted,
    accent: theme.colors.accent,
    "status.success": theme.colors.success,
    "status.warning": theme.colors.warning,
    "status.error": theme.colors.error,
    link: theme.colors.mdLink,
  };
  const captureColors = new Map(Object.entries(roles));
  for (const [role, hex] of Object.entries(pairs))
    assert.equal(captureColors.get(role), hex, role);
});
