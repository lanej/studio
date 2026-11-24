import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  ActivityState,
  ConditionState,
  activityIndicator,
  conditionCounts,
  createConditionsPanel,
  selectorText,
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
import { SpecStatus, type LeadSpecification } from "./spec.ts";

export interface SocratesObservation {
  id: string;
  label: string;
  revision: string | null;
  specification: LeadSpecification;
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
}

const conditionStates = {
  unknown: ConditionState.Unknown,
  satisfied: ConditionState.Satisfied,
  open: ConditionState.Open,
  "not-applicable": ConditionState.NotApplicable,
} satisfies Record<CoverageStatus, ConditionState>;

/** Project saved assessments and observed activity without deciding readiness. */
export function socratesPresentation(
  observation: SocratesObservation,
  live: SocratesActivity,
): SocratesPresentation {
  const { specification: spec, revision, label } = observation;
  const fresh = coverageFresh(spec, revision);
  const properties = coverageProperties(spec.draft);
  const conditions = properties.map(
    (property): Condition => ({
      id: property.id,
      label: property.label,
      state: conditionStates[property.status],
      stale: property.status !== "unknown" && !fresh,
      summary:
        property.status === "unknown"
          ? "No assessment recorded."
          : fresh
            ? "Saved assessment for this draft."
            : "Saved assessment needs review.",
      details:
        property.reason ?? "Socrates has not assessed this property yet.",
    }),
  );
  const counts = conditionCounts(conditions);
  const summary = [
    `${String(counts.satisfied)} satisfied`,
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
    return {
      state: ActivityState.Idle,
      label: questions > 0 ? "Open questions remain" : "Awaiting review",
      ...(questions > 0
        ? { detail: `${String(questions)} blocking questions` }
        : {}),
    };
  };
  return {
    id: observation.id,
    title: `Socrates · ${label}`,
    conditions,
    activity: activity(),
    summary,
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

const widgetKey = "studio:socrates";

/** UI state is session-local; no timer or saved focus can establish agent activity. */
export function registerSocratesPresentation(
  pi: ExtensionAPI,
  read: (ctx: ExtensionContext) => SocratesObservation | undefined,
) {
  const live: SocratesActivity = { working: false, paused: false };
  const tools = new Map<string, string>();
  const renders = new Set<() => void>();
  const reducedMotion = process.env["STUDIO_REDUCED_MOTION"] === "1";
  let snapshot: SocratesPresentation | undefined;
  let mounted = false;
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stopAnimation = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const render = () => {
    for (const request of renders) request();
  };
  const animate = () => {
    if (snapshot?.activity.state !== ActivityState.Working || reducedMotion) {
      stopAnimation();
      return;
    }
    if (timer !== undefined) return;
    timer = setInterval(() => {
      frame++;
      render();
    }, 160);
    timer.unref();
  };
  const clear = (ctx: ExtensionContext) => {
    stopAnimation();
    snapshot = undefined;
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
      // A missing or unreadable binding must never leave another topic visible.
      clear(ctx);
      return;
    }
    if (observation === undefined) {
      clear(ctx);
      return;
    }
    live.tool = [...tools.values()].at(-1);
    snapshot = socratesPresentation(observation, live);
    if (!mounted) {
      mounted = true;
      ctx.ui.setWidget(widgetKey, (tui, theme) => {
        const repaint = () => {
          tui.requestRender();
        };
        renders.add(repaint);
        return {
          invalidate() {},
          dispose() {
            renders.delete(repaint);
          },
          render(width) {
            if (snapshot === undefined || width <= 0) return [];
            const activity = activityIndicator(
              snapshot.activity,
              statusTheme(theme),
              {
                frame,
                reducedMotion,
              },
            );
            const detail = snapshot.activity.detail;
            return [
              `${theme.bold(theme.fg("accent", "Socrates"))} · ${activity}`,
              theme.fg("muted", snapshot.summary),
              theme.fg(
                "dim",
                `${detail === undefined ? "" : `${selectorText(detail)} · `}/socrates-status · evidence`,
              ),
            ].map((line) => truncateToWidth(line, width));
          },
        };
      });
    }
    animate();
    render();
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
  pi.registerCommand("socrates-status", {
    description:
      "Inspect Socrates properties, saved assessments, and current activity",
    async handler(_argument, ctx) {
      refresh(ctx);
      const initial = snapshot;
      if (initial === undefined)
        throw new Error("Start or select a discovery with /socrates first");
      await ctx.ui.custom<undefined>(
        (tui, theme, _keys, done) => {
          const panel = createConditionsPanel({
            title: initial.title,
            conditions: initial.conditions,
            activity: initial.activity,
            presentation: { reducedMotion },
            theme: statusTheme(theme),
            height: () => Math.max(1, tui.terminal.rows - 2),
            requestRender: () => {
              tui.requestRender();
            },
            onClose: () => {
              done(undefined);
            },
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
              return;
            }
            if (snapshot !== shown) {
              shown = snapshot;
              panel.setConditions(snapshot.conditions);
              panel.setActivity(snapshot.activity);
            }
            panel.setFrame(reducedMotion ? 0 : frame);
            tui.requestRender();
          };
          renders.add(repaint);
          repaint();
          return {
            ...panel,
            dispose() {
              renders.delete(repaint);
            },
          };
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "100%",
            margin: { top: 1, bottom: 1 },
          },
        },
      );
    },
  });
  return { refresh };
}
