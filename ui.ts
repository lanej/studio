import type {
  ExtensionContext,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
  floatingPaneHeight,
  floatingPaneOptions,
  paintPaneLine,
  paneMouse,
} from "./floating-pane.ts";
import { knownTaskStatus, TaskStatus } from "./beads.ts";
import { NavigationKey } from "./runtime.ts";

const statusTones = {
  [TaskStatus.Open]: { glyph: "○", tone: "muted" },
  [TaskStatus.InProgress]: { glyph: "◐", tone: "accent" },
  [TaskStatus.Blocked]: { glyph: "×", tone: "error" },
  [TaskStatus.Deferred]: { glyph: "–", tone: "warning" },
  [TaskStatus.Closed]: { glyph: "●", tone: "success" },
} satisfies Record<TaskStatus, { glyph: string; tone: ThemeColor }>;

export function taskStatusGlyph(
  status: string,
  theme: Pick<Theme, "fg">,
): string {
  const recognized = knownTaskStatus(status);
  const { glyph, tone } =
    recognized === undefined
      ? { glyph: "?", tone: "muted" as const }
      : statusTones[recognized];
  return theme.fg(tone, glyph);
}

export async function showTask(
  ctx: ExtensionContext,
  details: string,
  layout: "inline" | "floating" = "inline",
): Promise<void> {
  const floating = layout === "floating";
  await ctx.ui.custom<undefined>(
    (tui, theme, _keys, done) => {
      const text = new Text(theme.fg("text", details), 0, 0);
      let offset = 0;
      let maximum = 0;
      return {
        invalidate() {
          text.invalidate();
        },
        render(width) {
          const inner = floating ? Math.max(1, width - 2) : width;
          const lines = text.render(inner);
          const height = floating
            ? floatingPaneHeight(tui.terminal.rows)
            : Math.max(3, tui.terminal.rows - 5);
          maximum = Math.max(0, lines.length - height);
          offset = Math.min(offset, maximum);
          const visible = lines.slice(offset, offset + height);
          return floating
            ? visible.map((line) =>
                paintPaneLine(
                  theme,
                  "userMessageBg",
                  truncateToWidth(` ${line}`, width, "", true),
                ),
              )
            : visible;
        },
        handleMouse(event) {
          if (!floating) return undefined;
          return paneMouse(event, (delta) => {
            offset = Math.max(0, Math.min(maximum, offset + delta));
          });
        },
        handleInput(input) {
          if (
            matchesKey(input, NavigationKey.Escape) ||
            matchesKey(input, NavigationKey.Enter) ||
            matchesKey(input, NavigationKey.Cancel)
          )
            done(undefined);
          else if (
            matchesKey(input, NavigationKey.Down) ||
            matchesKey(input, NavigationKey.VimDown)
          )
            offset = Math.min(maximum, offset + 1);
          else if (
            matchesKey(input, NavigationKey.Up) ||
            matchesKey(input, NavigationKey.VimUp)
          )
            offset = Math.max(0, offset - 1);
          tui.requestRender();
        },
      };
    },
    floating
      ? { overlay: true, overlayOptions: floatingPaneOptions }
      : undefined,
  );
}

// Wave details use the existing themed terminal surface. The action stays
// reachable at narrow widths after scrolling through the exact approval text.
export async function reviewPlan(
  ctx: ExtensionContext,
  heading: string,
  details: string,
  action: string,
): Promise<boolean> {
  return ctx.ui.custom<boolean>((tui, theme, _keys, done) => {
    const text = new Text(details.replace(/[^\P{Cc}\n\t]/gu, " "), 0, 0);
    let offset = 0;
    let maximum = 0;
    return {
      invalidate() {
        text.invalidate();
      },
      render(width) {
        const lines = text.render(width);
        const height = Math.max(3, tui.terminal.rows - 7);
        maximum = Math.max(0, lines.length - height);
        offset = Math.min(offset, maximum);
        return [
          truncateToWidth(theme.fg("accent", heading), width),
          ...lines.slice(offset, offset + height),
          truncateToWidth(
            theme.fg(
              "dim",
              offset < maximum
                ? "↓ More · Esc cancel"
                : `Enter ${action} · Esc cancel`,
            ),
            width,
          ),
        ];
      },
      handleInput(input) {
        if (
          matchesKey(input, NavigationKey.Escape) ||
          matchesKey(input, NavigationKey.Cancel)
        )
          done(false);
        else if (matchesKey(input, NavigationKey.Enter)) {
          if (offset === maximum) done(true);
          else
            offset = Math.min(
              maximum,
              offset + Math.max(1, tui.terminal.rows - 8),
            );
        } else if (
          matchesKey(input, NavigationKey.Down) ||
          matchesKey(input, NavigationKey.VimDown)
        ) {
          offset = Math.min(maximum, offset + 1);
        } else if (
          matchesKey(input, NavigationKey.Up) ||
          matchesKey(input, NavigationKey.VimUp)
        ) {
          offset = Math.max(0, offset - 1);
        }
        tui.requestRender();
      },
    };
  });
}
