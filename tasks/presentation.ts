import sageUI from "../resources/sage-terminal-ui.json" with { type: "json" };
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { knownTaskStatus, TaskStatus } from "../beads.ts";
import type { TaskAssignment } from "../config.ts";

const statusTones = {
  [TaskStatus.Open]: { glyph: sageUI.symbols["task.open"], tone: "muted" },
  [TaskStatus.InProgress]: { glyph: sageUI.states["execution.running"], tone: "accent" },
  [TaskStatus.Blocked]: { glyph: sageUI.states["execution.blocked"], tone: "error" },
  [TaskStatus.Deferred]: { glyph: sageUI.symbols["task.deferred"], tone: "warning" },
  [TaskStatus.Closed]: { glyph: sageUI.symbols["task.closed"], tone: "success" },
} satisfies Record<TaskStatus, { glyph: string; tone: ThemeColor }>;

export function taskStatusGlyph(status: string, theme: Pick<Theme, "fg">): string {
  const recognized = knownTaskStatus(status);
  const { glyph, tone } =
    recognized === undefined
      ? { glyph: sageUI.symbols["task.unknown"], tone: "muted" as const }
      : statusTones[recognized];
  return theme.fg(tone, glyph);
}

export function withTaskAssignment(
  row: string,
  assignment: TaskAssignment | undefined,
  width: number,
  muted: (text: string) => string,
): string {
  if (!assignment) return row;
  const suffix = `  ·  ${assignment.capability} · ${assignment.reasoning}`;
  return visibleWidth(row) + visibleWidth(suffix) <= width ? row + muted(suffix) : row;
}
