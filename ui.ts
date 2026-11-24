import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  Text,
  truncateToWidth,
  type OverlayOptions,
} from "@earendil-works/pi-tui";
import { createTaskDrawer, type TaskDrawerItem } from "./task-drawer.ts";
import { NavigationKey } from "./runtime.ts";

type TaskChoice = { id: string; action: TaskAction };
export enum TaskAction {
  Inspect = "inspect",
  FocusPane = "focus_pane",
}

export async function openTaskDrawer(
  ctx: ExtensionContext,
  items: TaskDrawerItem[],
  project: string,
  options: { detailOnly?: boolean; limitReached?: boolean } = {},
): Promise<TaskChoice | undefined> {
  if (items.length === 0) return undefined;
  let overlay: OverlayOptions = {};
  return ctx.ui.custom<TaskChoice | undefined>(
    (tui, theme, _keys, done) => {
      // Pi keeps this object while the drawer is open. Read the live width on resize.
      const compact = () => tui.terminal.columns < 80;
      overlay = {
        anchor: "top-right",
        minWidth: 46,
        get width() {
          return compact() ? "100%" : "53%";
        },
        get margin() {
          return compact() ? { top: 1, bottom: 1 } : 1;
        },
      };
      const choose = (index: number, action: TaskAction): void => {
        const item = items[index];
        if (item !== undefined) done({ id: item.row.task.id, action });
      };
      return createTaskDrawer({
        items,
        project,
        detailOnly: options.detailOnly ?? false,
        limitReached: options.limitReached ?? false,
        theme,
        height: () => Math.max(1, tui.terminal.rows - 2),
        requestRender: () => {
          tui.requestRender();
        },
        onInspect: (index) => {
          choose(index, TaskAction.Inspect);
        },
        onFocus: (index) => {
          choose(index, TaskAction.FocusPane);
        },
        onCancel: () => {
          done(undefined);
        },
      });
    },
    { overlay: true, overlayOptions: () => overlay },
  );
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
