import {
  backgroundAnsi,
  foregroundAnsi,
  getTerminalColorMode,
  isKeyRelease,
  matchesKey,
  parseColor,
  ProcessTerminal,
  TuiAltScreen,
  styleTextWithAnsi,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import {
  ActivityState,
  createStatusBoard,
  type StatusColumn,
  type StatusItem,
  type StatusMark,
} from "@lanej/pi-components";
import { basename } from "node:path";
import sage from "../resources/sage-midnight.json" with { type: "json" };
import { ExecutionPhase } from "./phase.ts";
import { readRuntimeStatus, runtimeAttemptGroups, statusLine, supervisorStatus, type RuntimeStatus } from "./status.ts";
import type { Execution } from "./store.ts";
import { RuntimeTaskPreview, type RuntimeStatusStyle } from "./status-preview.ts";

const active = { glyph: "●", tone: "accent" } as const;
const idle = { glyph: "○", tone: "muted" } as const;
const warning = { glyph: "◐", tone: "warning" } as const;
const error = { glyph: "!", tone: "error" } as const;
const successful = { glyph: "✓", tone: "success" } as const;

const phaseMarks = {
  [ExecutionPhase.Queued]: { ...idle, label: "Queued" },
  [ExecutionPhase.Claiming]: { ...active, label: "Claiming" },
  [ExecutionPhase.Allocating]: { ...active, label: "Allocating" },
  [ExecutionPhase.Launching]: { ...active, label: "Launching" },
  [ExecutionPhase.Running]: { ...active, label: "Running" },
  [ExecutionPhase.Reviewing]: { ...active, label: "Reviewing" },
  [ExecutionPhase.Integrating]: { ...active, label: "Integrating" },
  [ExecutionPhase.Delivery]: { ...warning, label: "Delivery pending" },
  [ExecutionPhase.Waiting]: { ...warning, label: "Correction pending" },
  [ExecutionPhase.AwaitingDecision]: { ...warning, label: "Decision needed" },
  [ExecutionPhase.Complete]: { ...successful, label: "Complete" },
  [ExecutionPhase.Parked]: { ...error, label: "Needs review" },
  [ExecutionPhase.Uncertain]: { ...error, label: "Uncertain" },
} satisfies Record<ExecutionPhase, StatusMark>;

function details(fields: readonly (readonly [string, string | number | undefined])[]): string {
  return fields
    .flatMap(([label, value]) => (value === undefined || value === "" ? [] : [`${label}  ${String(value)}`]))
    .join("\n");
}

function attemptItem(attempt: Execution): StatusItem {
  const title = attempt.bead?.title.trim() ?? "";
  return {
    id: attempt.id,
    label: title === "" ? (attempt.bead?.id ?? "Unclaimed attempt") : title,
    summary: title === "" ? undefined : attempt.bead?.id,
    status: phaseMarks[attempt.phase],
  };
}

function columns(snapshot: RuntimeStatus): StatusColumn[] {
  const { attention, inProgress, completed } = runtimeAttemptGroups(snapshot.attempts);
  const projectNames = new Map(snapshot.projects.map(({ id, root }) => [id, root === "/" ? root : basename(root)]));
  const { supervisor, allocationOwner } = snapshot;
  return [
    {
      id: "attempts",
      title: "Attempts",
      counts: [
        { label: "attention", value: attention.length, tone: "warning" },
        { label: "other", value: inProgress.length, tone: "accent" },
        { label: "complete", value: completed.length, tone: "success" },
      ],
      groups: [
        { id: "attention", label: "Needs attention", items: attention.map(attemptItem) },
        { id: "in-progress", label: "Other unfinished", items: inProgress.map(attemptItem) },
        { id: "complete", label: "Completed", collapsed: true, items: completed.map(attemptItem) },
      ].filter((group) => group.items.length > 0),
      emptyMessage: "No retained attempts",
    },
    {
      id: "runtime",
      title: "Runtime & projects",
      groups: [
        {
          id: "ownership",
          label: "Ownership",
          items: [
            {
              id: "supervisor",
              label: "Supervisor",
              summary: supervisor === null ? undefined : `PID ${String(supervisor.pid)}`,
              status: snapshot.live
                ? supervisor?.stop === true
                  ? { ...warning, label: "Stop requested" }
                  : { ...successful, label: "Live" }
                : { ...idle, label: supervisor === null ? "None recorded" : "Not live" },
              details: details([
                ["Supervisor", supervisor?.id],
                ["PID", supervisor?.pid],
                ["Recorded start (UTC)", supervisor?.started],
                ["Admission stop requested", supervisor === null ? undefined : supervisor.stop ? "yes" : "no"],
              ]),
            },
            {
              id: "allocation",
              label: "Allocation",
              status:
                allocationOwner === null ? { ...idle, label: "No owner" } : { ...warning, label: "Owner recorded" },
              details: details([
                ["Owner", allocationOwner?.id],
                ["Attempt", allocationOwner?.attempt],
                ["Recorded PID", allocationOwner?.pid],
                ["Recorded start (UTC)", allocationOwner?.started],
              ]),
            },
          ],
        },
        {
          id: "projects",
          label: `Enrolled projects (${String(snapshot.projects.length)})`,
          items: snapshot.projects.map(({ id, root, profile, profileDigest, mergePolicy }) => ({
            id,
            label: projectNames.get(id) ?? root,
            summary: profile,
            status: mergePolicy.enabled ? { ...active, label: "Auto-merge on" } : { ...idle, label: "Auto-merge off" },
            details: details([
              ["Project", id],
              ["Root", root],
              ["Legacy profile", profile],
              ["Profile digest", profileDigest],
              ["Merge policy", `Auto-merge ${mergePolicy.enabled ? "on" : "off"} (${mergePolicy.origin})`],
              ["Override reason", mergePolicy.override?.reason],
              ["Override actor", mergePolicy.override?.actor],
            ]),
          })),
        },
      ],
    },
  ];
}

export async function showRuntimeStatus(initial: RuntimeStatus): Promise<void> {
  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, true, undefined, { mouse: false });
  const mode = getTerminalColorMode();
  const foreground = (value: string) => foregroundAnsi(parseColor(value), mode);
  const background = (value: string) => backgroundAnsi(parseColor(value), mode);
  const paint = (value: string) => {
    const ansi = foreground(value);
    return (text: string) => styleTextWithAnsi(text, ansi, undefined, {});
  };
  const selected = background(sage.colors.selectedBg);
  const baseForeground = foreground(sage.colors.text);
  const baseBackground = background(sage.export.pageBg);
  const style: RuntimeStatusStyle = {
    accent: paint(sage.colors.accent),
    muted: paint(sage.colors.muted),
    bold: (text) => styleTextWithAnsi(text, foreground(sage.colors.userMessageText), undefined, { bold: true }),
    success: paint(sage.colors.success),
    warning: paint(sage.colors.warning),
    error: paint(sage.colors.error),
    review: paint(sage.colors.thinkingHigh),
    info: paint(sage.colors.syntaxFunction),
    attention: paint(sage.vars.statusAttention),
    off: paint(sage.colors.thinkingOff),
    priority: paint(sage.colors.syntaxNumber),
    selected: (text) => styleTextWithAnsi(text, undefined, selected, {}),
  };
  const surface = (lines: readonly string[], width: number): string[] =>
    Array.from({ length: terminal.rows }, (_, index) => {
      const line = truncateToWidth(lines[index] ?? "", width, "", true)
        .replaceAll("\x1b[0m", `\x1b[0m${baseForeground}${baseBackground}`)
        .replaceAll("\x1b[39m", baseForeground)
        .replaceAll("\x1b[49m", baseBackground);
      return styleTextWithAnsi(line, baseForeground, baseBackground, {});
    });
  const lifecycle = new AbortController();
  let refreshing = false;
  let snapshot = initial;
  let preview: RuntimeTaskPreview | undefined;
  let previewId: string | undefined;
  let stale: string | undefined;
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  const close = () => {
    lifecycle.abort();
    resolve(undefined);
  };
  const board = createStatusBoard({
    title: "Studio runtime",
    columns: columns(initial),
    theme: style,
    height: () => terminal.rows - (stale === undefined ? 0 : 1),
    requestRender: () => {
      tui.requestRender();
    },
    onClose: close,
  });
  const showSupervisor = (snapshot: RuntimeStatus) => {
    board.setActivity({
      state: snapshot.live && snapshot.supervisor?.stop !== true ? ActivityState.Working : ActivityState.Paused,
      label: supervisorStatus(snapshot),
    });
  };
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      const refreshed = await readRuntimeStatus();
      if (lifecycle.signal.aborted) return;
      snapshot = refreshed;
      const selected = refreshed.attempts.find(({ id }) => id === previewId);
      if (selected !== undefined) preview?.update(selected);
      board.setColumns(columns(snapshot));
      showSupervisor(snapshot);
      stale = undefined;
    } catch (cause) {
      stale = statusLine(cause instanceof Error ? cause.message : String(cause));
    } finally {
      refreshing = false;
      if (!lifecycle.signal.aborted) tui.requestRender();
    }
  };
  const requestRefresh = () => {
    void refresh().catch(reject);
  };
  const view = {
    capturesViewportInput: true,
    handleInput(input: string) {
      if (isKeyRelease(input)) return;
      if (preview !== undefined) {
        preview.handleInput(input);
        return;
      }
      const selection = matchesKey(input, "enter") ? board.selection() : undefined;
      if (selection?.columnId === "attempts" && selection.itemId !== undefined) {
        const attempt = snapshot.attempts.find(({ id }) => id === selection.itemId);
        if (attempt === undefined) return;
        const root = snapshot.projects.find(({ id }) => id === attempt.project)?.root;
        previewId = attempt.id;
        preview = new RuntimeTaskPreview(
          attempt,
          root,
          (record) => phaseMarks[record.phase],
          style,
          tui,
          () => {
            if (!lifecycle.signal.aborted) tui.requestRender();
          },
          () => {
            preview = undefined;
            previewId = undefined;
            tui.requestRender();
          },
        );
        return;
      }
      if (matchesKey(input, "q")) close();
      else if (matchesKey(input, "r")) requestRefresh();
      else board.handleInput(input);
    },
    render(width: number) {
      if (terminal.rows < 8 || width < 22) return surface(["Resize terminal · q quit"], width);
      if (preview !== undefined) return surface(preview.render(width, terminal.rows), width);
      const lines = board.render(width);
      const keys = lines.at(-1) ?? "";
      const refreshWarning = stale === undefined ? [] : [truncateToWidth(style.error(`Stale · ${stale}`), width)];
      const gap = terminal.rows - lines.length - refreshWarning.length;
      return surface(
        [
          ...lines.slice(0, -1),
          ...Array<string>(Math.max(0, gap)).fill(""),
          ...refreshWarning,
          truncateToWidth(`${style.muted("r refresh · q quit")} · ${keys}`, width),
        ],
        width,
      );
    },
    invalidate() {
      board.invalidate();
    },
  };
  tui.addChild(view);
  tui.setFocus(view);
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  const timer = setInterval(requestRefresh, 5_000);
  try {
    tui.start();
    showSupervisor(initial);
    await promise;
  } finally {
    lifecycle.abort();
    clearInterval(timer);
    process.off("SIGINT", close);
    process.off("SIGTERM", close);
    tui.stop();
  }
}
