import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, visibleWidth } from "@earendil-works/pi-tui";
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

export function shellOutputPreview(
  output: string,
  theme: Theme,
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
  const metadata = (hidden: number, width: number) => {
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
        visibleWidth([...fields, field].join(" · ")) <= width
      )
        fields.push(field);
    }
    if (fields.length === 0) return "";
    if (fields[0] === count) {
      const key = expandKey();
      const hinted = [`${count} (${key})`, ...fields.slice(1)].join(" · ");
      if (key !== "" && visibleWidth(hinted) <= width) {
        showExpandKey();
        return inlayText(theme, hinted);
      }
    }
    return inlayText(theme, fields.join(" · "));
  };

  return {
    invalidate() {
      text.invalidate();
    },
    render(width) {
      const rows = text.render(width);
      const visible = expanded ? rows : rows.slice(-previewLines);
      const header = metadata(rows.length - visible.length, width);
      if (visible.length === 0 && header === "") return [];
      return [header, ...visible];
    },
  };
}
