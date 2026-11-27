import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backgroundAnsi,
  colorToOklch,
  colorToRgb,
  foregroundAnsi,
  indexedColor,
  parseColor,
  visibleWidth,
  type TerminalColorMode,
} from "@earendil-works/pi-tui";
import palette from "../resources/colors.json" with { type: "json" };
import sage from "../resources/sage-midnight.json" with { type: "json" };
import sageSymbols from "../resources/sage-statusline.json" with { type: "json" };
import theme from "../resources/theme.json" with { type: "json" };
import { planGraphColor } from "../plan-graph.ts";

function renderedColor(hex: string, mode: TerminalColorMode, background = false) {
  const color = parseColor(hex);
  const ansi = background ? backgroundAnsi(color, mode) : foregroundAnsi(color, mode);
  if (mode === "truecolor") {
    const rgb = colorToRgb(color);
    assert.equal(ansi, `\x1b[${background ? "48" : "38"};2;${String(rgb.r)};${String(rgb.g)};${String(rgb.b)}m`);
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
  const decorativeTokens = new Set(["border", "borderMuted", "mdHr", "mdQuoteBorder", "thinkingOff"]);
  assert.equal(palette.theme, "nord");
  assert.equal(theme.colors.userMessageBg, "#3B4252");
  assert.equal(theme.colors.selectedBg, "#434C5E");
  for (const mode of ["truecolor", "256color"] as const) {
    const surfaces: string[] = [theme.export.pageBg, theme.colors.userMessageBg, theme.colors.selectedBg].map((hex) =>
      backgroundAnsi(parseColor(hex), mode),
    );
    assert.equal(new Set(surfaces).size, surfaces.length, `Distinct Polar Night surfaces in ${mode}`);
    for (const [surface, hex] of [...backgrounds, ...Object.entries(theme.export)]) {
      const background = renderedColor(hex, mode, true);
      for (const [token, color] of foregrounds) {
        const foreground = renderedColor(color, mode);
        if (!decorativeTokens.has(token)) {
          const { c, h } = colorToOklch({ kind: "rgb", ...foreground });
          // Allow the slight cool cast of Snow Storm. Reserve blue and teal hues for strokes.
          assert.ok(c < 0.035 || h < 165 || h > 280, `${mode} renders ${token} as blue text`);
        }
        const contrast = (luminance(foreground) + 0.05) / (luminance(background) + 0.05);
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
    const lanes = Array.from({ length: 5 }, (_, index) => foregroundAnsi(parseColor(lane(index, "│")), mode));
    assert.equal(new Set(lanes).size, lanes.length, `Distinct graph lanes in ${mode}`);
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
    heading: theme.colors.mdHeading,
    link: theme.colors.mdLink,
    "syntax.function": theme.colors.syntaxFunction,
  };
  const captureColors = new Map(Object.entries(roles));
  for (const [role, hex] of Object.entries(pairs)) assert.equal(captureColors.get(role), hex, role);
  assert.equal(palette.components.heading.fg, theme.colors.mdHeading);
  assert.equal(palette.components.code.fg, theme.colors.mdCode);
});

await test("Markdown and code retain their color hierarchy at both terminal depths", () => {
  const { text, accent, mdHeading, mdLink, mdCode, syntaxFunction, syntaxKeyword, syntaxVariable } = theme.colors;
  for (const mode of ["truecolor", "256color"] as const) {
    const fg = (hex: string) => foregroundAnsi(parseColor(hex), mode);
    const markdown = [text, mdHeading, mdLink, mdCode].map(fg);
    const code = [syntaxVariable, syntaxFunction, syntaxKeyword].map(fg);
    assert.equal(new Set(markdown).size, markdown.length, mode);
    assert.equal(new Set(code).size, code.length, mode);
    assert.notEqual(fg(accent), fg(text), mode);
  }
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
    const foregrounds = colors.map((hex) => foregroundAnsi(parseColor(hex), mode));
    assert.equal(new Set(foregrounds).size, colors.length, mode);
  }
});

await test("Sage footer and model status stay distinct and readable in both terminal color modes", () => {
  const surfaces = [
    sage.colors.userMessageBg,
    sage.vars.footerBg,
    sage.vars.footerDirectoryBg,
    sage.vars.footerModelBg,
  ];
  for (const mode of ["truecolor", "256color"] as const) {
    const backgrounds = surfaces.map((hex) => backgroundAnsi(parseColor(hex), mode));
    assert.equal(new Set(backgrounds).size, surfaces.length, mode);
    const { text, accent, muted, success, error, warning } = sage.colors;
    const cases = [
      { surface: sage.vars.footerDirectoryBg, foregrounds: [text] },
      { surface: sage.vars.footerBg, foregrounds: [text, accent, muted, success, error, warning] },
      { surface: sage.vars.footerModelBg, foregrounds: [accent, muted] },
    ];
    for (const { surface, foregrounds } of cases) {
      const background = renderedColor(surface, mode, true);
      for (const hex of foregrounds) {
        const foreground = renderedColor(hex, mode);
        const contrast = (luminance(foreground) + 0.05) / (luminance(background) + 0.05);
        assert.ok(contrast >= 4.5, `${mode} ${hex} on ${surface} has ${contrast.toFixed(2)}:1 contrast`);
      }
    }
  }
});

await test("Studio status line symbols occupy one terminal cell", () => {
  for (const [name, glyph] of Object.entries(sageSymbols)) assert.equal(visibleWidth(glyph), 1, name);
  const marks = [
    sageSymbols.branch,
    sageSymbols.changedFiles,
    sageSymbols.addedLines,
    sageSymbols.removedLines,
    sageSymbols.untrackedFiles,
    sageSymbols.pullRequest,
  ];
  assert.equal(new Set(marks).size, marks.length);
});
