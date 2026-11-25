import {
  ActivityState,
  ConditionState,
  conditionCounts,
  conditionMark,
  type Activity,
  type Condition,
  type StatusColumn,
  type StatusCount,
  type StatusGroup,
  type StatusItem,
  type StatusMark,
  type StatusTone,
} from "@lanej/pi-components";
import {
  ImplementationPhase,
  ImplementationState,
  type ImplementationPresentation,
} from "./implementation.ts";
import { SpecStatus, type LeadSpecification } from "./spec.ts";

function mark(
  label: string,
  glyph: string,
  ascii: string,
  tone: StatusTone,
): StatusMark {
  return { label, glyph, ascii, tone };
}

function count(label: string, value: number, tone: StatusTone): StatusCount {
  return { label, value, tone };
}

function propertyGroups(conditions: readonly Condition[]): StatusGroup[] {
  const groups: StatusGroup[] = [
    { id: "attention", label: "Needs attention", tone: "warning", items: [] },
    {
      id: "satisfied",
      label: "Satisfied",
      tone: "success",
      items: [],
      collapsed: true,
      showStatusLabels: false,
    },
    {
      id: "unknown",
      label: "Not assessed",
      tone: "muted",
      items: [],
      collapsed: true,
      showStatusLabels: false,
    },
    {
      id: "na",
      label: "Not applicable",
      tone: "muted",
      items: [],
      collapsed: true,
      showStatusLabels: false,
    },
  ];
  const byState = {
    [ConditionState.Partial]: "attention",
    [ConditionState.Open]: "attention",
    [ConditionState.Unknown]: "unknown",
    [ConditionState.Satisfied]: "satisfied",
    [ConditionState.NotApplicable]: "na",
  };
  return groups
    .map((group) => ({
      ...group,
      items: conditions
        .filter(
          (property) =>
            (property.stale === true
              ? "attention"
              : byState[property.state]) === group.id,
        )
        .map(
          (property): StatusItem => ({
            id: property.id,
            label: property.label,
            status: conditionMark(property),
            details: [
              ...(property.stale === true
                ? [
                    `Previous assessment: ${conditionMark({ ...property, stale: false }).label}`,
                  ]
                : []),
              property.details,
            ]
              .filter((part) => part !== undefined)
              .join("\n\n"),
          }),
        ),
    }))
    .filter((group) => group.items.length > 0);
}

export const taskMarks = {
  [ImplementationState.Open]: mark("Open", "○", "o", "muted"),
  [ImplementationState.InProgress]: mark("In progress", "◐", "*", "accent"),
  [ImplementationState.Blocked]: mark("Blocked", "×", "x", "error"),
  [ImplementationState.Deferred]: mark("Deferred", "–", "-", "warning"),
  [ImplementationState.Closed]: mark("Closed", "●", "+", "success"),
  [ImplementationState.Proposed]: mark("Proposed", "◇", ":", "muted"),
  [ImplementationState.Unknown]: mark("Unknown", "?", "?", "muted"),
} satisfies Record<ImplementationState, StatusMark>;

const phaseMarks = {
  [ImplementationPhase.NotPlanned]: mark("", "–", "-", "muted"),
  [ImplementationPhase.Proposed]: mark("", "◇", ":", "muted"),
  [ImplementationPhase.HandoffPending]: mark("", "◐", "*", "accent"),
  [ImplementationPhase.HandoffUncertain]: mark("", "!", "!", "error"),
  [ImplementationPhase.LinkChanged]: mark("", "↺", "!", "warning"),
  [ImplementationPhase.Loading]: mark("", "◐", "*", "accent"),
  [ImplementationPhase.Unavailable]: mark("", "!", "!", "warning"),
  [ImplementationPhase.Tracking]: mark("", "◆", "*", "accent"),
} satisfies Record<ImplementationPhase, StatusMark>;

export function implementationColumn(
  impl: ImplementationPresentation,
  watching = false,
): StatusColumn {
  const groups = new Map<number, StatusItem[]>();
  const priority = [
    ImplementationState.Blocked,
    ImplementationState.InProgress,
    ImplementationState.Unknown,
    ImplementationState.Open,
    ImplementationState.Deferred,
    ImplementationState.Closed,
    ImplementationState.Proposed,
  ];
  const byStatus = watching && impl.phase === ImplementationPhase.Tracking;
  const rows = byStatus
    ? [...impl.rows].sort(
        (left, right) =>
          priority.indexOf(left.state) - priority.indexOf(right.state),
      )
    : impl.rows;
  for (const row of rows) {
    const item = {
      id: row.id,
      label: row.label,
      status: taskMarks[row.state],
      summary: row.requirements.join(", "),
      details: row.details,
    };
    const key = byStatus ? 0 : row.wave;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  const phase = impl.phase;
  const version = impl.specificationVersion;
  const linked =
    phase === ImplementationPhase.Tracking ||
    phase === ImplementationPhase.Loading;
  const needsExplanation =
    phase === ImplementationPhase.HandoffUncertain ||
    phase === ImplementationPhase.LinkChanged ||
    phase === ImplementationPhase.Unavailable;
  return {
    id: "implementation",
    title: "Implementation",
    status: {
      ...phaseMarks[phase],
      label:
        linked && version !== undefined
          ? `${impl.label} · spec v${String(version)}`
          : impl.label,
    },
    counts: [
      ImplementationState.Blocked,
      ImplementationState.InProgress,
      ImplementationState.Open,
      ImplementationState.Deferred,
      ImplementationState.Closed,
      ImplementationState.Unknown,
    ]
      .filter((state) => impl.counts[state] > 0)
      .map((state) =>
        count(
          taskMarks[state].label.toLowerCase(),
          impl.counts[state],
          taskMarks[state].tone,
        ),
      ),
    summary: needsExplanation ? impl.detail : impl.planSummary,
    groups: [...groups.entries()].map(([wave, items]) => ({
      id: `wave-${String(wave)}`,
      label: byStatus ? "Linked beads" : `Wave ${String(wave)}`,
      items,
      showStatusLabels: phase !== ImplementationPhase.Proposed,
    })),
    emptyMessage: impl.detail,
  };
}

export function specificationColumn(
  spec: LeadSpecification | undefined,
  conditions: Condition[],
  activity: Activity,
  implementation: ImplementationPresentation,
): StatusColumn {
  if (spec === undefined)
    return {
      id: "specification",
      title: "Specification",
      status: mark("Not started", "–", "-", "muted"),
      groups: [],
      emptyMessage: "No Socrates specification for this breakdown.",
    };
  const c = conditionCounts(conditions);
  const counts = [
    count("recheck", c.stale, "warning"),
    count("open", c.open, "warning"),
    count("partial", c.partial, "warning"),
    count("satisfied", c.satisfied, "success"),
    count("not assessed", c.unknown, "muted"),
    count("N/A", c.notApplicable, "muted"),
  ].filter((entry) => entry.value > 0);
  const version = `v${String(spec.version)}`;
  const phase =
    spec.status === SpecStatus.Frozen
      ? `Frozen · ${version}`
      : `Draft · ${version}`;
  const status = mark(
    phase,
    spec.status === SpecStatus.Frozen ? "◆" : "◇",
    ":",
    spec.status === SpecStatus.Frozen ? "accent" : "muted",
  );
  const summary =
    activity.state === ActivityState.Idle
      ? (activity.detail ?? spec.draft?.objective)
      : [
          activity.label.length === 0 ? "Paused" : activity.label,
          activity.label === "Answer recorded" &&
          activity.state === ActivityState.Working
            ? "Updating the draft"
            : activity.detail,
        ]
          .filter((part) => part !== undefined)
          .join(" · ");
  const groups = propertyGroups(conditions);
  const requirements = spec.draft?.requirements ?? [];
  if (requirements.length > 0)
    groups.push({
      id: "requirements",
      label: "Requirements",
      collapsed: true,
      tone: "accent",
      showStatusLabels: false,
      items: requirements.map((requirement) => {
        const linked = implementation.rows.filter((row) =>
          row.requirements.includes(requirement.id),
        );
        return {
          id: requirement.id,
          label: `${requirement.id} · ${requirement.outcome}`,
          status: mark("Requirement", "§", "#", "accent"),
          details: [
            `Acceptance · ${requirement.acceptance}`,
            ...linked.map(
              (row) => `${row.beadId ?? row.id} · ${row.label} · ${row.status}`,
            ),
          ].join("\n\n"),
        };
      }),
    });
  return {
    id: "specification",
    title: "Specification",
    status,
    summary,
    counts,
    groups,
    focusId: activity.focusId,
  };
}
