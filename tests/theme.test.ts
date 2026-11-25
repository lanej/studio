import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backgroundAnsi,
  colorToOklch,
  colorToRgb,
  foregroundAnsi,
  indexedColor,
  parseColor,
  type TerminalColorMode,
} from "@earendil-works/pi-tui";
import palette from "../resources/colors.json" with { type: "json" };
import theme from "../resources/theme.json" with { type: "json" };
import { planGraphColor } from "../plan-graph.ts";

function renderedColor(
  hex: string,
  mode: TerminalColorMode,
  background = false,
) {
  const color = parseColor(hex);
  const ansi = background
    ? backgroundAnsi(color, mode)
    : foregroundAnsi(color, mode);
  if (mode === "truecolor") {
    const rgb = colorToRgb(color);
    assert.equal(
      ansi,
      `\x1b[${background ? "48" : "38"};2;${String(rgb.r)};${String(rgb.g)};${String(rgb.b)}m`,
    );
    return rgb;
  }
  // Use the exact xterm index selected by the installed TUI.
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

await test("Nord text stays readable on every surface in truecolor and 256-color mode", () => {
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
  assert.equal(palette.theme, "nord");
  assert.equal(theme.colors.userMessageBg, "#3B4252");
  assert.equal(theme.colors.selectedBg, "#434C5E");
  for (const mode of ["truecolor", "256color"] as const) {
    const surfaces: string[] = [
      theme.export.pageBg,
      theme.colors.userMessageBg,
      theme.colors.selectedBg,
    ].map((hex) => backgroundAnsi(parseColor(hex), mode));
    assert.equal(
      new Set(surfaces).size,
      surfaces.length,
      `Distinct Polar Night surfaces in ${mode}`,
    );
    for (const [surface, hex] of [
      ...backgrounds,
      ...Object.entries(theme.export),
    ]) {
      const background = renderedColor(hex, mode, true);
      for (const [token, color] of foregrounds) {
        const foreground = renderedColor(color, mode);
        if (!decorativeTokens.has(token)) {
          const { c, h } = colorToOklch({ kind: "rgb", ...foreground });
          // Allow the slight cool cast of Snow Storm. Reserve blue and teal hues for strokes.
          assert.ok(
            c < 0.035 || h < 165 || h > 280,
            `${mode} renders ${token} as blue text`,
          );
        }
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
    focus: theme.colors.thinkingHigh,
    link: theme.colors.mdLink,
  };
  const captureColors = new Map(Object.entries(roles));
  for (const [role, hex] of Object.entries(pairs))
    assert.equal(captureColors.get(role), hex, role);
});

await test("the five Socrates state colors remain distinct in truecolor and 256-color terminals", () => {
  const colors = [
    theme.colors.error,
    theme.colors.warning,
    theme.colors.success,
    theme.colors.thinkingHigh,
    theme.colors.muted,
  ];
  for (const mode of ["truecolor", "256color"] as const) {
    const foregrounds = colors.map((hex) =>
      foregroundAnsi(parseColor(hex), mode),
    );
    assert.equal(new Set(foregrounds).size, colors.length, mode);
  }
});
