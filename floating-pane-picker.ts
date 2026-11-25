import {
  getSelectListTheme,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  isKeyRelease,
  matchesKey,
  SelectList,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import {
  floatingPaneOptions,
  paintPaneLine,
  paneMouse,
} from "./floating-pane.ts";

const actions = {
  workers: { key: "w", label: "Workers" },
  tasks: { key: "t", label: "Tasks" },
  status: { key: "s", label: "Toggle status" },
} as const;
export type LeadPaneAction = keyof typeof actions;

type PickerContext = {
  ui: Pick<ExtensionContext["ui"], "custom" | "onTerminalInput">;
};

export async function pickLeadPane(
  ctx: PickerContext,
  choices: readonly LeadPaneAction[],
): Promise<LeadPaneAction | undefined> {
  if (choices.length === 0) return undefined;
  let release: (() => void) | undefined;
  try {
    return await ctx.ui.custom<LeadPaneAction | undefined>(
      (tui, theme, _keys, done) => {
        const list = new SelectList(
          choices.map((value) => ({
            value,
            label: `${actions[value].key}  ${actions[value].label}`,
          })),
          choices.length,
          getSelectListTheme(),
        );
        list.onSelect = (item) => {
          done(choices.find((action) => action === item.value));
        };
        list.onCancel = () => {
          done(undefined);
        };
        const handleInput = (input: string) => {
          const action = choices.find((choice) =>
            matchesKey(input, actions[choice].key),
          );
          if (action !== undefined) done(action);
          else if (
            matchesKey(input, "escape") ||
            matchesKey(input, "ctrl+space")
          )
            done(undefined);
          else if (matchesKey(input, "j") || matchesKey(input, "k")) {
            const index = choices.findIndex(
              (choice) => choice === list.getSelectedItem()?.value,
            );
            list.setSelectedIndex(
              (index + (matchesKey(input, "j") ? 1 : -1) + choices.length) %
                choices.length,
            );
          } else list.handleInput(input);
          tui.requestRender();
        };
        // Pi mounts the overlay in a microtask. A second key from the same terminal
        // read must select a pane before the lead editor can receive it.
        release = ctx.ui.onTerminalInput((input) => {
          if (!isKeyRelease(input)) handleInput(input);
          return { consume: true };
        });
        return {
          capturesViewportInput: true,
          invalidate() {
            list.invalidate();
          },
          handleInput,
          handleMouse(event) {
            return (
              list.handleMouse({ ...event, x: event.x - 1, y: event.y - 1 }) ??
              paneMouse(event)
            );
          },
          render(width) {
            const border = (text: string) => theme.fg("border", text);
            const edge = (
              corner: string,
              label: string,
              styled: string,
              end: string,
            ) =>
              border(corner + "─") +
              styled +
              border("─".repeat(Math.max(0, width - label.length - 3)) + end);
            const title = " Studio panes ";
            const footer = " Esc close ";
            const inner = Math.max(0, width - 2);
            return [
              edge("╭", title, theme.bold(title), "╮"),
              ...list
                .render(Math.max(1, inner))
                .map(
                  (line) =>
                    border("│") +
                    truncateToWidth(line, inner, "", true) +
                    border("│"),
                ),
              edge("╰", footer, theme.fg("muted", footer), "╯"),
            ].map((line) =>
              paintPaneLine(
                theme,
                "userMessageBg",
                truncateToWidth(line, width, ""),
              ),
            );
          },
        };
      },
      {
        overlay: true,
        overlayOptions: { ...floatingPaneOptions, width: 28 },
        onHandle() {
          release?.();
          release = undefined;
        },
      },
    );
  } finally {
    release?.();
  }
}
