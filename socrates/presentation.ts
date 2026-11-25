import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import {
  ActivityState,
  ConditionState,
  conditionCounts,
  createStatusBoard,
  renderStatusDock,
  type StatusColumn,
  type Activity,
  type Condition,
  type StatusTheme,
} from "@lanej/pi-components";
import {
  coverageFresh,
  coverageProperties,
  draftCoverage,
  type CoverageStatus,
} from "./assessment.ts";
import {
  hasSettledDeliveryPolicy,
  specificationGaps,
  SpecStatus,
} from "./spec.ts";
import { implementationColumn, specificationColumn } from "./columns.ts";
import {
  assessmentRevision,
  implementationPresentation,
  type ImplementationObservation,
  type ImplementationPresentation,
  type ImplementationSource,
} from "./implementation.ts";
import { createPlanInspector } from "./plan-inspector.ts";
import { planGraphColor } from "../plan-graph.ts";
import { renderSocratesSections, renderStatusSidebar } from "./sidebar.ts";
import { createImplementationWatch } from "./implementation-watch.ts";

export interface SocratesObservation extends ImplementationSource {
  id: string;
  label: string;
}

export interface SocratesActivity {
  working: boolean;
  paused: boolean;
  tool?: string | undefined;
}

export interface SocratesPresentation {
  id: string;
  title: string;
  conditions: Condition[];
  activity: Activity;
  summary: string;
  implementation: ImplementationPresentation;
  columns: StatusColumn[];
  dockColumns: StatusColumn[];
  prioritizeSpecification: boolean;
}

const conditionStates = {
  unknown: ConditionState.Unknown,
  satisfied: ConditionState.Satisfied,
  partial: ConditionState.Partial,
  open: ConditionState.Open,
  "not-applicable": ConditionState.NotApplicable,
} satisfies Record<CoverageStatus, ConditionState>;

/** Project saved assessments and observed activity without deciding readiness. */
export function socratesPresentation(
  observation: SocratesObservation,
  live: SocratesActivity,
  beadObservation?: ImplementationObservation,
): SocratesPresentation {
  const { specification: spec, label } = observation;
  const revision = assessmentRevision(observation);
  const implementation = implementationPresentation(
    observation,
    beadObservation,
  );
  if (spec === undefined) {
    const activity = { state: ActivityState.Idle, label: "No specification" };
    const column = specificationColumn(undefined, [], activity, implementation);
    return {
      id: observation.id,
      title: label,
      conditions: [],
      prioritizeSpecification: false,
      activity,
      summary: "",
      implementation,
      columns: [column, implementationColumn(implementation)],
      dockColumns: [column, implementationColumn(implementation, true)],
    };
  }
  const fresh = coverageFresh(spec, revision);
  const properties = coverageProperties(spec.draft);
  const conditions = properties.map(
    (property): Condition => ({
      id: property.id,
      label: property.label,
      state: conditionStates[property.status],
      stale: property.status !== "unknown" && !fresh,
      details: property.reason ?? "No assessment recorded for this property.",
    }),
  );
  const counts = conditionCounts(conditions);
  const summary = [
    `${String(counts.satisfied)} satisfied`,
    ...(counts.partial > 0 ? [`${String(counts.partial)} partial`] : []),
    ...(counts.open > 0 ? [`${String(counts.open)} open`] : []),
    ...(counts.unknown > 0 ? [`${String(counts.unknown)} not assessed`] : []),
    ...(counts.stale > 0 ? [`${String(counts.stale)} recheck`] : []),
    ...(counts.notApplicable > 0
      ? [`${String(counts.notApplicable)} not applicable`]
      : []),
  ].join(" · ");
  const focus = draftCoverage(spec.draft)?.focus;
  const focusLabel = properties.find(
    (property) => property.id === focus,
  )?.label;
  const activity = (): Activity => {
    if (spec.acceptedRevision !== revision)
      return {
        state: ActivityState.Paused,
        label: "Brief changed",
        detail: "Refresh Socrates before continuing",
      };
    if (spec.exchange !== undefined) {
      if (spec.exchange.answer === undefined)
        return {
          state: ActivityState.Waiting,
          label: "Waiting for your answer",
          detail: spec.exchange.prompt.question,
        };
      return {
        state: live.working ? ActivityState.Working : ActivityState.Waiting,
        label: "Answer recorded",
        detail: "Awaiting incorporation into the draft",
      };
    }
    if (spec.status === SpecStatus.Frozen)
      return { state: ActivityState.Idle, label: "Specification frozen" };
    if (live.working)
      return {
        state: ActivityState.Working,
        label: "Reviewing specification",
        ...(live.tool === undefined
          ? focusLabel === undefined || !fresh
            ? {}
            : { detail: `Focus · ${focusLabel}` }
          : { detail: `Tool · ${live.tool}` }),
        ...(focus === undefined || !fresh ? {} : { focusId: focus }),
      };
    if (live.paused)
      return {
        state: ActivityState.Paused,
        label: "",
        detail: "Resume with /socrates",
      };
    if (spec.draft === null)
      return { state: ActivityState.Idle, label: "Specification not drafted" };
    if (counts.stale > 0)
      return {
        state: ActivityState.Idle,
        label: "Assessments need review",
      };
    const questions = spec.draft.blockingQuestions.length;
    if (
      questions === 0 &&
      counts.open === 0 &&
      counts.partial === 0 &&
      counts.unknown === 0 &&
      observation.bead === undefined &&
      !hasSettledDeliveryPolicy(spec.draft)
    )
      return {
        state: ActivityState.Idle,
        label: "PR decision open",
        detail: "Settle which beads open PRs and how they merge.",
      };
    return {
      state: ActivityState.Idle,
      label: questions > 0 ? "Open questions remain" : "Awaiting review",
      ...(questions > 0
        ? { detail: `${String(questions)} blocking questions` }
        : {}),
    };
  };
  const currentActivity = activity();
  const column = specificationColumn(
    spec,
    conditions,
    currentActivity,
    implementation,
  );
  return {
    id: observation.id,
    title: label,
    conditions,
    prioritizeSpecification:
      spec.acceptedRevision !== revision ||
      (spec.status !== SpecStatus.Frozen &&
        (counts.satisfied + counts.notApplicable < conditions.length ||
          (observation.bead === undefined &&
            specificationGaps(spec, revision).length > 0))),
    activity: currentActivity,
    summary,
    implementation,
    columns: [column, implementationColumn(implementation)],
    dockColumns: [
      {
        ...column,
        groups: column.groups.filter((group) => group.id !== "requirements"),
      },
      implementationColumn(implementation, true),
    ],
  };
}

function statusTheme(theme: Theme): StatusTheme {
  return {
    accent: (text) => theme.fg("accent", text),
    muted: (text) => theme.fg("muted", text),
    success: (text) => theme.fg("success", text),
    warning: (text) => theme.fg("warning", text),
    error: (text) => theme.fg("error", text),
    bold: (text) => theme.bold(text),
    selected: (text) => theme.bg("selectedBg", text),
  };
}

// ANSI resets inside a padded row should return to the panel's text and surface.
function surface(theme: Theme, line: string, width: number): string {
  const background = theme.getBgAnsi("userMessageBg");
  const foreground = theme.getFgAnsi("text");
  const padded = truncateToWidth(line, width, "", true);
  return theme.style(
    padded
      .replaceAll("\x1b[0m", `\x1b[0m${foreground}${background}`)
      .replaceAll("\x1b[39m", foreground)
      .replaceAll("\x1b[49m", background),
    { fg: "text", bg: "userMessageBg" },
  );
}

const widgetKey = "studio:socrates";

function sidebarWidth(columns: number): number {
  return columns >= 104
    ? Math.min(56, columns - 68, Math.floor(columns * 0.4))
    : 0;
}

/** UI state is session-local; no timer or saved focus can establish agent activity. */
export function registerSocratesPresentation(
  pi: ExtensionAPI,
  read: (ctx: ExtensionContext) => SocratesObservation | undefined,
  viewSpecification: (ctx: ExtensionContext) => Promise<void>,
) {
  const live: SocratesActivity = { working: false, paused: false };
  const tools = new Map<string, string>();
  const renders = new Set<() => void>();
  let snapshot: SocratesPresentation | undefined;
  let binding: SocratesObservation | undefined;
  let mounted = false;
  // Remember each layout independently when a terminal or Zellij pane is resized.
  let sidebarOpen = true;
  let dockExpanded = false;
  let layoutTui: TUI | undefined;
  const usesSidebar = () =>
    layoutTui !== undefined &&
    typeof layoutTui.setRightColumn === "function" &&
    sidebarWidth(layoutTui.terminal.columns) > 0;
  let inspecting = false;
  const render = () => {
    for (const request of renders) request();
  };
  function resizeStatus(open?: boolean) {
    if (usesSidebar()) sidebarOpen = open ?? !sidebarOpen;
    else dockExpanded = open ?? !dockExpanded;
    render();
  }
  function project() {
    snapshot =
      binding === undefined
        ? undefined
        : socratesPresentation(binding, live, watch.observation());
    render();
  }
  const watch = createImplementationWatch({ changed: project });
  const clear = (ctx: ExtensionContext) => {
    binding = undefined;
    snapshot = undefined;
    watch.setSource(undefined);
    if (mounted) ctx.ui.setWidget(widgetKey, undefined);
    mounted = false;
    render();
  };
  const refresh = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    let observation: SocratesObservation | undefined;
    try {
      observation = read(ctx);
    } catch {
      clear(ctx);
      return;
    }
    if (observation === undefined) {
      clear(ctx);
      return;
    }
    live.tool = [...tools.values()].at(-1);
    binding = observation;
    watch.setSource(observation);
    project();
    if (mounted) return;
    mounted = true;
    ctx.ui.setWidget(
      widgetKey,
      (tui, theme) => {
        const repaint = () => {
          tui.requestRender();
        };
        renders.add(repaint);
        layoutTui = tui;
        tui.setRightColumn?.(
          {
            invalidate() {},
            render(width) {
              if (snapshot === undefined || inspecting) return [];
              return renderStatusSidebar(
                snapshot,
                { ...statusTheme(theme), lane: planGraphColor(theme) },
                width,
                tui.terminal.rows,
              ).map((line) => surface(theme, line, width));
            },
          },
          (width) =>
            sidebarOpen && !inspecting && snapshot !== undefined
              ? sidebarWidth(width)
              : 0,
        );
        return {
          invalidate() {},
          dispose() {
            tui.setRightColumn?.(undefined);
            layoutTui = undefined;
            renders.delete(repaint);
          },
          handleMouse(event) {
            if (
              event.type !== "press" ||
              event.button !== "left" ||
              event.y !== 0
            )
              return undefined;
            resizeStatus();
            return { handled: true };
          },
          render(width) {
            if (snapshot === undefined || inspecting || usesSidebar())
              return [];
            const maxRows = Math.max(
              1,
              Math.min(dockExpanded ? 8 : 3, Math.floor(tui.terminal.rows / 3)),
            );
            const inner = Math.max(0, width - 3);
            const colors = statusTheme(theme);
            const rows =
              dockExpanded && snapshot.prioritizeSpecification
                ? renderSocratesSections(
                    snapshot,
                    { ...colors, lane: planGraphColor(theme) },
                    inner,
                    maxRows,
                    true,
                  )
                : renderStatusDock({
                    columns: snapshot.dockColumns,
                    theme: colors,
                    width: inner,
                    expanded: dockExpanded,
                    maxRows,
                  });
            return rows.map((line, index) => {
              const edge =
                index === 0
                  ? theme.fg("accent", dockExpanded ? "▾ " : "▸ ")
                  : "  ";
              return surface(theme, edge + line, width);
            });
          },
        };
      },
      { placement: "aboveEditor" },
    );
  };
  const reset = (ctx: ExtensionContext) => {
    live.working = false;
    live.paused = false;
    tools.clear();
    clear(ctx);
    refresh(ctx);
  };

  pi.on("session_start", (_event, ctx) => {
    reset(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    reset(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    clear(ctx);
  });
  pi.on("agent_start", (_event, ctx) => {
    live.working = true;
    live.paused = false;
    refresh(ctx);
  });
  pi.on("agent_settled", (event, ctx) => {
    live.working = false;
    live.paused = event.aborted;
    tools.clear();
    refresh(ctx);
  });
  pi.on("tool_execution_start", (event, ctx) => {
    tools.set(event.toolCallId, event.toolName);
    refresh(ctx);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    tools.delete(event.toolCallId);
    refresh(ctx);
  });
  pi.on("session_compact", (_event, ctx) => {
    refresh(ctx);
  });
  async function inspect(ctx: ExtensionContext, column?: "implementation") {
    refresh(ctx);
    const initial = snapshot;
    if (initial === undefined) {
      ctx.ui.notify(
        column === "implementation"
          ? "No plan drafted yet."
          : "No specification or implementation breakdown selected.",
        "info",
      );
      return;
    }
    if (inspecting) return;
    inspecting = true;
    render();
    try {
      await ctx.ui.custom<undefined>(
        (tui, theme, _keys, done) => {
          const options = {
            title: initial.title,
            theme: statusTheme(theme),
            height: () => Math.max(1, Math.floor(tui.terminal.rows * 0.7)),
            requestRender: () => {
              tui.requestRender();
            },
            onClose: () => {
              done(undefined);
            },
          };
          const panel =
            column === "implementation"
              ? createPlanInspector(initial.implementation, theme, options)
              : createStatusBoard({
                  ...options,
                  columns: initial.columns,
                  initialColumnId:
                    binding?.specification === undefined
                      ? "implementation"
                      : "specification",
                });
          let shown = initial;
          const repaint = () => {
            if (
              snapshot === undefined ||
              snapshot.id !== initial.id ||
              snapshot.title !== initial.title
            ) {
              renders.delete(repaint);
              done(undefined);
            } else if (snapshot !== shown) {
              shown = snapshot;
              if ("setPlan" in panel) panel.setPlan(snapshot.implementation);
              else panel.setColumns(snapshot.columns);
            }
          };
          renders.add(repaint);
          return {
            ...panel,
            render(width) {
              const inner = Math.max(1, width - 2);
              return panel
                .render(inner)
                .map((line) => surface(theme, ` ${line}`, width));
            },
            dispose() {
              renders.delete(repaint);
            },
          };
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "top-right",
            width: "100%",
            maxHeight: "70%",
            margin: { top: 1, bottom: 1 },
          },
        },
      );
    } finally {
      inspecting = false;
      render();
    }
  }
  const toggle = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    refresh(ctx);
    if (snapshot === undefined) return;
    resizeStatus();
  };
  pi.registerShortcut("alt+s", {
    description: "Show or collapse lead status",
    handler: toggle,
  });
  pi.registerCommand("socrates-status", {
    description:
      "Toggle lead status, use min or max to resize, inspect for evidence, or spec to read the full specification",
    async handler(argument, ctx) {
      const action = argument.trim();
      if (action === "spec") {
        await viewSpecification(ctx);
        return;
      }
      if (action === "inspect") {
        await inspect(ctx);
        return;
      }
      if (action.length === 0) {
        toggle(ctx);
        return;
      }
      if (action !== "min" && action !== "max")
        throw new Error("Use /socrates-status min, max, inspect, or spec");
      refresh(ctx);
      resizeStatus(action === "max");
    },
  });
  function open(ctx: ExtensionContext) {
    refresh(ctx);
    if (snapshot !== undefined) resizeStatus(true);
  }
  return { refresh, inspect, open };
}
