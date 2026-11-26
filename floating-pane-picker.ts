import { getSelectListTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, SelectList, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { floatingPaneOptions, paintPaneLine, paneMouse } from "./floating-pane.ts";
import { defaultPaneKeybindings, matchesPaneKey, paneKeyHint, paneKeyLabel } from "./pane-keybindings.ts";

const actions = {
  workers: "Workers",
  tasks: "Tasks",
  status: "Toggle status",
} as const;
export type LeadPaneAction = keyof typeof actions;

type PickerContext = {
  ui: Pick<ExtensionContext["ui"], "custom" | "onTerminalInput">;
};

export async function pickLeadPane(
  ctx: PickerContext,
  choices: readonly LeadPaneAction[],
  bindings = defaultPaneKeybindings,
): Promise<LeadPaneAction | undefined> {
  if (choices.length === 0) return undefined;
  const items = choices.map((value) => ({
    value,
    label: [paneKeyLabel(bindings.picker[value]), actions[value]].filter(Boolean).join("  "),
  }));
  const close = paneKeyHint([...bindings.pane.close, ...bindings.lead.openPicker], "close");
  const footer = close.length > 0 ? ` ${close} ` : "";
  let release: (() => void) | undefined;
  try {
    return await ctx.ui.custom<LeadPaneAction | undefined>(
      (tui, theme, _keys, done) => {
        const list = new SelectList(items, choices.length, getSelectListTheme());
        list.onSelect = (item) => {
          done(choices.find((action) => action === item.value));
        };
        const handleInput = (input: string) => {
          const keys = bindings.pane;
          const action = choices.find((choice) => matchesPaneKey(input, bindings.picker[choice]));
          const selected = choices.findIndex((choice) => choice === list.getSelectedItem()?.value);
          if (action !== undefined) done(action);
          else if (matchesPaneKey(input, keys.close) || matchesPaneKey(input, bindings.lead.openPicker))
            done(undefined);
          else if (matchesPaneKey(input, keys.activate)) done(choices[selected]);
          else if (matchesPaneKey(input, keys.down)) list.setSelectedIndex((selected + 1) % choices.length);
          else if (matchesPaneKey(input, keys.up))
            list.setSelectedIndex((selected - 1 + choices.length) % choices.length);
          else if (matchesPaneKey(input, keys.pageUp)) list.setSelectedIndex(0);
          else if (matchesPaneKey(input, keys.pageDown)) list.setSelectedIndex(choices.length - 1);
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
            return list.handleMouse({ ...event, x: event.x - 1, y: event.y - 1 }) ?? paneMouse(event);
          },
          render(width) {
            const border = (text: string) => theme.fg("border", text);
            const edge = (corner: string, label: string, styled: string, end: string) =>
              border(corner + "─") + styled + border("─".repeat(Math.max(0, width - label.length - 3)) + end);
            const title = " Studio panes ";
            const inner = Math.max(0, width - 2);
            return [
              edge("╭", title, theme.bold(title), "╮"),
              ...list
                .render(Math.max(1, inner))
                .map((line) => border("│") + truncateToWidth(line, inner, "", true) + border("│")),
              edge("╰", footer, theme.fg("muted", footer), "╯"),
            ].map((line) => paintPaneLine(theme, "userMessageBg", truncateToWidth(line, width, "")));
          },
        };
      },
      {
        overlay: true,
        overlayOptions: {
          ...floatingPaneOptions,
          width: Math.max(28, visibleWidth(footer) + 3, ...items.map(({ label }) => visibleWidth(label) + 4)),
        },
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
