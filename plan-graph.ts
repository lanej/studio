import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { taskWaves } from "./smart-plan-graph.ts";

interface GraphTask {
  readonly key: string;
  readonly blockedBy: readonly string[];
}

interface GraphCell {
  glyph: string;
  lane: number;
}

export type PlanGraphLine = readonly GraphCell[];

export interface PlanGraphRow<T extends GraphTask> {
  task: T;
  key: string;
  prefix: PlanGraphLine;
  connectors: PlanGraphLine[];
}

const node = "●";
// Frost belongs to the rail itself. Task titles use the surrounding text color.
const laneColors: readonly ThemeColor[] = ["border", "syntaxNumber", "syntaxString", "syntaxKeyword", "warning"];

export function planGraphColor(theme: Pick<Theme, "fg">) {
  return (lane: number, text: string) => theme.fg(laneColors[lane % laneColors.length] ?? "accent", text);
}

export function renderGraphPrefix(
  line: PlanGraphLine,
  color: (lane: number, text: string) => string = (_lane, text) => text,
  styledNode?: string,
): string {
  return line
    .map(({ glyph, lane }) => {
      if (glyph === node && styledNode !== undefined) return styledNode;
      return glyph === " " ? glyph : color(lane, glyph);
    })
    .join("");
}

type Lanes = (string | undefined)[];

function freeLane(lanes: Lanes): number {
  const free = lanes.indexOf(undefined);
  return free < 0 ? lanes.length : free;
}

function nodeLine(lanes: Lanes, current: number): GraphCell[] {
  return lanes.flatMap((key, lane) => [
    { glyph: lane === current ? node : key === undefined ? " " : "│", lane },
    { glyph: " ", lane },
  ]);
}

// The four bits describe a cell's incident rails, in N/E/S/W order.
const north = 1,
  east = 2,
  south = 4,
  west = 8;
const junctionByRails = " │─╰││╭├─╯─┴╮┤┬┼";

function connectorLine(before: Lanes, after: Lanes, source: number, targets: number[]): GraphCell[] {
  const left = Math.min(source, ...targets);
  const right = Math.max(source, ...targets);
  const joined = new Set([source, ...targets]);
  // If two rails both continue, the arrow identifies which one receives the dependency.
  const merge = targets.length === 1 ? targets[0] : undefined;
  const markDirection = merge !== undefined && before[merge] !== undefined && after[source] !== undefined;
  return Array.from({ length: Math.max(before.length, after.length) }, (_, lane) => {
    const up = before[lane] !== undefined;
    const down = after[lane] !== undefined;
    const goesLeft = left < lane && lane <= right;
    const goesRight = left <= lane && lane < right;
    const rails = (up ? north : 0) | (goesRight ? east : 0) | (down ? south : 0) | (goesLeft ? west : 0);
    // A broken vertical passes behind the horizontal. Only a solid junction connects rails.
    const crosses = goesLeft && goesRight && up && down && !joined.has(lane);
    const stroke = crosses ? "┆" : junctionByRails.charAt(rails);
    let span = goesRight ? "─" : " ";
    if (markDirection && merge > source && lane === merge - 1) span = "▸";
    if (markDirection && merge < source && lane === merge) span = "◂";
    return [
      { glyph: stroke, lane: up || down ? lane : source },
      { glyph: span, lane: source },
    ];
  }).flat();
}

/** Draw the declared dependency edges in reading order, with one rail per pending task. */
export function planGraph<T extends GraphTask>(tasks: readonly T[]): PlanGraphRow<T>[] {
  const levels = taskWaves(
    tasks.map(({ key, blockedBy }) => ({
      key,
      blockedBy: [...blockedBy],
      owns: [],
    })),
  );
  const sorted = [...tasks].sort((a, b) => (levels.get(a.key) ?? 0) - (levels.get(b.key) ?? 0));
  const lanes: Lanes = [];
  const rows = sorted.map((task, taskIndex) => {
    const waiting = lanes.indexOf(task.key);
    const source = waiting < 0 ? freeLane(lanes) : waiting;
    lanes[source] = task.key;
    const prefix = nodeLine(lanes, source);
    const connectors: GraphCell[][] = [];
    const children = sorted.filter((child) => child.blockedBy.includes(task.key));
    const pending = children.map((child) => lanes.indexOf(child.key)).filter((lane) => lane >= 0);
    const fresh = children.filter((child) => !lanes.includes(child.key));
    const before = [...lanes];
    if (fresh.length > 0) {
      // The first new branch inherits this rail; the others fork from it.
      const forks = fresh.map((child, index) => {
        const lane = index === 0 ? source : freeLane(lanes);
        lanes[lane] = child.key;
        return lane;
      });
      if (forks.length > 1) connectors.push(connectorLine(before, lanes, source, forks));
    }
    for (const [index, target] of pending.entries()) {
      const previous = [...lanes];
      if (fresh.length === 0 && index === pending.length - 1) lanes[source] = undefined;
      // Route each join separately so incoming branches never acquire one another's children.
      connectors.push(connectorLine(previous, lanes, source, [target]));
    }
    if (children.length === 0) lanes[source] = undefined;
    if (connectors.length === 0 && taskIndex + 1 < sorted.length) {
      if (lanes.some((key) => key !== undefined)) connectors.push(connectorLine(lanes, lanes, source, []));
      else if (tasks.some((item) => item.blockedBy.length > 0)) connectors.push([]); // Separate the next disconnected component.
    }
    return { key: task.key, task, prefix, connectors };
  });

  const cells = Math.max(0, lanes.length * 2 - 1);
  // At seven lanes, use adjacent rails. Keep the spacer carrying a directional join.
  const columns = Array.from({ length: cells }, (_, column) => column).filter(
    (column) =>
      lanes.length <= 6 ||
      column % 2 === 0 ||
      rows.some((row) => row.connectors.some((line) => line[column]?.glyph === "▸" || line[column]?.glyph === "◂")),
  );
  const pad = (line: GraphCell[]): GraphCell[] => columns.map((column) => line[column] ?? { glyph: " ", lane: 0 });
  return rows.map((row) => ({
    ...row,
    prefix: pad(row.prefix),
    connectors: row.connectors.map(pad),
  }));
}
