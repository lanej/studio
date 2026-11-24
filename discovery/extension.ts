import { renderPlanCall } from "../plan-renderer.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { Type } from "typebox";
import { selectorText } from "@lanej/pi-components";
import { z } from "zod";
import { registerSocratesControls } from "../socrates/controls.ts";
import { SpecStatus, specText } from "../socrates/spec.ts";
import { socratesGuidance } from "../socrates/guidance.ts";
import {
  LeadMode,
  TaskDelivery,
  describePlan,
  draftSchema,
  planDigest,
} from "../lead-plan.ts";
import { isEntry, PiEntryType } from "../runtime.ts";
import { reviewPlan } from "../ui.ts";
import { Discoveries, type Discovery } from "./store.ts";

const selectionType = "studio:discovery";
const markerSchema = z.object({ id: z.uuid(), project: z.string() });

function discoveryStatus(record: Discovery): string {
  const spec = record.specification;
  if (spec === undefined) return "not started";
  if (spec.status === SpecStatus.Frozen || spec.exchange === undefined)
    return spec.status;
  return spec.exchange.answer === undefined ? "question open" : "answer saved";
}

export function registerDiscovery(
  pi: ExtensionAPI,
  profile: () => string | undefined,
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
    return parsed.success && parsed.data.project === project
      ? parsed.data.id
      : undefined;
  };
  const bind = (record: Discovery): void => {
    pi.appendEntry(selectionType, { id: record.id, project: record.project });
    selected = record.id;
  };
  const create = (ctx: ExtensionContext, title: string): void => {
    bind(
      storage((db) =>
        db.create(ctx.cwd, ctx.sessionManager.getSessionId(), title),
      ),
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
  pi.on("before_agent_start", async (event, ctx) => {
    selected = locate(ctx);
    const base =
      "The Studio lead stays available for exploration, research, and conversation. Propose a work breakdown only when explicitly requested or after Socrates; await operator review before creating Beads tasks. Approved implementation belongs to independent runtime workers.";
    if (selected === undefined)
      return { systemPrompt: `${event.systemPrompt}\n\n${base}` };
    const record = get();
    const guidance =
      record.specification === undefined ? "" : await socratesGuidance();
    return {
      systemPrompt: [
        event.systemPrompt,
        base,
        `Selected discovery · ${record.title}`,
        guidance,
        record.specification === undefined
          ? ""
          : specText(record.specification),
        record.leadPlan.draft === null
          ? ""
          : describePlan(record.leadPlan.draft),
        record.approved === undefined
          ? "No breakdown has been approved."
          : "The approved work is owned by separate runtime workers. Continue discovery freely.",
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
      change: (_id, update) => storage((db) => db.change(get().id, update)),
    },
    "selected",
    requireBinding,
    (active) => {
      pending = active;
    },
    {
      subject: "this discovery; Beads is not required",
      identity: (record) => record.id,
      label: (record) => record.title,
      snapshot: (ctx) => {
        const id = locate(ctx);
        return id === undefined ? undefined : storage((db) => db.get(id));
      },
      select: (argument, ctx) => {
        const title = argument.trim();
        if (title !== "") create(ctx, title);
        else if (locate(ctx) === undefined) create(ctx, "Discovery");
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
          bind(record);
          socrates.refresh(ctx);
        }
      } finally {
        runningDiscoveryCommand = false;
      }
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
          row.approved = undefined;
          row.graph = undefined;
          row.handoff = undefined;
        }),
      );
      socrates.refresh(ctx);
      pi.sendUserMessage(
        "Resume discovery. Preserve settled decisions and explain any changed scope before drafting a new specification.",
      );
    },
  });
  pi.registerCommand("plan-draft", {
    description: "Request a work breakdown without requiring Socrates first",
    async handler(argument, ctx) {
      if (!ctx.isIdle()) throw new Error("Wait for the lead turn to settle");
      if (locate(ctx) === undefined) {
        const title = argument.trim();
        create(ctx, title === "" ? "Work breakdown" : title);
      }
      await requireBinding(ctx);
      pi.sendUserMessage(
        `Draft a bounded work breakdown for operator review. Do not create tasks before /plan-approve. ${argument}`,
      );
    },
  });
  pi.registerTool({
    name: "draft_implementation_plan",
    renderCall: renderPlanCall,
    label: "Draft work breakdown",
    description:
      "Persist a proposed work breakdown. No Beads tasks are created until the operator approves the exact proposal.",
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
      const record = await requireBinding(ctx);
      const draft = draftSchema.parse(params);
      storage((db) =>
        db.change(record.id, (row) => {
          if (row.approved !== undefined)
            throw new Error(
              "This breakdown is already approved; create a new discovery",
            );
          if (row.specification !== undefined) {
            if (row.specification.status !== SpecStatus.Frozen)
              throw new Error(
                "Freeze the specification before drafting its breakdown",
              );
            const requirements =
              row.specification.draft?.requirements.map((item) => item.id) ??
              [];
            if (
              draft.tasks.some(
                (task) =>
                  task.requirements.length === 0 ||
                  task.requirements.some((id) => !requirements.includes(id)),
              ) ||
              requirements.some(
                (id) =>
                  !draft.tasks.some((task) => task.requirements.includes(id)),
              )
            )
              throw new Error(
                "Cover every frozen requirement and link each task to known requirement IDs",
              );
          }
          row.leadPlan = { mode: LeadMode.Planning, draft };
        }),
      );
      return {
        content: [
          {
            type: "text",
            text: "Draft saved. /plan to inspect · /plan-approve to review",
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
  pi.registerCommand("plan-approve", {
    description:
      "Review and authorize the displayed breakdown for unattended execution",
    async handler(_arg, ctx) {
      if (!ctx.isIdle()) throw new Error("Wait for the lead turn to settle");
      const record = await requireBinding(ctx);
      const draft = record.leadPlan.draft;
      if (draft === null || draft.tasks.length === 0)
        throw new Error("Draft at least one executable task first");
      const digest = planDigest(draft);
      const selectedProfile = profile();
      if (selectedProfile === undefined)
        throw new Error(
          "Select /studio-profile work or personal before approving execution",
        );
      const { prepareHandoff, approveHandoff } = await import(
        "../execution/handoff.ts"
      );
      const target = await prepareHandoff(record, selectedProfile);
      pending = true;
      try {
        if (
          !(await reviewPlan(
            ctx,
            `Approve ${record.title}`,
            [
              `Project · ${target.root}\nBeads · ${target.id}\nProfile · ${target.profile}\nMerge policy · project default and lead override are evaluated before delivery`,
              specText(
                record.specification ?? {
                  status: SpecStatus.Frozen,
                  version: 1,
                  draft: null,
                  acceptedRevision: record.revision,
                },
              ),
              describePlan(draft),
            ].join("\n\n"),
            "create tasks and implement",
          ))
        )
          return;
        const current = await requireBinding(ctx);
        if (
          current.id !== record.id ||
          current.revision !== record.revision ||
          current.specification?.version !== record.specification?.version ||
          current.leadPlan.draft === null ||
          planDigest(current.leadPlan.draft) !== digest
        )
          throw new Error("The displayed breakdown changed; review it again");
        await approveHandoff(current, selectedProfile, target);
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
    hasSelectedDraft(ctx: ExtensionContext): boolean {
      const id = locate(ctx);
      if (id === undefined) return false;
      const record = storage((db) => db.find(id));
      return (
        record !== undefined &&
        record.project === realpathSync(ctx.cwd) &&
        record.approved === undefined &&
        record.leadPlan.draft !== null
      );
    },
  };
}
