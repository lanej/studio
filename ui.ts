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
import {
  floatingPaneHeight,
  floatingPaneOptions,
  paintPaneLine,
  paneMouse,
} from "./floating-pane.ts";
import { knownTaskStatus, TaskStatus } from "./beads.ts";
import type { TaskAssignment } from "./config.ts";
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

export function withTaskAssignment(
  row: string,
  assignment: TaskAssignment | undefined,
  width: number,
  muted: (text: string) => string,
): string {
  if (assignment === undefined) return row;
  const suffix = `  ·  ${assignment.capability} · ${assignment.reasoning}`;
  return visibleWidth(row) + visibleWidth(suffix) <= width
    ? row + muted(suffix)
    : row;
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

const planReviewBreakpoint = 100;
const reviewColumnGap = 5;

type ApprovalTheme = Pick<Theme, "fg" | "bold">;

interface ApprovalBody {
  left: readonly string[];
  leftWidth: number;
  right?: readonly string[];
}

function approvalBody(
  details: string | PlanReview,
  theme: ApprovalTheme,
  width: number,
  split: boolean,
): ApprovalBody {
  if (typeof details === "string")
    return {
      left: new Text(selectorText(details), 0, 0).render(width),
      leftWidth: width,
    };

  const leftWidth = split ? Math.floor((width - reviewColumnGap) * 0.4) : width;
  const rightWidth = split ? width - reviewColumnGap - leftWidth : width;
  const plan = renderPlanReview(details, theme, leftWidth, rightWidth);
  if (split) return { left: plan.overview, leftWidth, right: plan.details };
  const left =
    plan.details.length === 0
      ? plan.overview
      : [...plan.overview, "", ...plan.details];
  return { left, leftWidth };
}

function approvalRows(
  body: ApprovalBody,
  theme: ApprovalTheme,
  offset: number,
  height: number,
): string[] {
  const start = Math.min(offset, Math.max(0, body.left.length - height));
  const left = body.left.slice(start, start + height);
  if (body.right === undefined) return left;

  const rightStart = Math.min(offset, Math.max(0, body.right.length - height));
  const right = body.right.slice(rightStart, rightStart + height);
  const divider = `  ${theme.fg("border", "│")}  `;
  return Array.from(
    { length: Math.max(left.length, right.length) },
    (_, row) => {
      const line = left[row] ?? "";
      const fill = " ".repeat(body.leftWidth - visibleWidth(line));
      return line + fill + divider + (right[row] ?? "");
    },
  );
}

export async function reviewPlan(
  ctx: ExtensionContext,
  heading: string,
  details: string | PlanReview,
  action: string,
): Promise<boolean> {
  return ctx.ui.custom<boolean>(
    (tui, theme, _keys, done) =>
      createPlanApproval(tui, theme, done, heading, details, action),
    typeof details === "string"
      ? undefined
      : {
          overlay: true,
          overlayOptions: {
            anchor: "top-left",
            width: "100%",
            maxHeight: "100%",
          },
        },
  );
}

export function createPlanApproval(
  tui: { terminal: { readonly rows: number }; requestRender: () => void },
  theme: ApprovalTheme,
  done: (decision: boolean) => void,
  heading: string,
  details: string | PlanReview,
  action: string,
): Component & { dispose(): void } {
  const title = selectorText(heading).replace(/\s+/gu, " ");
  const fullScreen = typeof details !== "string";
  let rendered: ApprovalBody | undefined;
  let lastWidth: number | undefined;
  let offset = 0;
  let maximum = 0;
  let page = 1;
  let endDisplayed = false;

  return {
    invalidate() {
      rendered = undefined;
      endDisplayed = false;
    },
    render(width) {
      endDisplayed = false;
      if (width < 1) return [];

      const rows = tui.terminal.rows;
      if (fullScreen && rows < 3)
        return [
          truncateToWidth(
            theme.fg("warning", "Resize to review · Esc cancel"),
            width,
          ),
        ];

      const split = fullScreen && width >= planReviewBreakpoint;
      const margin = fullScreen && width >= 8 ? (split ? "  " : " ") : "";
      const inner = width - 2 * margin.length;
      if (width !== lastWidth) {
        // Rewrapped content has new line positions, so show it from the start.
        offset = 0;
        rendered = undefined;
        lastWidth = width;
      }
      rendered ??= approvalBody(details, theme, inner, split);
      const spacer = fullScreen && rows >= 4 ? [""] : [];
      page = fullScreen ? rows - 2 - spacer.length : Math.max(3, rows - 7);
      maximum = Math.max(
        0,
        rendered.left.length - page,
        (rendered.right?.length ?? 0) - page,
      );
      offset = Math.min(offset, maximum);
      endDisplayed = offset === maximum;
      const body = approvalRows(rendered, theme, offset, page);
      if (fullScreen) body.push(...Array<string>(page - body.length).fill(""));

      const hint = endDisplayed
        ? `Enter ${action} · Esc cancel`
        : "↑↓ scroll · Enter next page · Esc cancel";
      const compact = endDisplayed
        ? "Enter confirm · Esc cancel"
        : "↓ More · Esc cancel";
      return [
        truncateToWidth(theme.fg("accent", theme.bold(title)), inner),
        ...spacer,
        ...body,
        truncateToWidth(
          theme.fg(
            endDisplayed ? "accent" : "dim",
            visibleWidth(hint) <= inner ? hint : compact,
          ),
          inner,
        ),
      ].map((line) => margin + line);
    },
    handleInput(input) {
      if (
        matchesKey(input, NavigationKey.Escape) ||
        matchesKey(input, NavigationKey.Cancel)
      )
        done(false);
      else if (matchesKey(input, NavigationKey.Enter)) {
        // Wait for both columns to show their endings before approving.
        if (endDisplayed && offset === maximum) done(true);
        else offset = Math.min(maximum, offset + Math.max(1, page - 1));
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
    dispose() {
      if (fullScreen) done(false);
    },
  };
}
