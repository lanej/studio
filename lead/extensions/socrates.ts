import { DocumentKind } from "../../planning/model.ts";
import {
  getPlanningDocumentHooks,
  type PlanningDocumentHooks,
} from "../../planning/document-hooks.ts";
import type { PaneKeybindings } from "../../pane-keybindings.ts";
import type { OpenTasks } from "../../tasks/panel.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import type { Attempt, Attempts } from "../../attempts.ts";
import { LeadMode } from "../../lead-plan.ts";
import {
  assessedSpecDraft,
  applyDraftUpdate,
  DecisionDisposition,
  SpecStatus,
  isTrackedDecision,
  preserveDecisions,
  propertyGaps,
  reviewInput,
  specDraft,
  specQuestion,
  specText,
  specificationGaps,
  type ReviewInput,
  type SpecQuestion,
} from "../../socrates/spec.ts";
import { deliveryPolicyParameter } from "../../socrates/delivery-policy.ts";
import { questionEvidenceParameter } from "../../socrates/evidence.ts";
import { questionLinks, renderQuestionEvidence } from "../../socrates/links.ts";
import {
  chooseQuestion,
  QuestionSelectionKind,
} from "../../socrates/selector.ts";
import { socratesGuidance } from "../../socrates/guidance.ts";
import {
  coverageDomains,
  coverageFresh,
  draftCoverage,
  coveragePropertyIds,
  coverageStatuses,
  coverageToken,
  pendingCoverageReview,
  specificationToken,
} from "../../socrates/assessment.ts";
import { registerDiscoveryReview } from "../../socrates/review-context.ts";
import { registerSocratesPresentation } from "../../socrates/presentation.ts";
import type { SocratesState } from "../../socrates/implementation.ts";
import { BeadChanged, TaskBeads } from "../../task-service.ts";
import { reviewPlan, showTask } from "../../ui.ts";

export const askTool = "ask_user_question";
export const specTool = "draft_socrates_specification";

export function registerSocrates(
  pi: ExtensionAPI,
  db: Attempts,
  id: string,
  requireBinding: (ctx: ExtensionContext) => Promise<Attempt>,
  approvalPending: (active: boolean) => void,
  openTasks?: OpenTasks,
  keybindings?: PaneKeybindings,
) {
  return registerSocratesControls(pi, db, id, requireBinding, approvalPending, {
    subject: "the accepted Beads task",
    openTasks,
    keybindings,
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
    openTasks?: OpenTasks | undefined;
    keybindings?: PaneKeybindings | undefined;
    identity(record: T): string;
    label(record: T): string;
    snapshot?(ctx: ExtensionContext): T | undefined;
    check(record: T, revision: string): Promise<void>;
    discovery?: boolean;
    select?(argument: string, ctx: ExtensionContext): Promise<void>;
    documents?: PlanningDocumentHooks;
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
      await showTask(ctx, specText(record.specification), "floating");
    } finally {
      approvalPending(false);
    }
  }
  const checkReview =
    scope.discovery === true
      ? registerDiscoveryReview<T>(
          pi,
          (record) => scope.identity(record),
          (ctx) => scope.snapshot?.(ctx),
        )
      : undefined;
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
    scope.openTasks,
    scope.keybindings,
  );
  // Admission precedes delivery. Retain only the delivered message, including
  // Pi's final content and timestamp, so request context can restore it later.
  const documents = scope.documents ?? getPlanningDocumentHooks(pi);
  let commandPrompt: string | undefined;
  let preparedInput: { owner: string; session: string } | false | undefined;
  pi.on("input", (event) => {
    if (event.streamingBehavior === undefined)
      commandPrompt = event.source === "extension" ? event.text : undefined;
  });
  const retainReviewInput = (
    ctx: ExtensionContext,
    record: T,
    input: ReviewInput,
  ): void => {
    if (
      record.specification === undefined ||
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
        row.specification.pendingReview = pendingCoverageReview(
          row.specification,
          input,
        );
    });
    presentation.refresh(ctx);
  };
  const preparePrompt = (
    prompt: string,
    admitted: boolean,
    feedback: boolean,
    ctx: ExtensionContext,
  ): void => {
    const record =
      admitted && (feedback || commandPrompt !== prompt)
        ? scope.snapshot?.(ctx)
        : undefined;
    preparedInput =
      record === undefined
        ? false
        : {
            owner: scope.identity(record),
            session: ctx.sessionManager.getSessionId(),
          };
    commandPrompt = undefined;
  };
  if (documents !== undefined)
    documents.onPromptAdmission((event, ctx) => {
      preparePrompt(event.prompt, event.admitted, event.feedback, ctx);
    });
  else
    pi.on("before_agent_start", (event, ctx) => {
      if (event.messageType === "user")
        preparePrompt(event.prompt, true, false, ctx);
    });
  pi.on("agent_settled", () => {
    preparedInput = undefined;
  });
  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "user") return;
    const binding = preparedInput;
    preparedInput = undefined;
    if (binding === false) return;
    const internal = commandPrompt;
    commandPrompt = undefined;
    const content = event.message.content;
    const text =
      typeof content === "string"
        ? content
        : content.find((part) => part.type === "text")?.text;
    if (binding === undefined && internal !== undefined && internal === text)
      return;
    try {
      const record = scope.snapshot?.(ctx);
      if (
        binding !== undefined &&
        (record === undefined ||
          binding.owner !== scope.identity(record) ||
          binding.session !== ctx.sessionManager.getSessionId())
      )
        throw new Error(
          "The planning owner changed before operator input was delivered",
        );
      if (record !== undefined)
        retainReviewInput(ctx, record, reviewInput.parse(event.message));
    } catch (error) {
      ctx.abort();
      throw error;
    }
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
        db.change(scope.identity(record), (row) => {
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
      db.change(scope.identity(record), (row) => {
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
          "Save current assessments before asking a new question. Review recent changes and update the affected properties.",
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
      db.change(scope.identity(record), (row) => {
        if (
          row.leadPlan?.mode !== LeadMode.Planning ||
          row.revision !== spec.acceptedRevision ||
          !isDeepStrictEqual(row.leadPlan.draft, record.leadPlan?.draft) ||
          !isDeepStrictEqual(row.specification, spec)
        )
          throw new Error("The Socrates draft changed before asking");
        checkReview?.(row, ctx);
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
            "Review changes since the last assessment and update the affected properties of the frozen specification. Revise the plan to resolve remaining gaps, or offer /spec-reopen if the specification itself must change.",
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
      db.change(scope.identity(record), (row) => {
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
      "Save the specification and property evidence. Supply the complete specification fields when drafting or incorporating an answer. For a coverage-only review, supply just coverage. Start with all applicable assessments, then send only those affected by changes to the brief, decisions, evidence, or plan. The operator freezes the specification in /spec-freeze.",
    executionMode: "sequential",
    parameters: Type.Object({
      expectedRevision: Type.Optional(
        Type.String({
          description:
            "Required when updating an existing specification, including a coverage-only review. Use the exact revision from the document snapshot used to prepare this candidate.",
        }),
      ),
      objective: Type.Optional(Type.String()),
      scope: Type.Optional(Type.Array(Type.String())),
      requirements: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.String(),
            outcome: Type.String(),
            acceptance: Type.String(),
          }),
        ),
      ),
      decisions: Type.Optional(
        Type.Array(
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
      ),
      blockingQuestions: Type.Optional(Type.Array(Type.String())),
      deliveryPolicy: deliveryPolicyParameter,
      coverage: Type.Object(
        {
          domains: Type.Optional(
            Type.Array(
              Type.Union(coverageDomains.map((domain) => Type.Literal(domain))),
            ),
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
            "List the applicable domains when supplying specification fields. Coverage-only updates inherit the saved domains. Assess all applicable properties on the first draft or a new baseline, and all new properties when adding a domain. Otherwise send only changed assessments. An empty assessments array records a review with no property changes. Focus identifies the next property to address.",
        },
      ),
    }),
    async execute(_call, params, _signal, _update, ctx) {
      const record = await requireBinding(ctx);
      const { expectedRevision, ...candidate } = params;
      if (record.revision === null)
        throw new Error("The accepted revision is missing");
      await checkCurrent(record, record.revision, ctx);
      db.change(scope.identity(record), (row) => {
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
        checkReview?.(row, ctx);
        documents?.assertAgent(
          DocumentKind.Specification,
          { ...row, id: scope.identity(row) },
          ctx,
          expectedRevision,
        );
        const draft = applyDraftUpdate(
          specification,
          specification.acceptedRevision,
          candidate,
        );
        preserveDecisions(specification.draft, draft);
        const next = {
          ...specification,
          draft,
          exchange: undefined,
          pendingReview: undefined,
        };
        if (specification.status === SpecStatus.Frozen) {
          // The freeze protects the brief, requirements, decisions, delivery policy and applicable domains.
          const previousDomains =
            draftCoverage(specification.draft)?.domains ?? [];
          if (
            specificationToken(next) !== specificationToken(specification) ||
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
      documents?.committed(DocumentKind.Specification, ctx);
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
      if (
        scope.discovery !== true &&
        (spec?.draft?.blockingQuestions.length ?? 0) > 0
      )
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
        db.change(scope.identity(record), (row) => {
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
  return { ...presentation, checkReview };
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
