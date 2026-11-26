import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { knownTaskStatus, TaskStatus } from "../beads.ts";
import type { TaskAssignment } from "../config.ts";

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
