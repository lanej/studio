import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";
import { selectorText } from "@lanej/pi-components";
import {
  floatingPaneHeight,
  floatingPaneOptions,
  paintPaneLine,
  paneMouse,
} from "../floating-pane.ts";
import type { WorkerAssignment } from "../tasks/workers.ts";

type WorkerTheme = Pick<Theme, "fg" | "bg" | "bold" | "getBgAnsi">;
type WorkerTui = Pick<TUI, "showOverlay" | "terminal" | "requestRender">;

interface WorkerActions {
  inspect(row: WorkerAssignment): void;
  focusPane(row: WorkerAssignment, signal: AbortSignal): Promise<void>;
  onError?(error: unknown): void;
}

function inline(text: string): string {
  return selectorText(text).replace(/\s+/gu, " ").trim();
}

function phase(row: WorkerAssignment, theme: WorkerTheme): string {
  const tone =
    row.activity === "attention"
      ? "warning"
      : row.activity !== "active"
        ? "muted"
        : row.role === "Reviewer"
          ? "thinkingHigh"
          : "accent";
  return theme.fg(tone, inline(row.phase));
}

function rosterLines(
  rows: readonly WorkerAssignment[],
  selected: number,
  theme: WorkerTheme,
  width: number,
  height: number,
  stacked: boolean,
): string[] {
  const step = stacked || height <= 1 ? 1 : 2;
  const count = Math.max(1, Math.floor(height / step));
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(count / 2), rows.length - count),
  );
  return rows.slice(start, start + count).flatMap((row, i) => {
    const current = start + i === selected;
    const label = truncateToWidth(
      `${current ? "› " : "  "}${inline(row.title)}`,
      width,
      "…",
      true,
    );
    const title = current
      ? paintPaneLine(theme, "selectedBg", theme.bold(label))
      : label;
    return step === 1
      ? [title]
      : [title, truncateToWidth(`  ${phase(row, theme)}`, width)];
  });
}

function assignmentLines(
  row: WorkerAssignment,
  theme: WorkerTheme,
  width: number,
): string[] {
  const title = wrapTextWithAnsi(inline(row.title), width);
  const lines = [
    ...title.map((line) => theme.bold(line)),
    `${phase(row, theme)}  ${theme.fg("muted", row.role)}`,
    theme.fg(
      "muted",
      `${inline(row.beadId)} · ${inline(row.attemptId).slice(0, 8)}`,
    ),
  ];
  if (row.question !== undefined) {
    lines.push(
      "",
      ...wrapTextWithAnsi(inline(row.question), width).map((line) =>
        theme.fg("warning", line),
      ),
    );
  }
  return lines;
}

export class WorkerPane {
  private rows: readonly WorkerAssignment[] = [];
  private selected: WorkerAssignment | undefined;
  private reassigned = false;
  private evidenceError: string | undefined;
  private loading = false;
  private pendingFocus: AbortController | undefined;
  private detailOffset = 0;
  private detailPage = 1;
  private detailMaxOffset = 0;
  private handle: OverlayHandle | undefined;
  private tui: WorkerTui | undefined;

  get focused(): boolean {
    return this.handle?.isFocused() === true;
  }

  setRows(
    rows: readonly WorkerAssignment[],
    evidenceError?: string,
    loading = false,
  ): void {
    if (
      this.rows === rows &&
      this.evidenceError === evidenceError &&
      this.loading === loading
    )
      return;
    this.loading = loading;
    this.rows = rows;
    this.evidenceError = evidenceError;
    const previous = this.selected;
    if (previous !== undefined) {
      this.selected = rows.find(
        (row) =>
          row.attemptId === previous.attemptId &&
          row.beadId === previous.beadId,
      );
      if (this.selected === undefined) this.reassigned = true;
      if (this.selected?.focusable !== true) this.cancelPendingFocus();
    } else if (!this.reassigned && this.handle !== undefined) {
      this.selected = rows[0];
    }
    this.tui?.requestRender();
  }

  private cancelPendingFocus(): void {
    this.pendingFocus?.abort();
    this.pendingFocus = undefined;
  }

  close(): void {
    this.cancelPendingFocus();
    this.handle?.hide();
    this.handle = undefined;
    this.tui = undefined;
  }

  reset(): void {
    this.close();
    this.rows = [];
    this.loading = false;
    this.selected = undefined;
    this.reassigned = false;
    this.evidenceError = undefined;
  }

  open(tui: WorkerTui, theme: WorkerTheme, actions: WorkerActions): void {
    if (this.handle !== undefined) {
      this.handle.focus();
      return;
    }
    this.selected ??= this.rows[0];
    this.reassigned = false;
    this.detailOffset = 0;
    this.tui = tui;
    this.handle = tui.showOverlay(
      {
        capturesViewportInput: true,
        invalidate() {},
        render: (width) =>
          this.render(theme, width, floatingPaneHeight(tui.terminal.rows)),
        handleInput: (key) => {
          this.handleInput(key, actions);
        },
        handleMouse: (event) =>
          paneMouse(event, (delta) => {
            this.scrollDetail(delta);
          }),
      },
      floatingPaneOptions,
    );
  }

  private scrollDetail(delta: number): void {
    this.detailOffset = Math.max(
      0,
      Math.min(this.detailMaxOffset, this.detailOffset + delta),
    );
  }

  private handleInput(key: string, actions: WorkerActions): void {
    if (matchesKey(key, "escape") || matchesKey(key, "ctrl+c")) {
      this.close();
      return;
    }
    if (matchesKey(key, "pageUp") || matchesKey(key, "pageDown")) {
      const delta = matchesKey(key, "pageUp")
        ? -this.detailPage
        : this.detailPage;
      this.scrollDetail(delta);
      this.tui?.requestRender();
      return;
    }
    if (this.pendingFocus !== undefined) return;
    const row = this.selected;
    if (row !== undefined && matchesKey(key, "enter")) {
      this.close();
      actions.inspect(row);
    } else if (row?.focusable === true && matchesKey(key, "right")) {
      const request = new AbortController();
      this.pendingFocus = request;
      this.tui?.requestRender();
      actions.focusPane(row, request.signal).then(
        () => {
          if (this.pendingFocus === request) this.close();
        },
        (error: unknown) => {
          if (this.pendingFocus !== request) return;
          this.pendingFocus = undefined;
          this.tui?.requestRender();
          actions.onError?.(error);
        },
      );
    } else {
      const down = matchesKey(key, "j") || matchesKey(key, "down");
      const up = matchesKey(key, "k") || matchesKey(key, "up");
      if ((!down && !up) || this.rows.length === 0) return;
      const index = row === undefined ? -1 : this.rows.indexOf(row);
      const next = index + (down ? 1 : -1);
      this.selected =
        this.rows[Math.max(0, Math.min(this.rows.length - 1, next))];
      this.reassigned = false;
      this.detailOffset = 0;
      this.tui?.requestRender();
    }
  }

  private render(theme: WorkerTheme, width: number, height: number): string[] {
    if (width < 1 || height < 1) return [];
    if (width < 6 || height < 3) return [truncateToWidth("Workers", width)];
    const inner = width - 4;
    const border = (text: string) => theme.fg("border", text);
    const frame = (text: string) =>
      `${border("│")} ${truncateToWidth(text, inner, "…", true)} ${border("│")}`;
    const heading = " Workers ";
    const top =
      border("╭─") +
      theme.bold(heading) +
      border(`${"─".repeat(Math.max(0, width - heading.length - 3))}╮`);
    const bottom = border(`╰${"─".repeat(width - 2)}╯`);
    const footer = ["↑↓ select"];
    if (this.selected !== undefined) footer.push("Enter inspect");
    if (this.selected?.focusable === true) footer.push("→ pane");
    footer.push("Esc close");
    const warning =
      this.evidenceError === undefined
        ? []
        : [theme.fg("warning", "Worker status unavailable")];
    const body: string[] = [...warning];
    if (this.reassigned) body.push(theme.fg("warning", "Assignment changed"));
    if (this.rows.length === 0) {
      if (warning.length === 0)
        body.push(
          theme.fg(
            "muted",
            this.loading
              ? "Loading worker assignments…"
              : "No current assignments",
          ),
        );
    } else {
      const room = height - body.length - 3;
      if (room > 0) body.push(...this.renderAssignments(theme, inner, room));
    }
    const hint =
      this.pendingFocus !== undefined
        ? "Focusing worker pane… · Esc cancel"
        : this.rows.length === 0
          ? "Esc close"
          : footer.join(" · ");
    return [
      truncateToWidth(top, width),
      ...body.slice(0, height - 3).map(frame),
      frame(theme.fg("dim", hint)),
      bottom,
    ].map((line) => paintPaneLine(theme, "userMessageBg", line));
  }

  private renderAssignments(
    theme: WorkerTheme,
    width: number,
    room: number,
  ): string[] {
    const selected = this.selected;
    const index = selected === undefined ? -1 : this.rows.indexOf(selected);
    const split = width >= 68;
    const listWidth = split ? Math.floor(width * 0.44) : width;
    const detailWidth = split ? width - listWidth - 3 : width;
    const details =
      selected === undefined
        ? [theme.fg("muted", "Select an assignment")]
        : assignmentLines(selected, theme, detailWidth);
    const height = Math.min(
      room,
      Math.max(
        split ? 7 : 9,
        Math.min(7, this.rows.length) * (split ? 2 : 1) + (split ? 0 : 7),
      ),
    );
    const listHeight = split
      ? height
      : Math.max(1, Math.min(this.rows.length, Math.floor(height / 2)));
    const list = rosterLines(
      this.rows,
      index,
      theme,
      listWidth,
      listHeight,
      !split,
    );
    const detailHeight = Math.max(0, split ? height : height - list.length - 1);
    this.detailPage = Math.max(
      1,
      detailHeight - (details.length > detailHeight ? 1 : 0),
    );
    this.detailMaxOffset = Math.max(0, details.length - this.detailPage);
    this.detailOffset = Math.min(this.detailOffset, this.detailMaxOffset);
    const preview = details.slice(
      this.detailOffset,
      this.detailOffset + this.detailPage,
    );
    if (this.detailMaxOffset > 0) {
      const range = `${String(this.detailOffset + 1)}–${String(this.detailOffset + preview.length)}/${String(details.length)}`;
      preview.push(theme.fg("dim", `PgUp/PgDn scroll · ${range}`));
    }
    if (!split)
      return [...list, theme.fg("border", "─".repeat(width)), ...preview].slice(
        0,
        height,
      );
    return Array.from(
      { length: height },
      (_, i) =>
        truncateToWidth(list[i] ?? "", listWidth, "…", true) +
        theme.fg("border", " │ ") +
        (preview[i] ?? ""),
    );
  }
}
