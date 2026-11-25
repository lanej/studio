import type {
  ExtensionContext,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { selectorText } from "@lanej/pi-components";
import { knownTaskStatus, TaskStatus } from "./beads.ts";
import { NavigationKey } from "./runtime.ts";
import { renderPlanReview, type PlanReview } from "./plan-review.ts";

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
): Promise<void> {
  await ctx.ui.custom<undefined>((tui, theme, _keys, done) => {
    const text = new Text(theme.fg("text", details), 0, 0);
    let offset = 0;
    let maximum = 0;
    return {
      invalidate() {
        text.invalidate();
      },
      render(width) {
        const lines = text.render(width);
        const height = Math.max(3, tui.terminal.rows - 5);
        maximum = Math.max(0, lines.length - height);
        offset = Math.min(offset, maximum);
        return lines.slice(offset, offset + height);
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
  });
}

export async function reviewPlan(
  ctx: ExtensionContext,
  heading: string,
  details: string | PlanReview,
  action: string,
): Promise<boolean> {
  return ctx.ui.custom<boolean>((tui, theme, _keys, done) =>
    createPlanApproval(tui, theme, done, heading, details, action),
  );
}

export function createPlanApproval(
  tui: { terminal: { readonly rows: number }; requestRender: () => void },
  theme: Pick<Theme, "fg" | "bold">,
  done: (decision: boolean) => void,
  heading: string,
  details: string | PlanReview,
  action: string,
): Component {
  const title = selectorText(heading).replace(/\s+/gu, " ");
  const content =
    typeof details === "string"
      ? new Text(selectorText(details), 0, 0)
      : {
          render: (width: number) => renderPlanReview(details, theme, width),
        };
  let rendered: { width: number; lines: readonly string[] } | undefined;
  let offset = 0;
  let maximum = 0;
  let endDisplayed = false;
  return {
    invalidate() {
      rendered = undefined;
      endDisplayed = false;
    },
    render(width) {
      if (width < 1) {
        endDisplayed = false;
        return [];
      }
      if (rendered?.width !== width)
        rendered = { width, lines: content.render(width) };
      const { lines } = rendered;
      const height = Math.max(3, tui.terminal.rows - 7);
      maximum = Math.max(0, lines.length - height);
      offset = Math.min(offset, maximum);
      endDisplayed = offset === maximum;
      const hint = endDisplayed
        ? `Enter ${action} · Esc cancel`
        : "↑↓ scroll · Enter next page · Esc cancel";
      const compact = endDisplayed
        ? "Enter confirm · Esc cancel"
        : "↓ More · Esc cancel";
      return [
        truncateToWidth(theme.fg("accent", theme.bold(title)), width),
        ...lines.slice(offset, offset + height),
        truncateToWidth(
          theme.fg(
            endDisplayed ? "accent" : "dim",
            visibleWidth(hint) <= width ? hint : compact,
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
        // Wait for the final viewport to appear before accepting approval.
        if (endDisplayed && offset === maximum) done(true);
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
}
