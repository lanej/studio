import { renderPlanCall } from "../plan-renderer.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { Type } from "typebox";
import { isDeepStrictEqual } from "node:util";
import { selectorText } from "@lanej/pi-components";
import { z } from "zod";
import { registerSocratesControls } from "../socrates/controls.ts";
import { draftDeliveryPolicy, SpecStatus, specText } from "../socrates/spec.ts";
import { coverageToken } from "../socrates/assessment.ts";
import { loadConfig } from "../config.ts";
import { socratesGuidance } from "../socrates/guidance.ts";
import {
  LeadMode,
  TaskDelivery,
  type LeadDraft,
  describePlan,
  draftSchema,
  planDigest,
  reviseDelivery,
} from "../lead-plan.ts";
import { isEntry, PiEntryType } from "../runtime.ts";
import { reviewPlan } from "../ui.ts";
import {
  applyDeliveryPolicy,
  Discoveries,
  handoffDraft,
  type Discovery,
} from "./store.ts";

const selectionType = "studio:discovery";
const markerSchema = z.object({
  id: z.uuid().nullable(),
  project: z.string(),
  session: z.string().optional(),
});

function discoveryStatus(record: Discovery): string {
  const spec = record.specification;
  if (spec === undefined) return "not started";
  if (spec.status === SpecStatus.Frozen || spec.exchange === undefined)
    return spec.status;
  return spec.exchange.answer === undefined ? "question open" : "answer saved";
}

/** A changed discovery graph can alter evidence for scope, verification, dependencies, or authority. */
function saveDiscoveryPlan(row: Discovery, proposal: LeadDraft): void {
  const policy = draftDeliveryPolicy(row.specification?.draft ?? null);
  const draft =
    policy === undefined ? proposal : applyDeliveryPolicy(proposal, policy);
  if (
    row.specification !== undefined &&
    !isDeepStrictEqual(draft, row.leadPlan.draft)
  )
    row.specification.coverageRevision = undefined;
  row.leadPlan = { ...row.leadPlan, mode: LeadMode.Planning, draft };
}

export function registerDiscovery(
  pi: ExtensionAPI,
  profile: () => string | undefined,
  onSelectionChange?: () => void,
) {
  let pending = false;
  let runningDiscoveryCommand = false;
  const discoveryBusy = () => pending || runningDiscoveryCommand;
  let selected: string | undefined;
  const storage = <T>(operation: (store: Discoveries) => T): T => {
    const db = new Discoveries();
    try {
      return operation(db);
    } finally {
      db.close();
    }
  };
  const locate = (ctx: ExtensionContext): string | undefined => {
    const project = realpathSync(ctx.cwd);
    const marker = ctx.sessionManager
      .getBranch()
      .findLast(
        (entry) =>
          isEntry(entry, PiEntryType.Custom) &&
          entry.customType === selectionType,
      );
    if (marker === undefined || !isEntry(marker, PiEntryType.Custom))
      return undefined;
    const parsed = markerSchema.safeParse(marker.data);
    return parsed.success &&
      parsed.data.project === project &&
      (parsed.data.session === ctx.sessionManager.getSessionId() ||
        (parsed.data.session === undefined &&
          ctx.sessionManager.getHeader()?.parentSession === undefined))
      ? (parsed.data.id ?? undefined)
      : undefined;
  };
  const bind = (record: Discovery, ctx: ExtensionContext): void => {
    pi.appendEntry(selectionType, {
      id: record.id,
      project: record.project,
      session: ctx.sessionManager.getSessionId(),
    });
    selected = record.id;
    onSelectionChange?.();
  };
  const create = (ctx: ExtensionContext, title: string): void => {
    bind(
      storage((db) =>
        db.create(ctx.cwd, ctx.sessionManager.getSessionId(), title),
      ),
      ctx,
    );
  };
  const get = (): Discovery => {
    const id = selected;
    if (id === undefined)
      throw new Error(
        "Start with /socrates or /plan-draft, or select with /discoveries",
      );
    return storage((db) => db.get(id));
  };
  const requireBinding = (ctx: ExtensionContext): Promise<Discovery> => {
    selected = locate(ctx);
    const record = get();
    if (record.project !== realpathSync(ctx.cwd))
      throw new Error("Select a discovery for this project");
    return Promise.resolve(record);
  };
  const selectedRecord = (ctx: ExtensionContext): Discovery | undefined => {
    const id = locate(ctx);
    if (id === undefined) return undefined;
    const record = storage((db) => db.find(id));
    return record?.project === realpathSync(ctx.cwd) ? record : undefined;
  };
  pi.on("session_start", (event, ctx) => {
    selected = undefined;
    if (event.reason === "fork")
      pi.appendEntry(selectionType, {
        id: null,
        project: realpathSync(ctx.cwd),
        session: ctx.sessionManager.getSessionId(),
      });
  });
  pi.on("before_agent_start", async (event, ctx) => {
    const record = selectedRecord(ctx);
    selected = record?.id;
    const directCoding =
      "You are the coding agent in the current checkout. Carry out requested code changes directly, using your editing, shell, and verification tools. For a requested plan, plan locally. Socrates is an optional workflow started by the operator.";
    if (record === undefined)
      return { systemPrompt: `${event.systemPrompt}\n\n${directCoding}` };
    if (record.handoff !== undefined || record.approved !== undefined)
      return {
        systemPrompt: [
          event.systemPrompt,
          directCoding,
          "The operator has handed off the selected work. Leave its execution to the runtime and continue other work directly in this conversation.",
        ].join("\n\n"),
      };
    if (record.specification === undefined)
      return {
        systemPrompt: [
          event.systemPrompt,
          directCoding,
          ...(record.leadPlan.draft === null
            ? []
            : [
                `Local proposal · ${record.title}`,
                describePlan(record.leadPlan.draft, "proposal"),
              ]),
        ].join("\n\n"),
      };
    return {
      systemPrompt: [
        event.systemPrompt,
        `Selected discovery · ${record.title}`,
        await socratesGuidance(),
        specText(record.specification),
        "Develop the specification and its proposed beads together. Keep the decomposition current as answers change task scope, dependencies, acceptance, or verification. Use draft_implementation_plan to persist it locally. Actual beads and worker dispatch require the operator's final handoff approval.",
        ...(record.leadPlan.draft === null
          ? []
          : [describePlan(record.leadPlan.draft, "proposal")]),
      ].join("\n\n"),
    };
  });
  // Only the daily-driver command accepts a discovery title.
  const socrates = registerSocratesControls(
    {
      ...pi,
      registerCommand(name, command) {
        pi.registerCommand(
          name,
          name === "socrates"
            ? {
                ...command,
                description:
                  "/socrates [TITLE] — start a new discovery with TITLE; omit it to continue or start one",
                async handler(argument, ctx) {
                  if (discoveryBusy())
                    throw new Error("Wait for the discovery command");
                  runningDiscoveryCommand = true;
                  try {
                    await command.handler(argument, ctx);
                  } finally {
                    runningDiscoveryCommand = false;
                  }
                },
              }
            : command,
        );
      },
    },
    {
      get: () => get(),
      change: (id, update) =>
        storage((db) => db.change(id === "selected" ? get().id : id, update)),
    },
    "selected",
    requireBinding,
    (active) => {
      pending = active;
    },
    {
      discovery: true,
      subject: "this discovery; Beads is not required",
      identity: (record) => record.id,
      label: (record) => record.title,
      snapshot: selectedRecord,
      select: (argument, ctx) => {
        const title = argument.trim();
        selected = locate(ctx);
        if (title !== "" || selected === undefined)
          create(ctx, title === "" ? "Discovery" : title);
        else {
          const record = get();
          if (
            record.specification === undefined &&
            (record.handoff !== undefined || record.approved !== undefined)
          )
            throw new Error(
              "This plan has already been handed off. Start a new discovery with /socrates TITLE.",
            );
        }
        return Promise.resolve();
      },
      check: (record, revision) => {
        const current = get();
        if (current.id !== record.id || current.revision !== revision)
          throw new Error("The selected discovery changed");
        return Promise.resolve();
      },
    },
  );
  pi.registerCommand("discoveries", {
    description: "Select a saved project discovery by title for /socrates",
    async handler(_arg, ctx) {
      if (discoveryBusy() || !ctx.isIdle())
        throw new Error("Wait for the lead turn to settle");
      const project = realpathSync(ctx.cwd);
      const records = storage((db) => db.list(project));
      if (records.length === 0) {
        ctx.ui.notify("No saved discoveries for this project.", "info");
        return;
      }
      if (!ctx.hasUI) throw new Error("Open the Pi TUI to select a discovery");
      const session = ctx.sessionManager.getSessionId();
      const leaf = ctx.sessionManager.getLeafId();
      const current = locate(ctx);
      const choices = records.map((record, index) => {
        const title = selectorText(record.title).replace(/\s+/gu, " ");
        const active = record.id === current ? " · selected" : "";
        const number = records.length - index;
        return `#${String(number)} ${title} · ${discoveryStatus(record)}${active}`;
      });
      runningDiscoveryCommand = true;
      try {
        const choice = await ctx.ui.select("Select a saved discovery", choices);
        if (choice === undefined) return;
        const record = records[choices.indexOf(choice)];
        if (
          record === undefined ||
          project !== realpathSync(ctx.cwd) ||
          session !== ctx.sessionManager.getSessionId() ||
          leaf !== ctx.sessionManager.getLeafId() ||
          !ctx.isIdle()
        )
          throw new Error("Open /discoveries again for this conversation");
        if (record.id !== current) {
          bind(record, ctx);
          socrates.refresh(ctx);
        }
      } finally {
        runningDiscoveryCommand = false;
      }
    },
  });
  pi.registerCommand("socrates-end", {
    description: "Save the discovery and return to direct coding",
    handler(_argument, ctx) {
      if (discoveryBusy() || !ctx.isIdle())
        throw new Error("Wait for the lead turn to settle");
      if (locate(ctx) !== undefined) {
        pi.appendEntry(selectionType, {
          id: null,
          project: realpathSync(ctx.cwd),
        });
        selected = undefined;
        onSelectionChange?.();
        socrates.refresh(ctx);
      }
      ctx.ui.notify(
        "Direct coding. Resume a saved discovery with /discoveries.",
        "info",
      );
      return Promise.resolve();
    },
  });
  pi.registerCommand("spec-reopen", {
    description: "Preserve the frozen specification and reopen this discovery",
    async handler(_arg, ctx) {
      const record = await requireBinding(ctx);
      if (!ctx.isIdle()) throw new Error("Wait for the lead turn to settle");
      storage((db) =>
        db.change(record.id, (row) => {
          if (row.specification?.status !== SpecStatus.Frozen)
            throw new Error("No frozen specification to reopen");
          if (
            row.approved !== undefined ||
            row.handoff !== undefined ||
            row.graph !== undefined
          )
            throw new Error(
              "This discovery has been handed off. Use /tasks to track it or /socrates TITLE to start a separate discovery.",
            );
          row.history.push(row.specification);
          row.revision = randomUUID();
          row.specification = {
            ...row.specification,
            version: row.specification.version + 1,
            status: SpecStatus.Interrogating,
            acceptedRevision: row.revision,
            approvalAt: undefined,
          };
          row.leadPlan = { mode: LeadMode.Planning, draft: null };
          row.planSpecificationRevision = undefined;
        }),
      );
      onSelectionChange?.();
      socrates.refresh(ctx);
      pi.sendUserMessage(
        "Resume discovery. Preserve settled decisions and explain any changed scope before drafting a new specification.",
      );
    },
  });
  pi.registerCommand("plan-draft", {
    description:
      "Draft or revise a private work breakdown in this conversation",
    async handler(argument, ctx) {
      if (!ctx.isIdle()) throw new Error("Wait for the lead turn to settle");
      if (locate(ctx) === undefined) {
        const title = argument.trim();
        create(ctx, title === "" ? "Work breakdown" : title);
      }
      const record = await requireBinding(ctx);
      if (record.handoff !== undefined || record.approved !== undefined)
        throw new Error(
          "This breakdown has been handed off. Use /socrates-end to start a separate plan.",
        );
      pi.sendUserMessage(
        `Draft or revise the local work breakdown: proposed tasks, dependencies, acceptance criteria, and checks. ${argument}`,
      );
    },
  });
  pi.registerTool({
    name: "draft_implementation_plan",
    renderCall: renderPlanCall,
    label: "Draft work breakdown",
    description:
      "Save the proposed decomposition into beads: task scopes, requirements, dependencies, acceptance, and verification. During Socrates, develop it alongside the specification and revise it when an answer affects the work. Outside Socrates, use only for an explicitly requested local plan.",
    parameters: Type.Object({
      summary: Type.String(),
      tasks: Type.Array(
        Type.Object({
          key: Type.String(),
          title: Type.String(),
          description: Type.String(),
          acceptance: Type.String(),
          blockedBy: Type.Optional(Type.Array(Type.String())),
          requirements: Type.Optional(Type.Array(Type.String())),
          owns: Type.Optional(Type.Array(Type.String())),
          hold: Type.Optional(Type.Boolean()),
          delivery: Type.Optional(Type.Enum(TaskDelivery)),
          check: Type.Optional(Type.Array(Type.String())),
        }),
      ),
    }),
    async execute(_call, params, _signal, _update, ctx) {
      if (discoveryBusy()) throw new Error("Wait for the discovery command");
      const draft = draftSchema.parse(params);
      if (locate(ctx) === undefined) create(ctx, draft.summary);
      const record = await requireBinding(ctx);
      storage((db) =>
        db.change(record.id, (row) => {
          if (row.approved !== undefined)
            throw new Error(
              "This breakdown is already approved; create a new discovery",
            );
          const spec = row.specification;
          if (spec !== undefined) {
            const requirements =
              spec.draft?.requirements.map(({ id }) => id) ?? [];
            if (
              draft.tasks.some((task) =>
                task.requirements.some((id) => !requirements.includes(id)),
              )
            )
              throw new Error(
                "Link proposed tasks only to requirements in the current specification",
              );
            row.planSpecificationRevision = coverageToken(spec);
          }
          saveDiscoveryPlan(row, draft);
        }),
      );
      socrates.refresh(ctx);
      const saved = get().specification;
      return {
        content: [
          {
            type: "text",
            text:
              saved !== undefined && saved.coverageRevision === undefined
                ? "Draft saved. Assess every applicable property against the updated plan with draft_socrates_specification before the next question, freeze, or handoff."
                : saved?.status === SpecStatus.Frozen
                  ? "Draft saved. /plan to inspect · /plan-approve to review the handoff"
                  : "Draft saved. /plan to inspect the proposed work.",
          },
        ],
        details: {},
      };
    },
  });
  pi.registerCommand("plan", {
    description: "Inspect the selected work breakdown",
    async handler(_arg, ctx) {
      await requireBinding(ctx);
      await socrates.inspect(ctx, "implementation");
    },
  });
  pi.registerCommand("plan-delivery", {
    description:
      "Change a proposed task delivery: <task-key> <local|pull-request>",
    async handler(argument, ctx) {
      const record = await requireBinding(ctx);
      storage((db) =>
        db.change(record.id, (row) => {
          if (
            row.approved !== undefined ||
            row.leadPlan.mode !== LeadMode.Planning ||
            row.leadPlan.draft === null
          )
            throw new Error("No unapproved draft to revise");
          saveDiscoveryPlan(row, reviseDelivery(row.leadPlan.draft, argument));
        }),
      );
      socrates.refresh(ctx);
      ctx.ui.notify(
        "Delivery proposal updated. Use /plan to review it.",
        "info",
      );
    },
  });
  pi.registerCommand("plan-approve", {
    description:
      "Review and authorize the plan in background mode or with /plan-approve interactive",
    async handler(argument, ctx) {
      const mode = argument.trim();
      if (mode !== "" && mode !== "background" && mode !== "interactive")
        throw new Error(
          "Use /plan-approve background or /plan-approve interactive",
        );
      if (!ctx.isIdle()) throw new Error("Wait for the lead turn to settle");
      const record = await requireBinding(ctx);
      const draft = handoffDraft(record);
      const digest = planDigest(draft);
      const selectedProfile = profile();
      if (selectedProfile === undefined)
        throw new Error(
          "Select /studio-profile work or personal before approving execution",
        );
      if (discoveryBusy()) throw new Error("Wait for the discovery command");
      pending = true;
      try {
        const { handoffTarget, approveHandoff, prepareInteractiveHandoff } =
          await import("../execution/handoff.ts");
        const target = handoffTarget(
          await loadConfig(),
          record,
          selectedProfile,
        );
        const interactive =
          mode === "interactive"
            ? await prepareInteractiveHandoff(record)
            : undefined;
        if (
          !(await reviewPlan(
            ctx,
            `Approve ${record.title}`,
            [
              interactive === undefined
                ? "Execution · background"
                : `Execution · interactive in Zellij ${interactive.session}, tab ${String(interactive.tab)}`,
              `Project · ${target.root}\nBeads · ${target.id}\nProfile · ${target.profile}`,
              record.specification === undefined
                ? "Recovery of the previously approved handoff"
                : specText(record.specification),
              describePlan(draft),
            ].join("\n\n"),
            "create tasks and implement",
          ))
        )
          return;
        const current = await requireBinding(ctx);
        if (
          selectedProfile !== profile() ||
          current.id !== record.id ||
          current.revision !== record.revision ||
          !isDeepStrictEqual(current.specification, record.specification) ||
          current.leadPlan.draft === null ||
          planDigest(current.leadPlan.draft) !== digest
        )
          throw new Error("The displayed breakdown changed; review it again");
        await approveHandoff(current, selectedProfile, target, interactive);
        ctx.ui.notify(
          "Approved work is queued in Beads. The lead remains free.",
          "info",
        );
      } finally {
        pending = false;
        socrates.refresh(ctx);
      }
    },
  });
  pi.on("session_before_switch", () =>
    discoveryBusy() ? { cancel: true } : undefined,
  );
  pi.on("session_before_fork", () =>
    discoveryBusy() ? { cancel: true } : undefined,
  );
  return {
    pending: discoveryBusy,
    runtimeHandoff(ctx: ExtensionContext): Discovery["handoff"] {
      return selectedRecord(ctx)?.handoff;
    },
  };
}
