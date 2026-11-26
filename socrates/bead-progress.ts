import { truncateToWidth } from "@earendil-works/pi-tui";
import { statusPaint, type StatusTheme } from "@lanej/pi-components";
import { taskMarks } from "./columns.ts";
import { ImplementationPhase, ImplementationState, type ImplementationPresentation } from "./implementation.ts";

/** A cell follows its task in plan order, even when the task changes state. */
export function renderBeadProgress(
  implementation: ImplementationPresentation,
  theme: StatusTheme,
  width: number,
  height: number,
): string[] {
  const tasks = implementation.rows;
  if (implementation.phase !== ImplementationPhase.Tracking || tasks.length === 0 || height < 1 || width < 1) return [];

  const label = width >= 10 ? "Beads  " : "";
  const room = width - label.length;
  const columns = Math.min(10, room);
  const limit = Math.min(height, 3);
  const lines: string[] = [];
  for (let start = 0; start < tasks.length && lines.length < limit; start += columns) {
    const last = lines.length + 1 === limit;
    let count = Math.min(columns, tasks.length - start);
    let overflow = "";
    if (last && start + count < tasks.length) {
      // Keep the omitted count accurate even when its digits need another cell.
      while (count > 0 && count + 1 + String(tasks.length - start - count).length + 1 > room) count--;
      overflow = (count > 0 ? " +" : "+") + String(tasks.length - start - count);
    }
    const beads = tasks.slice(start, start + count).map(({ state }) => {
      const mark = taskMarks[state];
      const glyph = state === ImplementationState.Blocked || state === ImplementationState.Deferred ? "○" : mark.glyph;
      return statusPaint(theme, mark.tone)(glyph);
    });
    const prefix = lines.length === 0 ? theme.muted(label) : " ".repeat(label.length);
    lines.push(truncateToWidth(prefix + beads.join("") + theme.muted(overflow), width));
  }
  return lines;
}
