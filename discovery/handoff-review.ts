import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { selectorText } from "@lanej/pi-components";
import {
  orderedTasks,
  publicationGroups,
  taskReviewFields,
  TaskDelivery,
  type LeadDraft,
  type PlanWorkers,
} from "../lead-plan.ts";
import { reviewContextValue } from "../plan-review.ts";
import { specText, type LeadSpecification } from "../socrates/spec.ts";
import { handoffOverview } from "./handoff-overview.ts";

interface HandoffReview {
  title: string;
  draft: LeadDraft;
  specification?: LeadSpecification | undefined;
  project: string;
  sourceId: string;
  profile: string;
  execution: string;
  workers?: PlanWorkers | undefined;
}

type ReviewTheme = Pick<Theme, "fg" | "bg" | "bold">;
const sections = ["Overview", "Specification", "Bead details"] as const;

function beadDetails(
  draft: LeadDraft,
  theme: ReviewTheme,
  width: number,
  workers?: PlanWorkers,
): string[] {
  const groups = publicationGroups(draft);
  const tasks = orderedTasks(draft).flatMap((task) => {
    const memberships = groups.filter(({ local }) =>
      local.some(({ key }) => key === task.key),
    );
    const delivery =
      task.delivery === TaskDelivery.PullRequest
        ? "Opens a PR"
        : memberships.length > 0
          ? "Included in PR · " +
            memberships.map(({ publisher }) => publisher.key).join(", ")
          : "Stays local";
    const fields = taskReviewFields(
      task,
      "execution",
      delivery,
      workers?.[task.key],
    );
    return [
      "",
      ...wrapTextWithAnsi(
        theme.bold(selectorText(task.title)) +
          "  " +
          theme.fg("muted", selectorText(task.key)),
        width,
      ),
      ...wrapTextWithAnsi(selectorText(task.description), width),
      ...fields.flatMap(({ label, value }) =>
        wrapTextWithAnsi(
          theme.fg("muted", label + "  ") + selectorText(value),
          width,
        ),
      ),
    ];
  });
  return [...wrapTextWithAnsi(selectorText(draft.summary), width), ...tasks];
}

type ReviewSection = (typeof sections)[number];

function sectionLines(
  sectionName: ReviewSection,
  input: HandoffReview,
  theme: ReviewTheme,
  inner: number,
): string[] {
  switch (sectionName) {
    case "Overview":
      return [
        ...handoffOverview(theme, inner, input.draft, input.specification),
        "",
        ...wrapTextWithAnsi(
          theme.fg("muted", "Execution  ") +
            reviewContextValue(input.execution) +
            "   " +
            theme.fg("muted", "Profile  ") +
            reviewContextValue(input.profile),
          inner,
        ),
        ...wrapTextWithAnsi(
          theme.fg("muted", "Project  ") + reviewContextValue(input.project),
          inner,
        ),
        ...wrapTextWithAnsi(
          theme.fg("muted", "Beads  ") + reviewContextValue(input.sourceId),
          inner,
        ),
      ];
    case "Specification":
      return wrapTextWithAnsi(
        selectorText(
          input.specification === undefined
            ? "Recovery of the previously approved handoff"
            : specText(input.specification),
        ),
        inner,
      );
    case "Bead details":
      return beadDetails(input.draft, theme, inner, input.workers);
  }
}

export function createHandoffReview(
  input: HandoffReview,
  theme: ReviewTheme,
  height: () => number,
  finish: (confirmed: boolean) => void,
  requestRender: () => void,
) {
  let section = 0;
  let offset = 0;
  let maximum = 0;
  let page = 1;
  let content:
    | { section: ReviewSection; width: number; lines: string[] }
    | undefined;
  let displayed = false;
  let settled = false;
  const close = (confirmed: boolean) => {
    if (settled) return;
    settled = true;
    finish(confirmed);
  };
  const go = (next: number) => {
    section = next;
    offset = 0;
    displayed = false;
  };

  return {
    invalidate() {
      content = undefined;
      displayed = false;
    },
    render(width: number): string[] {
      const rows = height();
      if (width < 8 || rows < 5) {
        displayed = false;
        return [truncateToWidth("Enlarge pane · Esc cancel", width)];
      }
      const inner = width - 4;
      const frame = (text: string) => theme.fg("border", text);
      const framed = (line: string) =>
        theme.bg(
          "customMessageBg",
          frame("│ ") + truncateToWidth(line, inner, "", true) + frame(" │"),
        );
      const title = truncateToWidth(
        theme.bold(
          "Approve " + selectorText(input.title).replace(/\s+/gu, " "),
        ),
        width - 6,
      );
      const header =
        frame("╭─ ") +
        title +
        frame(" " + "─".repeat(width - 5 - visibleWidth(title)) + "╮");
      const steps = sections
        .map((name, i) =>
          i === section ? theme.bold("▸ " + name) : theme.fg("muted", name),
        )
        .join("   ");
      const sectionName = sections[section] ?? "Overview";
      if (content?.width !== inner || content.section !== sectionName) {
        if (content !== undefined && content.width !== inner) offset = 0;
        content = {
          width: inner,
          section: sectionName,
          lines: sectionLines(sectionName, input, theme, inner),
        };
      }
      const body = content.lines;
      const progress =
        visibleWidth(steps) <= inner
          ? steps
          : theme.bold(sections[section] ?? "");
      const nextSection = sections[section + 1];
      const lastAction =
        nextSection === undefined
          ? "Enter create tasks and implement"
          : "Enter " + nextSection;
      const hints = theme.fg(
        "muted",
        section === 0 ? "  ·  Esc cancel" : "  ·  ← back  ·  Esc cancel",
      );
      const footer = (action: string) =>
        wrapTextWithAnsi(theme.bold(action) + hints, inner);
      const finalFooter = footer(lastAction);
      const moreFooter = footer("Enter more");
      // Both footers share a page height so wrapping the final action cannot
      // move the last evidence row past the furthest reachable scroll offset.
      page = rows - 4 - Math.max(finalFooter.length, moreFooter.length);
      if (page < 1) {
        displayed = false;
        return [truncateToWidth("Enlarge pane · Esc cancel", width)];
      }
      maximum = Math.max(0, body.length - page);
      offset = Math.min(offset, maximum);
      const footerLines = offset === maximum ? finalFooter : moreFooter;
      displayed = true;
      return [
        header,
        framed(progress),
        framed(""),
        ...body.slice(offset, offset + page).map(framed),
        ...footerLines.map(framed),
        frame("╰" + "─".repeat(width - 2) + "╯"),
      ];
    },
    handleInput(input: string) {
      if (settled) return;
      if (matchesKey(input, "escape") || matchesKey(input, "ctrl+c")) {
        close(false);
        return;
      }
      if (!displayed) return;
      if (matchesKey(input, "enter")) {
        if (offset < maximum) offset = Math.min(maximum, offset + page);
        else if (section < sections.length - 1) go(section + 1);
        else {
          close(true);
          return;
        }
      } else if (matchesKey(input, "pageDown"))
        offset = Math.min(maximum, offset + page);
      else if (matchesKey(input, "pageUp")) offset = Math.max(0, offset - page);
      else if (matchesKey(input, "down") || input === "j")
        offset = Math.min(maximum, offset + 1);
      else if (matchesKey(input, "up") || input === "k")
        offset = Math.max(0, offset - 1);
      else if (matchesKey(input, "left") && section > 0) go(section - 1);
      else return;
      displayed = false;
      requestRender();
    },
    dispose() {
      close(false);
    },
  };
}

export function reviewHandoff(
  ctx: ExtensionContext,
  input: HandoffReview,
): Promise<boolean> {
  return ctx.ui.custom<boolean>(
    (tui, theme, _keys, done) =>
      createHandoffReview(
        input,
        theme,
        () => Math.min(36, tui.terminal.rows - 2),
        done,
        () => {
          tui.requestRender();
        },
      ),
    {
      overlay: true,
      blocked: { kind: "permission", message: `Approve ${input.title}` },
      overlayOptions: {
        anchor: "center",
        width: 116,
        margin: { left: 1, right: 1, top: 1, bottom: 1 },
      },
    },
  );
}
