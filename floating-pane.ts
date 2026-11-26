import type { Theme, ThemeBg } from "@earendil-works/pi-coding-agent";
import type {
  OverlayOptions,
  TuiMouseEvent,
  TuiMouseEventResult,
} from "@earendil-works/pi-tui";

const verticalInset = 1;

/** Explicitly opened workspaces share a centered viewport over the lead. */
export const floatingPaneOptions = {
  anchor: "center",
  width: 100,
  maxHeight: "80%",
  margin: { left: 2, right: 2, top: verticalInset, bottom: verticalInset },
} satisfies OverlayOptions;

export function floatingPaneHeight(terminalRows: number): number {
  return Math.max(
    1,
    Math.min(
      terminalRows - 2 * verticalInset,
      Math.floor(
        (terminalRows * Number.parseInt(floatingPaneOptions.maxHeight, 10)) /
          100,
      ),
    ),
  );
}

/** Keep the pane's fill across embedded ANSI resets and selected rows. */
export function paintPaneLine(
  theme: Pick<Theme, "bg" | "getBgAnsi">,
  color: ThemeBg,
  text: string,
): string {
  const background = theme.getBgAnsi(color);
  return theme.bg(
    color,
    text
      .replaceAll("\x1b[0m", `\x1b[0m${background}`)
      .replaceAll("\x1b[49m", background),
  );
}

/** Retain pointer events inside a floating pane so they cannot scroll the lead underneath. */
export function paneMouse(
  event: TuiMouseEvent,
  scroll?: (delta: number) => void,
): TuiMouseEventResult {
  const delta = event.wheelDelta ?? 0;
  if (event.type === "wheel" && delta !== 0 && scroll !== undefined) {
    scroll(delta);
    return { handled: true };
  }
  return { handled: true, render: false };
}
