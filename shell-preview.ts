import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Text,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { z } from "zod";
import { inlayText } from "./code-intelligence/diff.ts";

const previewLines = 5;
const timerState = z.object({
  startedAt: z.number(),
  endedAt: z.number().optional(),
});

export function shellElapsed(
  timerText: string | undefined,
  durationMs: number | undefined,
  state: unknown,
) {
  if (durationMs === undefined) {
    const clock = timerState.safeParse(state);
    if (clock.success)
      durationMs = (clock.data.endedAt ?? Date.now()) - clock.data.startedAt;
  }
  return durationMs !== undefined && durationMs >= 1000
    ? timerText?.replace(/^Took /u, "")
    : undefined;
}

export class ShellHeading extends Text {
  inlay?: ((width: number) => string) | undefined;

  constructor() {
    super("", 0, 0);
  }

  // Long commands can use the existing blank row before the output for the inlay.
  hasRoom(width: number, inlay: string): boolean {
    const last = super.render(width).at(-1)?.trimEnd() ?? "";
    return visibleWidth(last) + 2 + visibleWidth(inlay) <= width;
  }

  override render(width: number): readonly string[] {
    const rows = super.render(width);
    const note = this.inlay?.(width) ?? "";
    if (note === "") return rows;
    if (!this.hasRoom(width, note)) {
      const extra = wrapTextWithAnsi(note, Math.max(1, width));
      return [
        ...rows,
        ...extra.map(
          (line) => " ".repeat(Math.max(0, width - visibleWidth(line))) + line,
        ),
      ];
    }
    const last = rows.at(-1)?.trimEnd() ?? "";
    return [
      ...rows.slice(0, -1),
      last + " ".repeat(width - visibleWidth(last) - visibleWidth(note)) + note,
    ];
  }
}

export function shellOutputPreview(
  output: string,
  theme: Theme,
  heading: ShellHeading | undefined,
  {
    expanded,
    expandKey,
    tokens,
    elapsed,
  }: {
    expanded: boolean;
    expandKey: () => string;
    tokens: number | undefined;
    elapsed: string | undefined;
  },
): Component {
  const text = new Text(output, 0, 0);
  const summary = [
    tokens === undefined ? undefined : `≈${tokens.toString()} tokens`,
    elapsed,
  ]
    .filter((part) => part !== undefined)
    .join(" · ");

  const inlay = (width: number) => {
    const hidden = expanded ? 0 : text.render(width).length - previewLines;
    if (hidden <= 0) return summary === "" ? "" : inlayText(theme, summary);
    const count = `+${hidden.toString()} ${hidden === 1 ? "line" : "lines"}`;
    const key = expandKey();
    const hotkey = key === "" ? "" : ` (${key})`;
    return inlayText(
      theme,
      count + hotkey + (summary === "" ? "" : ` · ${summary}`),
    );
  };
  if (heading !== undefined) heading.inlay = inlay;

  return {
    invalidate() {
      text.invalidate();
    },
    render(width) {
      const rows = text.render(width);
      const visible = expanded ? rows : rows.slice(-previewLines);
      const label = inlay(width);
      if (heading === undefined && label !== "")
        return [...wrapTextWithAnsi(label, Math.max(1, width)), ...visible];
      if (
        rows.length > 0 &&
        (label === "" || heading?.hasRoom(width, label) === true)
      )
        return ["", ...visible];
      return visible;
    },
  };
}
