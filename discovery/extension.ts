import { renderPlanCall } from "../plan-renderer.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { Type } from "typebox";
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
import { reviewPlan, showTask } from "../ui.ts";
import { Discoveries, type Discovery } from "./store.ts";

const selectionType = "studio:discovery";
const markerSchema = z.object({ id: z.uuid(), project: z.string() });

export function registerDiscovery(
  pi: ExtensionAPI,
  profile: () => string | undefined,
) {
  let pending = false;
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
    selected = record.id;
    pi.appendEntry(selectionType, { id: record.id, project: record.project });
  };
  const get = (): Discovery => {
    if (selected === undefined)
      throw new Error(
        "Use /socrates or /plan-draft to select a discovery first",
      );
    return storage((db) => db.get(selected ?? ""));
  };
  const requireBinding = (ctx: ExtensionContext): Promise<Discovery> => {
    selected = locate(ctx);
    const record = get();
    if (record.project !== realpathSync(ctx.cwd))
      throw new Error("Select a discovery for this project");
    return Promise.resolve(record);
  };
  const select = (argument: string, ctx: ExtensionContext): Promise<void> => {
    const text = argument.trim();
    if (text === "list") {
      const listing = storage((db) => db.list(ctx.cwd))
        .map((record) => `${record.id} · ${record.title}`)
        .join("\n");
      return showTask(
        ctx,
        listing.length === 0 ? "No discoveries for this project." : listing,
      ).then(() => {});
    }
    const current = locate(ctx);
    if (
      text.startsWith("new ") ||
      (text.length === 0 && current === undefined)
    ) {
      bind(
        storage((db) =>
          db.create(
            ctx.cwd,
            ctx.sessionManager.getSessionId(),
            text.slice(4).trim().length === 0
              ? "Discovery"
              : text.slice(4).trim(),
          ),
        ),
      );
    } else if (text.length > 0) {
      const record = storage((db) => db.get(z.uuid().parse(text)));
      if (record.project !== realpathSync(ctx.cwd))
        throw new Error("That discovery belongs to another project");
      bind(record);
    } else selected = current;
    return Promise.resolve();
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
        `Selected discovery · ${record.title}\n${record.id}`,
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
  const socrates = registerSocratesControls(
    pi,
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
      select: async (argument, ctx) => {
        if (argument.trim() === "list")
          throw new Error("Use /discoveries to list saved discoveries");
        await select(argument, ctx);
      },
      check: (record, revision) => {
        if (get().id !== record.id || get().revision !== revision)
          throw new Error("The selected discovery changed");
        return Promise.resolve();
      },
    },
  );
  pi.registerCommand("discoveries", {
    description: "List this project's saved discoveries",
    handler: (_arg, ctx) => select("list", ctx),
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
      if (locate(ctx) === undefined)
        await select(
          `new ${argument.trim().length === 0 ? "Work breakdown" : argument.trim()}`,
          ctx,
        );
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
    pending ? { cancel: true } : undefined,
  );
  pi.on("session_before_fork", () => (pending ? { cancel: true } : undefined));
  return { pending: () => pending };
}
