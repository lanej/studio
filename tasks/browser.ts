import type {
  ExtensionContext,
  Theme,
  ThemeBg,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { taskTree, type Task, type TreeRow } from "../beads.ts";
import { NavigationKey } from "../runtime.ts";
import { selectorText } from "@lanej/pi-components";
import { taskStatusGlyph } from "../ui.ts";
import {
  currentReviewFinding,
  needsAttention,
  plain,
  retainedEvidence,
  taskLinks,
  taskNarrative,
  type TaskSnapshot,
} from "./model.ts";

interface BrowserSource {
  label: string;
  identity: string;
  emptyHint?: string;
  load: () => Promise<TaskSnapshot>;
  show: (id: string) => Promise<Task>;
}
type Action =
  | { kind: "link"; id: string }
  | { kind: "disclosure"; section: string }
  | { kind: "pane"; id: string };
interface DetailLine {
  text: string;
  action?: Action;
}

export class TaskBrowser {
  private rows: TreeRow[];
  private selected: string | undefined;
  private focus: "tree" | "inspector";
  private treeOffset = 0;
  private readonly offsets = new Map<string, number>();
  private readonly expanded = new Set<string>();
  private actions: { action: Action; line: number }[] = [];
  private activeAction = -1;
  private maximum = 0;
  private bodyHeight = 1;
  private busy = false;
  private notice = "";
  private closed = false;

  constructor(
    private snapshot: TaskSnapshot,
    private readonly source: BrowserSource,
    private readonly theme: Pick<Theme, "fg" | "bg" | "bold" | "getBgAnsi">,
    private readonly height: () => number,
    private readonly changed: () => void,
    private readonly done: (paneTask: string | undefined) => void,
    initialId?: string,
  ) {
    this.rows = taskTree(snapshot.tasks);
    this.selected = initialId ?? this.rows[0]?.task.id;
    this.focus = initialId === undefined ? "tree" : "inspector";
  }

  invalidate(): void {}

  private get row(): TreeRow | undefined {
    return this.rows.find((row) => row.task.id === this.selected);
  }

  private pad(text: string, width: number): string {
    const clipped = truncateToWidth(text, Math.max(1, width));
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  }

  private paint(color: ThemeBg, text: string): string {
    const background = this.theme.getBgAnsi(color);
    // Truncation and nested fills reset ANSI colors; restore this region's fill.
    return this.theme.bg(
      color,
      text
        .replaceAll("\x1b[0m", `\x1b[0m${background}`)
        .replaceAll("\x1b[49m", background),
    );
  }

  private wrapped(text: string, width: number): string[] {
    // Provider text is data: terminal control sequences must never reach the renderer.
    return new Text(
      selectorText(text).replace(/[^\P{Cc}\n]/gu, " "),
      0,
      0,
    ).render(Math.max(1, width));
  }

  private details(width: number): DetailLine[] {
    const row = this.row;
    if (row === undefined)
      return [
        "No tasks yet",
        "",
        ...this.wrapped(
          this.source.emptyHint ?? "Tasks added in Beads will appear here.",
          width,
        ),
      ].map((text) => ({ text }));
    const task = row.task;
    const lines: DetailLine[] = [];
    const text = (value: string) => {
      if (value.length === 0) {
        lines.push({ text: "" });
        return;
      }
      for (const line of this.wrapped(value, width)) lines.push({ text: line });
    };
    const link = (label: string, id: string) => {
      const title =
        this.snapshot.tasks.find((item) => item.id === id)?.title ??
        `Outside this result · ${id}`;
      const action: Action = { kind: "link", id };
      const wrapped = this.wrapped(
        `${label} ${plain(title)}`,
        Math.max(1, width - 2),
      );
      for (const [index, line] of wrapped.entries()) {
        lines.push({
          text: `${index === 0 ? "↗ " : "  "}${line}`,
          ...(index === 0 ? { action } : {}),
        });
      }
    };
    const disclosure = (section: string, title: string, content: string) => {
      const open = this.expanded.has(`${task.id}:${section}`);
      lines.push({
        text: `${open ? "▾" : "▸"} ${title}`,
        action: { kind: "disclosure", section },
      });
      if (open) text(content);
    };
    for (const line of this.wrapped(plain(task.title), width))
      lines.push({ text: this.theme.bold(line) });
    text("");
    text(taskNarrative(task, this.snapshot));
    const finding = currentReviewFinding(task, this.snapshot);
    if (finding !== undefined) {
      text("");
      text(`The reviewer found: ${finding}`);
    }
    if (row.warning !== undefined) text(row.warning);
    const links = taskLinks(task, this.snapshot.tasks);
    text("");
    if (links.parent !== undefined) link("Part of", links.parent.id);
    for (const id of links.uses) link("Uses", id);
    for (const id of links.feeds) link("Feeds", id);
    if (
      links.parent !== undefined ||
      links.uses.length + links.feeds.length > 0
    )
      text("");
    disclosure(
      "brief",
      "Brief & acceptance",
      [
        task.description ?? "No description recorded.",
        "",
        "Acceptance",
        task.acceptance_criteria ?? "No acceptance criteria recorded.",
      ].join("\n"),
    );
    disclosure(
      "evidence",
      "Execution evidence",
      retainedEvidence(task, this.snapshot),
    );
    disclosure(
      "identity",
      "Identity",
      [
        task.id,
        `Source: ${this.source.identity}`,
        `Beads value: ${task.status}`,
        ...(task.assignee === undefined ? [] : [`Owner: ${task.assignee}`]),
      ].join("\n"),
    );
    if (this.snapshot.focusable.has(task.id))
      lines.push({
        text: "↗ Focus worker pane",
        action: { kind: "pane", id: task.id },
      });
    return lines;
  }

  render(width: number): string[] {
    const height = Math.max(1, Math.min(24, this.height()));
    if (width < 1) return [];
    if (width < 3 || height < 6)
      return this.wrapped(this.row?.task.title ?? "No tasks yet", width)
        .slice(0, height)
        .map((line) => this.paint("userMessageBg", this.pad(line, width)));
    const inner = Math.max(1, width - 2);
    const split = width >= 76 && this.rows.length > 0;
    const treeWidth = split ? Math.min(31, Math.floor(inner * 0.41)) : inner;
    const detailWidth = split ? Math.max(1, inner - treeWidth - 3) : inner;
    this.bodyHeight = height - 5;
    const rowIndex = this.rows.findIndex(
      (row) => row.task.id === this.selected,
    );
    this.treeOffset = Math.max(
      0,
      Math.min(
        this.treeOffset,
        Math.max(0, this.rows.length - this.bodyHeight),
      ),
    );
    if (rowIndex < this.treeOffset) this.treeOffset = Math.max(0, rowIndex);
    if (rowIndex >= this.treeOffset + this.bodyHeight)
      this.treeOffset = rowIndex - this.bodyHeight + 1;
    const tree = this.rows
      .slice(this.treeOffset, this.treeOffset + this.bodyHeight)
      .map((row) => {
        const selected = row.task.id === this.selected;
        const glyph = needsAttention(row.task, this.snapshot)
          ? this.theme.fg("error", "!")
          : taskStatusGlyph(row.task.status, this.theme);
        const branch = this.theme.fg("muted", row.branch ?? "");
        const label = `${selected ? "›" : " "} ${branch}${glyph} ${plain(row.task.title)}${row.warning === undefined ? "" : " ⚠"}`;
        const padded = this.pad(label, treeWidth);
        return selected ? this.paint("selectedBg", padded) : padded;
      });
    const details = this.details(detailWidth);
    this.actions = details.flatMap((line, index) =>
      line.action === undefined ? [] : [{ action: line.action, line: index }],
    );
    this.maximum = Math.max(0, details.length - this.bodyHeight);
    const offset = Math.min(
      this.maximum,
      this.offsets.get(this.selected ?? "") ?? 0,
    );
    this.offsets.set(this.selected ?? "", offset);
    const detail = details
      .slice(offset, offset + this.bodyHeight)
      .map((line, index) => {
        const actionIndex = this.actions.findIndex(
          (item) => item.line === offset + index,
        );
        const label =
          line.action === undefined
            ? line.text
            : this.theme.fg("accent", line.text);
        return this.focus === "inspector" &&
          actionIndex >= 0 &&
          actionIndex === this.activeAction
          ? this.paint("selectedBg", this.pad(label, detailWidth))
          : this.pad(label, detailWidth);
      });
    const body = Array.from({ length: this.bodyHeight }, (_, index) =>
      split
        ? `${tree[index] ?? " ".repeat(treeWidth)}${this.theme.fg("borderMuted", " │ ")}${detail[index] ?? " ".repeat(detailWidth)}`
        : ((this.focus === "tree" && this.rows.length > 0
            ? tree[index]
            : detail[index]) ?? ""),
    );
    const hint =
      this.focus === "tree"
        ? "j/k move  Enter inspect  r refresh  Esc close"
        : "j/k scroll  Tab links  Enter open  Esc back";
    const context =
      this.notice.length > 0
        ? this.notice
        : `${String(Math.max(0, rowIndex + 1))}/${String(this.rows.length)}${this.snapshot.limitReached ? " · first 1000 shown" : ""}${this.focus === "inspector" && this.maximum > 0 ? ` · ${String(offset + 1)}/${String(this.maximum + 1)}` : ""}`;
    const heading = `${this.focus === "inspector" && !split ? "‹ Tasks" : "Tasks"} · ${plain(this.source.label)}`;
    const clock = this.busy ? "Reading…" : this.snapshot.observedAt;
    const header =
      this.pad(
        this.theme.bold(heading),
        Math.max(1, inner - visibleWidth(clock) - 2),
      ) +
      "  " +
      this.theme.fg("muted", clock);
    return [
      header,
      this.theme.fg("borderMuted", "─".repeat(inner)),
      ...body,
      this.theme.fg("borderMuted", "─".repeat(inner)),
      this.theme.fg("muted", context),
      this.theme.fg("muted", hint),
    ].map((line) => this.paint("userMessageBg", ` ${this.pad(line, inner)} `));
  }

  private update(snapshot: TaskSnapshot): void {
    const index = this.rows.findIndex((row) => row.task.id === this.selected);
    const rows = taskTree(snapshot.tasks);
    this.snapshot = snapshot;
    this.rows = rows;
    if (!rows.some((row) => row.task.id === this.selected))
      this.selected =
        rows[Math.max(0, Math.min(index, rows.length - 1))]?.task.id;
    this.activeAction = -1;
  }

  private run(operation: () => Promise<void>): void {
    if (this.busy) return;
    this.busy = true;
    this.notice = "";
    operation().then(
      () => {
        this.busy = false;
        if (!this.closed) this.changed();
      },
      (error: unknown) => {
        this.busy = false;
        this.notice = plain(
          error instanceof Error ? error.message : String(error),
        );
        if (!this.closed) this.changed();
      },
    );
  }

  private inspect(id: string): void {
    if (this.busy) return;
    const origin = this.selected;
    this.focus = "inspector";
    this.activeAction = -1;
    this.run(async () => {
      const task = await this.source.show(id);
      if (task.id !== id)
        throw new Error("Beads returned a different task identity");
      if (this.closed) return;
      const previous = this.snapshot.tasks.find((item) => item.id === id);
      const merged = {
        ...previous,
        ...task,
        ...(task.dependencies === undefined &&
        previous?.dependencies !== undefined
          ? { dependencies: previous.dependencies }
          : {}),
      };
      const tasks =
        previous === undefined
          ? [...this.snapshot.tasks, merged]
          : this.snapshot.tasks.map((item) => (item.id === id ? merged : item));
      this.update({ ...this.snapshot, tasks });
      if (this.focus === "inspector" && this.selected === origin)
        this.selected = id;
    });
  }

  handleInput(input: string): void {
    if (
      matchesKey(input, NavigationKey.Cancel) ||
      (matchesKey(input, NavigationKey.Escape) && this.focus === "tree")
    ) {
      this.closed = true;
      this.done(undefined);
      return;
    }
    if (
      matchesKey(input, NavigationKey.Escape) ||
      matchesKey(input, NavigationKey.Left)
    ) {
      this.focus = "tree";
      this.activeAction = -1;
    } else if (matchesKey(input, NavigationKey.Refresh)) {
      this.run(async () => {
        this.update(await this.source.load());
      });
    } else if (
      matchesKey(input, NavigationKey.Tab) ||
      matchesKey(input, NavigationKey.PreviousTab)
    ) {
      this.focus = "inspector";
      const count = this.actions.length;
      if (count > 0) {
        this.activeAction =
          this.activeAction < 0
            ? matchesKey(input, NavigationKey.PreviousTab)
              ? count - 1
              : 0
            : (this.activeAction +
                (matchesKey(input, NavigationKey.PreviousTab)
                  ? count - 1
                  : 1)) %
              count;
        const line = this.actions[this.activeAction]?.line ?? 0;
        const offset = this.offsets.get(this.selected ?? "") ?? 0;
        this.offsets.set(
          this.selected ?? "",
          line < offset
            ? line
            : line >= offset + this.bodyHeight
              ? line - this.bodyHeight + 1
              : offset,
        );
      }
    } else if (matchesKey(input, NavigationKey.Enter)) {
      const action = this.actions[this.activeAction]?.action;
      if (this.focus === "tree" && this.selected !== undefined)
        this.inspect(this.selected);
      else if (action?.kind === "disclosure" && this.selected !== undefined) {
        const key = `${this.selected}:${action.section}`;
        if (this.expanded.has(key)) this.expanded.delete(key);
        else this.expanded.add(key);
      } else if (action?.kind === "pane") {
        this.closed = true;
        this.done(action.id);
      } else if (action?.kind === "link") {
        this.inspect(action.id);
      } else if (this.actions.length > 0) this.activeAction = 0;
    } else if (
      matchesKey(input, NavigationKey.Right) &&
      this.selected !== undefined &&
      this.snapshot.focusable.has(this.selected)
    ) {
      this.closed = true;
      this.done(this.selected);
    } else {
      const direction =
        matchesKey(input, NavigationKey.VimDown) ||
        matchesKey(input, NavigationKey.Down)
          ? 1
          : matchesKey(input, NavigationKey.VimUp) ||
              matchesKey(input, NavigationKey.Up)
            ? -1
            : 0;
      if (direction !== 0 && this.focus === "tree") {
        const index = this.rows.findIndex(
          (row) => row.task.id === this.selected,
        );
        this.selected =
          this.rows[
            Math.max(0, Math.min(this.rows.length - 1, index + direction))
          ]?.task.id;
        this.activeAction = -1;
      } else if (direction !== 0) {
        const id = this.selected ?? "";
        this.offsets.set(
          id,
          Math.max(
            0,
            Math.min(this.maximum, (this.offsets.get(id) ?? 0) + direction),
          ),
        );
        this.activeAction = -1;
      }
    }
    this.changed();
  }
}

export async function browseTasks(
  ctx: ExtensionContext,
  source: BrowserSource,
  initialId?: string,
): Promise<string | undefined> {
  const snapshot = await source.load();
  if (initialId !== undefined) {
    const task = await source.show(initialId);
    if (task.id !== initialId)
      throw new Error("Beads returned a different task identity");
    const previous = snapshot.tasks.find((item) => item.id === initialId);
    const merged = {
      ...previous,
      ...task,
      ...(task.dependencies === undefined &&
      previous?.dependencies !== undefined
        ? { dependencies: previous.dependencies }
        : {}),
    };
    snapshot.tasks =
      previous === undefined
        ? [...snapshot.tasks, merged]
        : snapshot.tasks.map((item) => (item.id === initialId ? merged : item));
  }
  return ctx.ui.custom<string | undefined>(
    (tui, theme, _keys, done) =>
      new TaskBrowser(
        snapshot,
        source,
        theme,
        () => tui.terminal.rows,
        () => {
          tui.requestRender();
        },
        done,
        initialId,
      ),
    { overlay: true, overlayOptions: { width: 80, maxHeight: 24, margin: 0 } },
  );
}
