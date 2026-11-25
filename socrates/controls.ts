import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import type { Attempt, Attempts } from "../attempts.ts";
import { LeadMode } from "../lead-plan.ts";
import {
  assessedSpecDraft,
  DecisionDisposition,
  SpecStatus,
  isTrackedDecision,
  preserveDecisions,
  propertyGaps,
  specDraft,
  specQuestion,
  specText,
  specificationGaps,
  type SpecQuestion,
} from "./spec.ts";
import { deliveryPolicyParameter } from "./delivery-policy.ts";
import { questionEvidenceParameter } from "./evidence.ts";
import { questionLinks, renderQuestionEvidence } from "./links.ts";
import { chooseQuestion, QuestionSelectionKind } from "./selector.ts";
import { socratesGuidance } from "./guidance.ts";
import {
  coverageDomains,
  coverageFresh,
  draftCoverage,
  coveragePropertyIds,
  coverageStatuses,
  coverageToken,
} from "./assessment.ts";
import { registerSocratesPresentation } from "./presentation.ts";
import type { ImplementationSource } from "./implementation.ts";
import { BeadChanged, TaskBeads } from "../task-service.ts";
import { reviewPlan, showTask } from "../ui.ts";

export const askTool = "ask_user_question";
export const specTool = "draft_socrates_specification";

export type SocratesState = Pick<
  ImplementationSource,
  "revision" | "approved" | "handoff" | "specification" | "leadPlan"
>;

export function registerSocrates(
  pi: ExtensionAPI,
  db: Attempts,
  id: string,
  requireBinding: (ctx: ExtensionContext) => Promise<Attempt>,
  approvalPending: (active: boolean) => void,
) {
  return registerSocratesControls(pi, db, id, requireBinding, approvalPending, {
    subject: "the accepted Beads task",
    identity: (record) => record.id,
    label: (record) => record.bead.id,
    snapshot: (ctx) =>
      ctx.sessionManager.getSessionId() === id ? db.get(id) : undefined,
    check: async (record, revision) => {
      await new TaskBeads(record.source).requireCurrent(
        record.bead,
        revision,
        id,
      );
    },
  });
}

export function registerSocratesControls<T extends SocratesState>(
  pi: ExtensionAPI,
  db: {
    get(id: string): T;
    change(id: string, update: (row: T) => void): unknown;
  },
  id: string,
  requireBinding: (ctx: ExtensionContext) => Promise<T>,
  approvalPending: (active: boolean) => void,
  scope: {
    subject: string;
    identity(record: T): string;
    label(record: T): string;
    snapshot?(ctx: ExtensionContext): T | undefined;
    check(record: T, revision: string): Promise<void>;
    discovery?: boolean;
    select?(argument: string, ctx: ExtensionContext): Promise<void>;
  },
) {
  async function viewSpecification(ctx: ExtensionContext) {
    const record = await requireBinding(ctx);
    if (record.specification === undefined) {
      ctx.ui.notify("No Socrates specification selected.", "info");
      return;
    }
    approvalPending(true);
    try {
      await showTask(ctx, specText(record.specification));
    } finally {
      approvalPending(false);
    }
  }
  const presentation = registerSocratesPresentation(
    pi,
    (ctx) => {
      const record =
        scope.snapshot === undefined ? db.get(id) : scope.snapshot(ctx);
      return record === undefined ||
        (record.specification === undefined && record.leadPlan?.draft == null)
        ? undefined
        : {
            ...record,
            id: scope.identity(record),
            label: scope.label(record),
          };
    },
    viewSpecification,
  );
  // Pi emits user messages only when delivered, including queued guidance. Its own
  // command prompts also use the user role, but do not change the operator's brief.
  let commandPrompt: string | undefined;
  pi.on("input", (event) => {
    if (event.streamingBehavior === undefined)
      commandPrompt = event.source === "extension" ? event.text : undefined;
  });
  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "user") return;
    const internal = commandPrompt;
    commandPrompt = undefined;
    const content = event.message.content;
    const text =
      typeof content === "string"
        ? content
        : content.find((part) => part.type === "text")?.text;
    if (internal !== undefined && internal === text) return;
    const record = scope.snapshot?.(ctx);
    if (
      record?.specification?.coverageRevision === undefined ||
      record.leadPlan?.mode !== LeadMode.Planning ||
      (scope.discovery !== true &&
        record.specification.status === SpecStatus.Frozen) ||
      record.approved !== undefined ||
      record.handoff !== undefined
    )
      return;
    db.change(scope.identity(record), (row) => {
      if (
        row.specification !== undefined &&
        row.approved === undefined &&
        row.handoff === undefined &&
        row.leadPlan?.mode === LeadMode.Planning
      )
        row.specification.coverageRevision = undefined;
    });
    presentation.refresh(ctx);
  });
  const checkCurrent = async (
    record: T,
    revision: string,
    ctx: ExtensionContext,
  ) => {
    try {
      await scope.check(record, revision);
    } catch (error) {
      if (error instanceof BeadChanged) {
        db.change(id, (row) => {
          if (
            row.revision === revision &&
            row.specification?.acceptedRevision === revision
          )
            row.specification = {
              ...row.specification,
              coverageRevision: undefined,
            };
        });
        presentation.refresh(ctx);
      }
      throw error;
    }
  };
  async function showQuestion(
    ctx: ExtensionContext,
    spec: NonNullable<Attempt["specification"]>,
    signal?: AbortSignal,
  ) {
    const exchange = spec.exchange;
    if (exchange === undefined || exchange.answer !== undefined)
      throw new Error("There is no unanswered Socrates question");
    if (!ctx.hasUI) throw new Error("Open the Pi TUI to answer");
    const record = await requireBinding(ctx);
    await checkCurrent(record, spec.acceptedRevision, ctx);
    approvalPending(true);
    try {
      const answer = await ask(ctx, exchange.prompt, signal);
      if (answer === undefined) return undefined;
      await requireBinding(ctx);
      await checkCurrent(record, spec.acceptedRevision, ctx);
      db.change(id, (row) => {
        if (
          row.leadPlan?.mode !== LeadMode.Planning ||
          row.revision !== spec.acceptedRevision ||
          !isDeepStrictEqual(row.leadPlan.draft, record.leadPlan?.draft) ||
          !isDeepStrictEqual(row.specification, spec)
        )
          throw new Error(
            "This Socrates question changed before the answer was saved",
          );
        row.specification = { ...spec, exchange: { ...exchange, answer } };
      });
      presentation.refresh(ctx);
      return answer;
    } finally {
      approvalPending(false);
    }
  }

  pi.registerTool({
    name: askTool,
    label: "Ask a question",
    description:
      "Ask one open Socrates decision from the saved draft. Use an empty options list for free text. A cancelled dialog leaves the question open until the operator invokes /socrates.",
    executionMode: "sequential",
    renderCall(_args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("Ask a question")),
        0,
        0,
      );
    },
    parameters: Type.Object({
      decisionId: Type.String(),
      question: Type.String(),
      context: Type.Optional(
        Type.String({
          description:
            "Optional question context, rendered as Markdown in the detail view",
        }),
      ),
      evidence: questionEvidenceParameter,
      options: Type.Array(
        Type.Object({
          label: Type.String(),
          description: Type.String({
            description: "Short tradeoff shown beside the choice",
          }),
          details: Type.Optional(
            Type.String({
              description:
                "Longer Markdown explanation shown in the preview and detail view",
            }),
          ),
          evidence: questionEvidenceParameter,
        }),
        { maxItems: 4 },
      ),
    }),
    async execute(_call, params, signal, _update, ctx) {
      if (!ctx.hasUI) throw new Error("Open the Pi TUI to answer");
      const record = await requireBinding(ctx);
      const prompt = specQuestion.parse(params);
      const spec = record.specification;
      if (
        spec?.status !== SpecStatus.Interrogating ||
        record.leadPlan?.mode !== LeadMode.Planning ||
        spec.acceptedRevision !== record.revision ||
        spec.exchange !== undefined
      )
        throw new Error(
          "Resolve the saved Socrates question before asking another",
        );
      if (
        !coverageFresh(spec, record.revision) ||
        !assessedSpecDraft.safeParse(spec.draft).success
      )
        throw new Error(
          "Save current assessments for every applicable property before asking a new question",
        );
      if (
        spec.draft?.blockingQuestions.includes(prompt.question) !== true ||
        !spec.draft.decisions.some(
          (entry) =>
            isTrackedDecision(entry) &&
            entry.id === prompt.decisionId &&
            entry.disposition === DecisionDisposition.Open,
        )
      )
        throw new Error(
          "Save this exact question and its open decision in the draft first",
        );
      await checkCurrent(record, spec.acceptedRevision, ctx);
      const pending = { ...spec, exchange: { prompt } };
      db.change(id, (row) => {
        if (
          row.leadPlan?.mode !== LeadMode.Planning ||
          row.revision !== spec.acceptedRevision ||
          !isDeepStrictEqual(row.leadPlan.draft, record.leadPlan?.draft) ||
          !isDeepStrictEqual(row.specification, spec)
        )
          throw new Error("The Socrates draft changed before asking");
        row.specification = pending;
      });
      presentation.refresh(ctx);
      const answer = await showQuestion(ctx, pending, signal);
      return {
        content: [
          {
            type: "text",
            text:
              answer === undefined
                ? "Question remains open. Wait for the operator to resume with /socrates."
                : `Operator answer for ${prompt.decisionId}: ${answer.text}`,
          },
        ],
        details: { answer, decisionId: prompt.decisionId },
      };
    },
  });

  pi.registerCommand("socrates", {
    description: `Start or inspect Socrates discovery for ${scope.subject}`,
    async handler(_argument, ctx) {
      if (!ctx.isIdle()) throw new Error("Wait for the lead turn to settle");
      await scope.select?.(_argument, ctx);
      const record = await requireBinding(ctx);
      const spec = record.specification;
      if (spec !== undefined) presentation.open(ctx);
      if (spec?.status === SpecStatus.Interrogating) {
        await socratesGuidance();
        if (record.revision !== spec.acceptedRevision)
          throw new Error("Refresh the Socrates brief before resuming");
        await checkCurrent(record, spec.acceptedRevision, ctx);
        if (spec.exchange !== undefined) {
          if (
            spec.exchange.answer !== undefined ||
            (await showQuestion(ctx, spec)) !== undefined
          )
            pi.sendUserMessage(
              "Resume Socrates discovery using the recorded operator answer.",
            );
          return;
        }
        if (
          spec.draft === null ||
          spec.draft.blockingQuestions.length > 0 ||
          !specDraft.safeParse(spec.draft).success ||
          (scope.discovery === true
            ? specificationGaps(spec, record.revision)
            : propertyGaps(spec, record.revision)
          ).length > 0
        ) {
          pi.sendUserMessage(`Resume Socrates discovery for ${scope.subject}.`);
          return;
        }
      }
      if (spec !== undefined) {
        if (
          scope.discovery === true &&
          record.approved === undefined &&
          record.handoff === undefined &&
          spec.status === SpecStatus.Frozen &&
          propertyGaps(spec, record.revision).length > 0
        ) {
          pi.sendUserMessage(
            "Reassess all properties of the frozen specification against the current work breakdown. Preserve the frozen specification and save only updated coverage. Revise the plan to resolve remaining gaps, or offer /spec-reopen if the specification itself must change.",
          );
          return;
        }
        if (scope.discovery !== true) await viewSpecification(ctx);
        return;
      }
      if (
        record.revision === null ||
        record.leadPlan?.mode !== LeadMode.Planning
      )
        throw new Error("Start Socrates before approving implementation");
      await socratesGuidance();
      const acceptedRevision = record.revision;
      await checkCurrent(record, acceptedRevision, ctx);
      db.change(id, (row) => {
        if (
          row.specification !== undefined ||
          row.leadPlan?.mode !== LeadMode.Planning ||
          row.revision !== acceptedRevision
        )
          throw new Error("The planning session changed");
        row.specification = {
          status: SpecStatus.Interrogating,
          version: 1,
          draft: null,
          acceptedRevision,
        };
        if (scope.discovery !== true)
          row.leadPlan = { ...row.leadPlan, draft: null };
      });
      presentation.open(ctx);
      pi.sendUserMessage(
        `Begin Socrates discovery for ${scope.subject} using the shared procedure.`,
      );
    },
  });
  pi.registerTool({
    name: specTool,
    label: "Draft Socrates specification",
    description:
      "Save the current Socrates specification, outstanding questions, and evidence-backed property assessments. Assess every universal and selected-domain property against this draft and the current work breakdown. For missing evidence, use open and name the gap. After freeze a daily-driver discovery accepts coverage-only updates against a revised plan. The operator freezes it in /spec-freeze.",
    executionMode: "sequential",
    parameters: Type.Object({
      objective: Type.String(),
      scope: Type.Array(Type.String()),
      requirements: Type.Array(
        Type.Object({
          id: Type.String(),
          outcome: Type.String(),
          acceptance: Type.String(),
        }),
      ),
      decisions: Type.Array(
        Type.Object({
          id: Type.String(),
          decision: Type.String(),
          disposition: Type.Enum(DecisionDisposition),
          uncertainty: Type.String({
            description:
              "Remaining uncertainty, consequence, and check, or None",
          }),
          supersedes: Type.Optional(Type.String()),
          basis: Type.Union([
            Type.Literal("observed"),
            Type.Literal("decided"),
            Type.Literal("assumed"),
          ]),
          evidence: Type.String(),
        }),
      ),
      blockingQuestions: Type.Array(Type.String()),
      deliveryPolicy: deliveryPolicyParameter,
      coverage: Type.Object(
        {
          domains: Type.Array(
            Type.Union(coverageDomains.map((domain) => Type.Literal(domain))),
          ),
          assessments: Type.Array(
            Type.Object({
              propertyId: Type.Union(
                coveragePropertyIds.map((property) => Type.Literal(property)),
              ),
              status: Type.Union(
                coverageStatuses.map((status) => Type.Literal(status)),
              ),
              reason: Type.String({
                description:
                  "Evidence or concrete rationale for every assessed property. For partial, name what holds and what is missing. Reference requirements, decisions, or sources where relevant.",
              }),
            }),
            { maxItems: coveragePropertyIds.length },
          ),
          focus: Type.Optional(
            Type.Union(
              coveragePropertyIds.map((property) => Type.Literal(property)),
            ),
          ),
        },
        {
          description:
            "Replace all assessments on every draft. Include each universal property and each property in the selected domains exactly once, with a reason. Focus identifies the next property to address.",
        },
      ),
    }),
    async execute(_call, params, _signal, _update, ctx) {
      const record = await requireBinding(ctx);
      const draft = assessedSpecDraft.parse(params);
      if (record.revision === null)
        throw new Error("The accepted revision is missing");
      await checkCurrent(record, record.revision, ctx);
      db.change(id, (row) => {
        const specification = row.specification;
        if (
          specification === undefined ||
          (specification.status === SpecStatus.Frozen &&
            scope.discovery !== true) ||
          row.approved !== undefined ||
          row.handoff !== undefined ||
          specification.acceptedRevision !== row.revision ||
          record.revision !== row.revision ||
          row.leadPlan?.mode !== LeadMode.Planning
        )
          throw new Error("Start or refresh Socrates before drafting");
        if (
          specification.exchange !== undefined &&
          specification.exchange.answer === undefined
        )
          throw new Error(
            "Resume /socrates to resolve the open question before replacing the draft",
          );
        if (
          !isDeepStrictEqual(record.specification, specification) ||
          !isDeepStrictEqual(record.leadPlan?.draft, row.leadPlan.draft)
        )
          throw new Error(
            "The specification or work breakdown changed. Reassess the current draft before saving.",
          );
        preserveDecisions(specification.draft, draft);
        const next = { ...specification, draft, exchange: undefined };
        if (specification.status === SpecStatus.Frozen) {
          // The freeze protects the brief, requirements, decisions, delivery policy and applicable domains.
          const previousDomains =
            draftCoverage(specification.draft)?.domains ?? [];
          if (
            coverageToken(next) !== coverageToken(specification) ||
            !isDeepStrictEqual(
              new Set(draft.coverage.domains),
              new Set(previousDomains),
            )
          )
            throw new Error(
              "Use /spec-reopen to change the frozen specification or its property domains",
            );
        }
        row.specification = {
          ...next,
          coverageRevision: coverageToken(next),
        };
      });
      presentation.refresh(ctx);
      const saved = db.get(id);
      const spec = saved.specification;
      const gaps =
        spec === undefined
          ? []
          : scope.discovery === true
            ? specificationGaps(spec, saved.revision)
            : propertyGaps(spec, saved.revision);
      const [firstGap] = gaps;
      let message: string;
      if (scope.discovery !== true && draft.blockingQuestions.length > 0)
        message =
          "Draft saved. Resolve the blocking questions with the operator.";
      else if (firstGap !== undefined)
        message =
          spec?.status === SpecStatus.Frozen
            ? `Draft saved. Reconcile the proposed beads or use /spec-reopen if the specification must change. Open item: ${firstGap}`
            : `Draft saved. Update the proposed beads as the work changes. Use evidence or ask one focused question. Open item: ${firstGap}`;
      else if (spec?.status === SpecStatus.Frozen)
        message =
          "Properties satisfied or accounted for against the frozen specification and current plan. Offer /plan-approve for handoff review.";
      else if (scope.discovery === true)
        message =
          "Properties satisfied or accounted for. Update the proposed beads if the specification changed, then offer /spec-freeze for review.";
      else
        message =
          "Draft saved. The operator can inspect it with /socrates-status spec and freeze it with /spec-freeze.";
      return {
        content: [{ type: "text", text: message }],
        details: { gaps },
      };
    },
  });
  pi.registerCommand("spec-freeze", {
    description: "Freeze the reviewed Socrates specification",
    async handler(_argument, ctx) {
      if (!ctx.isIdle()) throw new Error("Wait for the lead turn to settle");
      const record = await requireBinding(ctx);
      const spec = record.specification;
      if (spec?.status === SpecStatus.Interrogating) {
        const gaps =
          scope.discovery === true
            ? specificationGaps(spec, record.revision)
            : propertyGaps(spec, record.revision);
        if (gaps.length > 0)
          throw new Error(
            `Continue /socrates before freezing: ${gaps.join(", ")}`,
          );
      }
      if (
        spec?.status !== SpecStatus.Interrogating ||
        spec.draft === null ||
        spec.draft.blockingQuestions.length > 0 ||
        spec.exchange !== undefined ||
        !specDraft.safeParse(spec.draft).success ||
        record.revision !== spec.acceptedRevision
      )
        throw new Error(
          `Resolve the blocking questions and draft against ${scope.subject}`,
        );
      approvalPending(true);
      try {
        if (
          !(await reviewPlan(
            ctx,
            `Freeze specification for ${scope.label(record)}`,
            specText(spec),
            "freeze spec",
          ))
        )
          return;
        await checkCurrent(record, spec.acceptedRevision, ctx);
        db.change(id, (row) => {
          if (
            !isDeepStrictEqual(row.specification, spec) ||
            !isDeepStrictEqual(row.leadPlan?.draft, record.leadPlan?.draft) ||
            row.leadPlan?.mode !== LeadMode.Planning ||
            row.revision !== spec.acceptedRevision
          )
            throw new Error("The displayed specification changed");
          row.specification = {
            ...spec,
            status: SpecStatus.Frozen,
            approvalAt: new Date().toISOString(),
          };
        });
        presentation.refresh(ctx);
      } finally {
        approvalPending(false);
      }
      pi.sendUserMessage(
        scope.discovery === true
          ? "The operator froze the Socrates specification. Review the proposed beads and requirement links. If the work breakdown changes, save current property assessments against it before presenting /plan-approve. Only operator approval hands it to the runtime."
          : "The operator froze the Socrates specification. Draft its implementation graph. Link each task to requirement IDs and own only normalized worktree-relative paths. Wait for /plan-approve before editing.",
      );
    },
  });
  return presentation;
}

async function ask(
  ctx: ExtensionContext,
  prompt: SpecQuestion,
  signal?: AbortSignal,
) {
  const aborted = () => signal?.aborted === true;
  const options = signal === undefined ? undefined : { signal };
  if (aborted()) return undefined;
  if (prompt.options.length > 0) {
    const selected = await chooseQuestion(ctx, prompt, signal);
    if (selected === undefined || aborted()) return undefined;
    if (selected.kind === QuestionSelectionKind.Choice) {
      const choice = prompt.options[selected.index];
      if (choice === undefined)
        throw new Error("Pi returned an unknown choice");
      return { kind: "option" as const, text: choice.label };
    }
  }
  const title = [
    questionLinks(prompt.question),
    ...(prompt.context === undefined ? [] : [questionLinks(prompt.context)]),
    ...(prompt.evidence ?? []).map((item) =>
      renderQuestionEvidence(item, ctx.cwd),
    ),
  ].join("\n\n");
  const text = (await ctx.ui.input(title, undefined, options))?.trim();
  if (text === undefined || text.length === 0 || aborted()) return undefined;
  if (text.length > 2000)
    throw new Error("Use at most 2000 characters in a Socrates answer");
  return { kind: "custom" as const, text };
}
