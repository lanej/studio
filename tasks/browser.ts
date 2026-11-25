import type { Theme, ThemeBg } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  hyperlink,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { taskTree, type Task, type TreeRow } from "../beads.ts";
import { NavigationKey } from "../runtime.ts";
import { selectorText } from "@lanej/pi-components";
import { githubLink } from "../github-links.ts";
import { taskStatusGlyph } from "../ui.ts";
import {
  currentReviewFinding,
  needsAttention,
  ownedAttempt,
  parkedDetails,
  plain,
  retainedEvidence,
  taskLinks,
  taskNarrative,
  taskDelivery,
  type TaskSnapshot,
} from "./model.ts";

export interface BrowserSource {
  label: string;
  identity: string;
  emptyHint?: string;
  load: () => Promise<TaskSnapshot>;
  show: (id: string) => Promise<Task>;
  retry?: (id: string) => Promise<void>;
  diff?: (
    attempt: import("../execution/store.ts").Execution,
  ) => Promise<string>;
}
interface PanelControls {
  focused: () => boolean;
  leave: () => void;
}
type Action =
  | { kind: "link"; id: string }
  | { kind: "disclosure"; section: string }
  | { kind: "retry"; id: string }
  | { kind: "diff"; id: string }
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
  private restoreAction: Action | undefined;
  private maximum = 0;
  private bodyHeight = 1;
  private busy = false;
  private notice = "";
  private readonly diffs = new Map<
    string,
    { evidence: string; text: string; capturedAt: string }
  >();
  private readonly diffRequests = new Map<string, number>();

  private closed = false;
  private pendingInspection:
    | { id: string; origin: string | undefined }
    | undefined;

  constructor(
    private snapshot: TaskSnapshot,
    private readonly source: BrowserSource,
    private readonly theme: Pick<Theme, "fg" | "bg" | "bold" | "getBgAnsi">,
    private readonly height: () => number,
    private readonly changed: () => void,
    private readonly done: (paneTask: string | undefined) => void,
    initialId?: string,
    private readonly panel?: PanelControls,
  ) {
    this.rows = taskTree(snapshot.tasks);
    this.selected = initialId ?? this.rows[0]?.task.id;
    this.focus = initialId === undefined ? "tree" : "inspector";
  }

  private diffEvidence(
    attempt: import("../execution/store.ts").Execution,
  ): string {
    // Lease renewal does not change the retained checkout or its execution evidence.
    return JSON.stringify({ ...attempt, heartbeatAt: undefined });
  }

  private clearDiff(id: string): number {
    this.diffs.delete(id);
    const request = (this.diffRequests.get(id) ?? 0) + 1;
    this.diffRequests.set(id, request);
    return request;
  }

  invalidate(): void {}

  dispose(): void {
    this.closed = true;
  }

  private isOpen(): boolean {
    return !this.closed;
  }

  private report(error: unknown): void {
    this.notice = plain(error instanceof Error ? error.message : String(error));
    if (this.isOpen()) this.changed();
  }

  async refresh(): Promise<void> {
    await this.run(async () => {
      const selected = this.selected;
      const inspecting = this.focus === "inspector";
      let snapshot = await this.source.load();
      if (this.closed) return;
      if (
        selected !== undefined &&
        (inspecting ||
          (snapshot.limitReached &&
            !snapshot.tasks.some((task) => task.id === selected)))
      ) {
        const task = await this.source.show(selected);
        if (task.id !== selected)
          throw new Error("Beads returned a different task identity");
        snapshot = withTask(
          snapshot,
          task,
          this.snapshot.tasks.find((item) => item.id === selected)
            ?.dependencies,
        );
      }
      if (this.isOpen()) this.update(snapshot);
    });
  }

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
    const disclosure = (
      section: string,
      title: string,
      content: string,
      url?: string,
    ) => {
      const open = this.expanded.has(`${task.id}:${section}`);
      lines.push({
        text: `${open ? "▾" : "▸"} ${title}`,
        action: { kind: "disclosure", section },
      });
      if (open && url !== undefined) {
        const safe = selectorText(content).replace(/[^\P{Cc}\n]/gu, " ");
        const linked = safe.replace(
          url,
          githubLink(url) ?? hyperlink(url, url),
        );
        for (const line of new Text(linked, 0, 0).render(Math.max(1, width)))
          lines.push({ text: line });
      } else if (open) text(content);
    };
    for (const line of this.wrapped(plain(task.title), width))
      lines.push({ text: this.theme.bold(line) });
    text("");
    text(taskNarrative(task, this.snapshot));
    const parked = parkedDetails(task, this.snapshot);
    const owned = ownedAttempt(task, this.snapshot);
    if (parked !== undefined && owned !== undefined) {
      text("");
      text(parked);
      if (owned.checkout === undefined || owned.base === undefined)
        text("Retained diff unavailable: checkout or base receipt missing.");
      else if (this.source.diff === undefined)
        text(
          "Retained diff unavailable: the runtime project is not configured for this source.",
        );
      else {
        lines.push({
          text: "↗ Open retained diff",
          action: { kind: "diff", id: owned.id },
        });
        const diff = this.diffs.get(owned.id);
        if (diff !== undefined) {
          text(
            `Captured diff snapshot · ${diff.capturedAt}. Re-open retained diff to refresh after checkout edits; this view is not live.`,
          );
          text(diff.text);
        }
      }
      if (owned.interactive !== undefined)
        text(
          "Retry unavailable: interactive attempts retain their original pane binding; automatic replacement is unavailable.",
        );
      else if (this.snapshot.retryBlocked?.has(owned.id) === true)
        text(
          `Retry unavailable: ${this.snapshot.retryBlocked.get(owned.id) ?? "writer state unavailable"}`,
        );
      else if (owned.bead === undefined || owned.revision === undefined)
        text("Retry unavailable: admission receipt missing.");
      else if (
        this.source.retry !== undefined &&
        ["needs-review", "uncertain"].includes(owned.phase)
      ) {
        text(
          "Retry starts or resumes the configured runtime scheduler, including other ready work.",
        );
        lines.push({
          text: "↗ Retry attempt (guards checked on invocation)",
          action: { kind: "retry", id: owned.id },
        });
      } else text("Retry unavailable in this state.");
    }
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
    const delivery = taskDelivery(task, this.snapshot);
    disclosure(
      "delivery",
      delivery.label,
      delivery.details.join("\n"),
      delivery.url,
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
    if (this.restoreAction !== undefined) {
      const target = this.restoreAction;
      this.activeAction = this.actions.findIndex(
        ({ action }) =>
          action.kind === target.kind &&
          (action.kind === "disclosure" && target.kind === "disclosure"
            ? action.section === target.section
            : action.kind !== "disclosure" &&
              target.kind !== "disclosure" &&
              action.id === target.id),
      );
      this.restoreAction = undefined;
    }
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
          ? this.paint("selectedBg", this.pad(`› ${label}`, detailWidth))
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
      this.panel !== undefined && !this.panel.focused()
        ? "Alt+T inspect  /tasks close"
        : this.focus === "tree"
          ? this.panel === undefined
            ? "j/k move  Enter inspect  r refresh  Esc close"
            : "j/k move  Enter inspect  Esc lead  q close"
          : this.panel === undefined
            ? "j/k scroll  Tab links  Enter open  Esc back"
            : "j/k scroll  Tab links  ← tree  Esc lead";
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
    for (const [id, cached] of this.diffs) {
      const attempt = snapshot.attempts.find((row) => row.id === id);
      if (
        attempt === undefined ||
        cached.evidence !== this.diffEvidence(attempt)
      )
        this.clearDiff(id);
    }
    const selected = this.selected;
    this.restoreAction = this.actions[this.activeAction]?.action;
    const index = this.rows.findIndex((row) => row.task.id === this.selected);
    const rows = taskTree(snapshot.tasks);
    this.snapshot = snapshot;
    this.rows = rows;
    if (!rows.some((row) => row.task.id === this.selected))
      this.selected =
        rows[Math.max(0, Math.min(index, rows.length - 1))]?.task.id;
    if (this.selected !== selected) {
      this.activeAction = -1;
      this.restoreAction = undefined;
    }
  }

  private async run(operation: () => Promise<void>): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    this.notice = "";
    try {
      await operation();
    } catch (error) {
      this.notice = plain(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.busy = false;
      if (this.isOpen()) {
        const pending = this.pendingInspection;
        this.pendingInspection = undefined;
        if (
          pending !== undefined &&
          this.focus === "inspector" &&
          this.selected === pending.origin
        )
          this.inspect(pending.id);
        this.changed();
      }
    }
  }

  private inspect(id: string): void {
    if (this.busy && this.panel === undefined) return;
    const origin = this.selected;
    this.focus = "inspector";
    this.activeAction = -1;
    if (this.busy) {
      this.pendingInspection = { id, origin };
      return;
    }
    this.run(async () => {
      const task = await this.source.show(id);
      if (task.id !== id)
        throw new Error("Beads returned a different task identity");
      if (this.closed) return;
      this.update(withTask(this.snapshot, task));
      if (this.focus === "inspector" && this.selected === origin)
        this.selected = id;
    }).catch((error: unknown) => {
      this.report(error);
    });
  }

  handleInput(input: string): void {
    if (this.closed) return;
    if (this.panel !== undefined) {
      if (
        matchesKey(input, NavigationKey.Escape) ||
        matchesKey(input, NavigationKey.Cancel) ||
        matchesKey(input, "alt+t")
      ) {
        this.panel.leave();
        return;
      }
      if (input === "q") {
        this.done(undefined);
        return;
      }
    }
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
      this.refresh().catch((error: unknown) => {
        this.report(error);
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
        if (this.panel === undefined) this.closed = true;
        this.done(action.id);
      } else if (action?.kind === "link") {
        this.inspect(action.id);
      } else if (action?.kind === "retry" && this.source.retry !== undefined) {
        const retry = this.source.retry;
        this.clearDiff(action.id);
        this.run(async () => {
          await retry(action.id);
          this.update(await this.source.load());
          this.notice =
            "Retry queued; verification and review remain required.";
        }).catch((error: unknown) => {
          this.report(error);
        });
      } else if (action?.kind === "diff" && this.source.diff !== undefined) {
        const attempt = this.snapshot.attempts.find(
          (item) => item.id === action.id,
        );
        const diff = this.source.diff;
        if (attempt !== undefined) {
          const request = this.clearDiff(attempt.id);
          const evidence = this.diffEvidence(attempt);
          this.run(async () => {
            const result = await diff(attempt);
            const current = this.snapshot.attempts.find(
              (row) => row.id === attempt.id,
            );
            if (
              this.diffRequests.get(attempt.id) === request &&
              current !== undefined &&
              this.diffEvidence(current) === evidence
            )
              this.diffs.set(attempt.id, {
                evidence,
                capturedAt: new Date().toLocaleTimeString(),
                text:
                  result.length > 0
                    ? result
                    : "No retained changes in the tracked diff.",
              });
          }).catch((error: unknown) => {
            this.report(error);
          });
        }
      } else if (this.actions.length > 0) this.activeAction = 0;
    } else if (
      matchesKey(input, NavigationKey.Right) &&
      this.selected !== undefined &&
      this.snapshot.focusable.has(this.selected)
    ) {
      if (this.panel === undefined) this.closed = true;
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

export async function loadTaskSnapshot(
  source: BrowserSource,
  initialId?: string,
): Promise<TaskSnapshot> {
  const snapshot = await source.load();
  if (initialId !== undefined) {
    const task = await source.show(initialId);
    if (task.id !== initialId)
      throw new Error("Beads returned a different task identity");
    return withTask(snapshot, task);
  }
  return snapshot;
}

function withTask(
  snapshot: TaskSnapshot,
  task: Task,
  knownDependencies?: Task["dependencies"],
): TaskSnapshot {
  const previous = snapshot.tasks.find((item) => item.id === task.id);
  const dependencies = previous?.dependencies ?? knownDependencies;
  const merged = {
    ...previous,
    ...task,
    ...(task.dependencies === undefined && dependencies !== undefined
      ? { dependencies }
      : {}),
  };
  return {
    ...snapshot,
    tasks:
      previous === undefined
        ? [...snapshot.tasks, merged]
        : snapshot.tasks.map((item) => (item.id === task.id ? merged : item)),
  };
}
