import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, visibleWidth } from "@earendil-works/pi-tui";
import { z } from "zod";
import { inlayText } from "./code-intelligence/diff.ts";

const previewLines = 5;
const timerState = z.object({
  startedAt: z.number(),
  endedAt: z.number().optional(),
});

export function shellElapsed(timerText: string | undefined, durationMs: number | undefined, state: unknown) {
  if (durationMs === undefined) {
    const clock = timerState.safeParse(state);
    if (clock.success) durationMs = (clock.data.endedAt ?? Date.now()) - clock.data.startedAt;
  }
  return durationMs !== undefined && durationMs >= 1000 ? timerText?.replace(/^Took /u, "") : undefined;
}

export function shellOutputPreview(
  output: string,
  theme: Theme,
  {
    expanded,
    tokens,
    elapsed,
  }: {
    expanded: boolean;
    tokens: number | undefined;
    elapsed: string | undefined;
  },
): Component {
  const text = new Text(output, 0, 0);
  const metadata = (hidden: number, width: number) => {
    const count = hidden > 0 ? `${hidden.toString()} more ${hidden === 1 ? "line" : "lines"}` : "";
    const size = tokens === undefined ? "" : `≈${tokens.toString()} tokens`;
    const fields: string[] = [];
    for (const field of [count, size, elapsed]) {
      if (field !== undefined && field !== "" && visibleWidth([...fields, field].join(" · ")) <= width)
        fields.push(field);
    }
    if (fields.length === 0) return "";
    const label = fields.join(" · ");
    return " ".repeat(width - visibleWidth(label)) + inlayText(theme, label);
  };

  return {
    invalidate() {
      text.invalidate();
    },
    render(width) {
      const rows = text.render(width);
      const visible = expanded ? rows : rows.slice(-previewLines);
      const hidden = rows.length - visible.length;
      const first = visible[0]?.replace(/ +$/u, "");
      if (hidden === 0 && elapsed === undefined && first !== undefined && first.trim() !== "") {
        const available = width - visibleWidth(first) - 2;
        const inline = metadata(0, available);
        if (inline !== "") return [`${first}  ${inline}`, ...visible.slice(1)];
      }
      const header = metadata(hidden, width);
      if (visible.length === 0 && header === "") return [];
      return [header, ...visible];
    },
  };
}
