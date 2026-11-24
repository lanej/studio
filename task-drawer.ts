import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { selectorText } from "@lanej/pi-components";
import {
  knownTaskStatus,
  parentId,
  TaskStatus,
  taskReviewLabel,
  type TaskReview,
  type TreeRow,
} from "./beads.ts";
import { NavigationKey } from "./runtime.ts";

export interface TaskDrawerItem {
  row: TreeRow;
  review?: TaskReview | undefined;
  canFocus: boolean;
}

type DrawerTheme = Pick<Theme, "fg" | "bg" | "bold">;

interface DrawerOptions {
  items: readonly TaskDrawerItem[];
  project: string;
  detailOnly?: boolean;
  limitReached: boolean;
  theme: DrawerTheme;
  height: () => number;
  onInspect: (index: number) => void;
  onFocus: (index: number) => void;
  onCancel: () => void;
  requestRender: () => void;
}

interface Status {
  label: string;
  glyph: string;
  tone: ThemeColor;
}

const statuses: Record<TaskStatus, Status> = {
  [TaskStatus.Open]: { label: "Open", glyph: "○", tone: "muted" },
  [TaskStatus.InProgress]: { label: "In progress", glyph: "◐", tone: "accent" },
  [TaskStatus.Blocked]: { label: "Blocked", glyph: "×", tone: "error" },
  [TaskStatus.Deferred]: { label: "Deferred", glyph: "–", tone: "muted" },
  [TaskStatus.Closed]: { label: "Closed", glyph: "●", tone: "success" },
};

const oneLine = (value: string) =>
  selectorText(value).replace(/\s+/gu, " ").trim();

function displayStatus({ review, row }: TaskDrawerItem): Status {
  if (review !== undefined)
    return {
      label: taskReviewLabel(review),
      glyph: review.finding === undefined ? "◐" : "◆",
      tone: review.finding === undefined ? "accent" : "warning",
    };
  const status = knownTaskStatus(row.task.status);
  return status === undefined
    ? { label: oneLine(row.task.status), glyph: "?", tone: "muted" }
    : statuses[status];
}

/** Reserve the right edge before shortening the title, including wide glyphs. */
function columns(left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right);
  if (rightWidth === 0 || rightWidth + 2 >= width)
    return truncateToWidth(left, width, "…");
  const title = truncateToWidth(left, width - rightWidth - 2, "…");
  return title + " ".repeat(width - visibleWidth(title) - rightWidth) + right;
}

function taskBody(
  item: TaskDrawerItem,
  theme: DrawerTheme,
  width: number,
  view: "preview" | "detail",
  project: string,
): string[] {
  const { task, warning } = item.row;
  const id = theme.fg("muted", oneLine(task.id));
  const sections: string[][] = [];
  const section = (
    heading: string,
    body: string | undefined,
    kind: "context" | "finding" | "warning" = "context",
  ) => {
    if (body === undefined) return;
    const clean = selectorText(body).trim().replaceAll("\t", "    ");
    if (clean.length === 0) return;
    const label = theme.bold(
      theme.fg(kind === "context" ? "muted" : "warning", heading),
    );
    const marked = clean.replace(/`([^`\n]+)`/gu, (_match, code: string) =>
      theme.fg("accent", code),
    );
    const rail =
      kind === "finding" && width >= 8 ? `${theme.fg("warning", "▏")} ` : "";
    const bodyLines = wrapTextWithAnsi(
      theme.fg("text", marked),
      width - visibleWidth(rail),
    );
    sections.push([
      columns(
        label,
        sections.length === 0 && view === "preview" ? id : "",
        width,
      ),
      ...bodyLines.map((line) => rail + line),
    ]);
  };
  section("Review finding", item.review?.finding, "finding");
  if (view === "detail" || item.review?.finding === undefined)
    section("Scope", task.description);
  section("Acceptance criteria", task.acceptance_criteria);
  section("Task relationship", warning, "warning");
  if (view === "detail") {
    section("Parent", parentId(task));
    const blockers = task.dependencies
      ?.filter((edge) => edge.dependency_type === "blocks")
      .map((edge) => edge.id);
    section("Blocked by", blockers?.join(", "));
    section("Project", project);
  }
  if (sections.length === 0) return [id];
  return sections.flatMap((rows, index) =>
    index === 0 ? rows : ["", ...rows],
  );
}

export function createTaskDrawer(options: DrawerOptions) {
  const { items, theme } = options;
  const states = items.map(displayStatus);
  let index = 0;
  let scroll = 0;
  let scrollLimit = 0;
  let page = 1;

  function rowLine(
    item: TaskDrawerItem,
    state: Status,
    selected: boolean,
    width: number,
  ) {
    const edge = selected ? theme.fg("accent", "▌") : " ";
    const branch = theme.fg("border", item.row.branch ?? "");
    const title = oneLine(item.row.task.title);
    const text = selected
      ? theme.bold(theme.fg("toolTitle", title))
      : theme.fg("text", title);
    const status = theme.fg(
      state.tone,
      width >= 30 ? `${state.glyph} ${state.label}` : state.glyph,
    );
    const warning =
      item.row.warning === undefined ? "" : theme.fg("warning", " !");
    return columns(`${edge} ${branch}${text}${warning}`, status, width);
  }

  return {
    invalidate() {},
    render(width: number) {
      if (width < 1) return [];
      const frame = width >= 15 && options.height() >= 8;
      const height = Math.max(1, options.height() - (frame ? 2 : 0));
      const surfaceWidth = width - (frame ? 2 : 0);
      const inset = surfaceWidth >= 15 ? 1 : 0;
      const inner = surfaceWidth - inset * 2;
      const pad = " ".repeat(inset);
      const edge = frame ? theme.fg("border", "│") : "";
      const selected = items[index];
      const state = states[index];
      if (selected === undefined || state === undefined) return [];
      const lines: string[] = [];
      let highlighted = -1;
      const divider = theme.fg("border", "─".repeat(inner));
      if (options.detailOnly === true) {
        const title = theme.bold(
          theme.fg("toolTitle", oneLine(selected.row.task.title)),
        );
        const body = [
          ...wrapTextWithAnsi(title, inner),
          divider,
          ...taskBody(selected, theme, inner, "detail", options.project),
        ];
        if (!frame && height >= 8) lines.push("");
        if (height >= 3)
          lines.push(
            columns(
              theme.fg("muted", oneLine(selected.row.task.id)),
              theme.fg(state.tone, `${state.glyph} ${state.label}`),
              inner,
            ),
          );
        page = Math.max(1, height - lines.length - (height >= 4 ? 1 : 0));
        scrollLimit = Math.max(0, body.length - page);
        scroll = Math.min(scroll, scrollLimit);
        lines.push(...body.slice(scroll, scroll + page));
        if (scrollLimit > 0 && height >= 4) {
          const range = `${String(scroll + 1)}–${String(Math.min(scroll + page, body.length))} of ${String(body.length)}`;
          lines.push(
            columns(
              theme.fg("muted", "↑↓ Scroll"),
              theme.fg("muted", range),
              inner,
            ),
          );
        }
      } else {
        const count = String(items.length) + (options.limitReached ? "+" : "");
        if (!frame && height >= 8) lines.push("");
        if (height >= 3)
          lines.push(
            columns(
              theme.bold(theme.fg("toolTitle", "Tasks")),
              theme.fg("muted", count),
              inner,
            ),
          );
        if (height >= 8) lines.push("");
        const rows = Math.min(
          items.length,
          Math.max(1, Math.min(9, Math.floor(height / 3))),
        );
        const first = Math.max(
          0,
          Math.min(index - Math.floor(rows / 2), items.length - rows),
        );
        highlighted = lines.length + index - first;
        for (let i = first; i < first + rows; i++) {
          const item = items[i];
          const status = states[i];
          if (item !== undefined && status !== undefined)
            lines.push(rowLine(item, status, i === index, inner));
        }
        if (height >= 10) lines.push("");
        lines.push(divider);
        if (height >= 10) lines.push("");
        const body = taskBody(
          selected,
          theme,
          inner,
          "preview",
          options.project,
        );
        const remaining = Math.max(0, height - lines.length - 2);
        lines.push(...body.slice(0, remaining));
        const actions = [];
        if (body.length > remaining) {
          const confirm = getKeybindings().getKeys("tui.select.confirm")[0];
          if (confirm !== undefined)
            actions.push(
              `${confirm === "enter" ? "Enter" : confirm} View details`,
            );
        }
        if (selected.canFocus) actions.push("→ Focus pane");
        if (actions.length > 0)
          lines.push(theme.fg("muted", actions.join("    ")));
      }
      const painted = lines
        .slice(0, height)
        .map(
          (line, i) =>
            edge +
            theme.bg(
              i === highlighted ? "selectedBg" : "userMessageBg",
              truncateToWidth(pad + line, surfaceWidth, "…", true),
            ) +
            edge,
        );
      if (!frame) return painted;
      const rule = "─".repeat(surfaceWidth);
      return [
        theme.fg("border", `╭${rule}╮`),
        ...painted,
        theme.fg("border", `╰${rule}╯`),
      ];
    },
    handleInput(input: string) {
      const bindings = getKeybindings();
      if (bindings.matches(input, "tui.select.cancel")) {
        options.onCancel();
        return;
      }
      if (bindings.matches(input, "tui.select.confirm")) {
        if (options.detailOnly === true) options.onCancel();
        else if (items[index] !== undefined) options.onInspect(index);
        return;
      }
      if (
        options.detailOnly !== true &&
        matchesKey(input, NavigationKey.Right) &&
        items[index]?.canFocus === true
      ) {
        options.onFocus(index);
        return;
      }
      const down =
        bindings.matches(input, "tui.select.down") ||
        matchesKey(input, NavigationKey.VimDown);
      const up =
        bindings.matches(input, "tui.select.up") ||
        matchesKey(input, NavigationKey.VimUp);
      if (options.detailOnly === true) {
        if (down || matchesKey(input, "pageDown"))
          scroll = Math.min(scrollLimit, scroll + (down ? 1 : page));
        else if (up || matchesKey(input, "pageUp"))
          scroll = Math.max(0, scroll - (up ? 1 : page));
      } else if ((down || up) && items.length > 0)
        index = (index + (down ? 1 : -1) + items.length) % items.length;
      options.requestRender();
    },
  };
}
