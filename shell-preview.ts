import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Text,
  stripTerminalSequences,
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
  inlay?: ((width: number, available: number) => string) | undefined;

  constructor() {
    super("", 0, 0);
  }

  override render(width: number): readonly string[] {
    const rows = super.render(width);
    if (this.inlay === undefined) return rows;
    // A multiline command can end with blank rows. Attach to its last visible text.
    const end = rows.findLastIndex(
      (row) => stripTerminalSequences(row).trim() !== "",
    );
    const tail = rows[end]?.trimEnd();
    if (tail === undefined) return rows;
    const tailWidth = visibleWidth(tail);
    const gap = "  ";
    // Leave at least half a row for a long command. Short tails need less.
    const available =
      width - Math.min(tailWidth, Math.ceil(width / 2)) - gap.length;
    const note = this.inlay(width, available);
    if (note === "") return rows;

    const commandWidth = width - gap.length - visibleWidth(note);
    const wrapped = wrapTextWithAnsi(tail, commandWidth);
    const last = wrapped.pop();
    if (last === undefined || stripTerminalSequences(last).trim() === "")
      return rows;
    return [
      ...rows.slice(0, end),
      ...wrapped,
      last + gap + note,
      ...rows.slice(end + 1),
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
    showExpandKey,
    tokens,
    elapsed,
  }: {
    expanded: boolean;
    expandKey: () => string;
    showExpandKey: () => void;
    tokens: number | undefined;
    elapsed: string | undefined;
  },
): Component {
  const text = new Text(output, 0, 0);
  if (heading !== undefined) {
    heading.inlay = (width, available) => {
      const hidden = expanded ? 0 : text.render(width).length - previewLines;
      const count =
        hidden > 0
          ? `+${hidden.toString()} ${hidden === 1 ? "line" : "lines"}`
          : "";
      const size = tokens === undefined ? "" : `≈${tokens.toString()} tokens`;
      const fields: string[] = [];
      for (const field of [count, size, elapsed]) {
        if (
          field !== undefined &&
          field !== "" &&
          visibleWidth([...fields, field].join(" · ")) <= available
        )
          fields.push(field);
      }
      if (fields.length === 0) return "";
      if (fields[0] === count) {
        const key = expandKey();
        const hinted = [`${count} (${key})`, ...fields.slice(1)].join(" · ");
        if (key !== "" && visibleWidth(hinted) <= available) {
          showExpandKey();
          return inlayText(theme, hinted);
        }
      }
      return inlayText(theme, fields.join(" · "));
    };
  }

  return {
    invalidate() {
      text.invalidate();
    },
    render(width) {
      const rows = text.render(width);
      const visible = expanded ? rows : rows.slice(-previewLines);
      return visible.length === 0 ? [] : ["", ...visible];
    },
  };
}
