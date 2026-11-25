import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import { stateDirectory, type Attempt } from "../attempts.ts";
import { LeadMode, draftSchema } from "../lead-plan.ts";
import {
  SpecStatus,
  preserveDecisions,
  specDraft,
  assessedSpecDraft,
} from "../socrates/spec.ts";
import { saveDiscoveryPlan } from "../discovery/store.ts";
import {
  DocumentKind,
  DocumentOwnerKind,
  type DocumentRef,
  type DocumentSnapshot,
} from "./model.ts";
import { parseDocument, renderPlan, renderSpecification } from "./codec.ts";
import { documentRevision } from "./revisions.ts";
import {
  DocumentJournal,
  FeedbackState,
  saveDraftSchema,
  selectionFeedbackSchema,
  type FeedbackRecord,
  type DocumentChange,
} from "./feedback.ts";

export const documentReadTool = "read_studio_documents";
export const documentOutcomeTool = "document_feedback_outcome";

export interface DocumentState {
  id: string;
  revision: string | null;
  specification?: Attempt["specification"];
  leadPlan?: Attempt["leadPlan"];
  planSpecificationRevision?: string | undefined;
  approved?: string | undefined;
  handoff?: { phase: string } | undefined;
}
export interface DocumentOwner {
  kind: DocumentOwnerKind;
  id: string;
  project: string;
  conversationId: string;
  read(): DocumentState;
  change(update: (record: DocumentState) => void): unknown;
  validate(ctx: ExtensionContext): Promise<void>;
}
export interface DocumentHostAdapter {
  current(ctx: ExtensionContext): DocumentOwner | undefined;
  changed?(ctx: ExtensionContext): void;
}
export interface DocumentPromptAdmission {
  prompt: string;
  feedback: boolean;
  admitted: boolean;
}
const hosts = new WeakMap<ExtensionAPI, DocumentHost>();
export function getDocumentHost(pi: ExtensionAPI): DocumentHost | undefined {
  return hosts.get(pi);
}
export function registerDocumentHost(
  pi: ExtensionAPI,
  adapter: DocumentHostAdapter,
): DocumentHost {
  const host = new DocumentHost(pi, adapter);
  hosts.set(pi, host);
  return host;
}

function refFor(owner: DocumentOwner, kind: DocumentKind): DocumentRef {
  return {
    ownerKind: owner.kind,
    ownerId: owner.id,
    conversationId: owner.conversationId,
    project: owner.project,
    kind,
  };
}
function ownerMatches(owner: DocumentOwner, ref: DocumentRef): boolean {
  return isDeepStrictEqual(refFor(owner, ref.kind), ref);
}
export function revisionFor(ref: DocumentRef, record: DocumentState): string {
  const draft =
    ref.kind === DocumentKind.Specification
      ? record.specification?.draft
      : record.leadPlan?.draft;
  const guards = JSON.parse(
    JSON.stringify({
      revision: record.revision,
      specification: record.specification,
      leadPlan: record.leadPlan,
      planSpecificationRevision: record.planSpecificationRevision,
      approved: record.approved,
      handoff: record.handoff,
    }),
  ) as unknown;
  return documentRevision(ref, draft ?? null, guards);
}
function protectedReason(
  record: DocumentState,
  kind: DocumentKind,
  ownerKind: DocumentOwnerKind,
): string | undefined {
  if (record.handoff !== undefined && record.handoff.phase !== "complete")
    return "Reconcile the pending Studio handoff before editing";
  if (
    record.approved !== undefined ||
    record.leadPlan?.mode !== LeadMode.Planning
  )
    return "This plan is protected; use Studio's existing reopen controls";
  if (kind === DocumentKind.Specification) {
    if (
      record.specification?.draft != null &&
      !specDraft.safeParse(record.specification.draft).success
    )
      return "This legacy specification is read-only; ask Studio to redraft it with current decision metadata before editing";
    if (
      record.specification?.draft != null &&
      !assessedSpecDraft.safeParse(record.specification.draft).success
    )
      return "This specification needs a complete property assessment; ask Studio to reassess it before editing";
    if (record.specification?.status !== SpecStatus.Interrogating)
      return "Reopen the frozen specification in Studio before editing";
    if (record.specification.acceptedRevision !== record.revision)
      return "Refresh the accepted task revision in Studio";
    if (record.specification.exchange !== undefined)
      return "Resolve the pending Socrates exchange in Studio before editing";
  } else if (
    ownerKind === DocumentOwnerKind.Attempt &&
    record.specification !== undefined &&
    (record.specification.status !== SpecStatus.Frozen ||
      record.specification.draft === null ||
      record.specification.acceptedRevision !== record.revision)
  ) {
    return "Freeze the current specification in Studio before editing its plan";
  }
  return undefined;
}
export function snapshotFor(
  owner: DocumentOwner,
  record: DocumentState,
  kind: DocumentKind,
): DocumentSnapshot | undefined {
  const ref = refFor(owner, kind);
  const reason = protectedReason(record, kind, owner.kind);
  const draft =
    kind === DocumentKind.Specification
      ? record.specification?.draft
      : record.leadPlan?.draft;
  if (draft === undefined || draft === null) return undefined;
  const markdown =
    kind === DocumentKind.Specification
      ? renderSpecification(
          record.specification?.draft ??
            (() => {
              throw new Error("Missing specification");
            })(),
        )
      : renderPlan(
          record.leadPlan?.draft ??
            (() => {
              throw new Error("Missing plan");
            })(),
        );
  return {
    ref,
    revision: revisionFor(ref, record),
    markdown,
    writable: reason === undefined,
    ...(reason === undefined ? {} : { reason }),
  };
}
function applyDocument(
  record: DocumentState,
  kind: DocumentKind,
  markdown: string,
  ownerKind: DocumentOwnerKind,
): void {
  const reason = protectedReason(record, kind, ownerKind);
  if (reason !== undefined) throw new Error(reason);
  const parsed = parseDocument(kind, markdown);
  if (parsed.kind === DocumentKind.Specification) {
    const draft = assessedSpecDraft.parse(parsed.draft);
    const spec = record.specification;
    if (spec === undefined) throw new Error("No specification exists");
    preserveDecisions(spec.draft, draft);
    // An editor can revise prose, but cannot certify the old assessment against new content.
    record.specification = { ...spec, draft, coverageRevision: undefined };
  } else {
    const draft = draftSchema.parse(parsed.draft);
    if (record.leadPlan === undefined) throw new Error("No plan exists");
    if (ownerKind === DocumentOwnerKind.Discovery) {
      const proposal = { ...record, leadPlan: record.leadPlan };
      saveDiscoveryPlan(proposal, draft);
      record.leadPlan = proposal.leadPlan;
      record.planSpecificationRevision = proposal.planSpecificationRevision;
    } else {
      validatePlanRequirements(record, draft);
      record.leadPlan = { ...record.leadPlan, draft };
    }
  }
}
function validatePlanRequirements(
  record: DocumentState,
  draft: ReturnType<typeof draftSchema.parse>,
): void {
  const specification = record.specification;
  if (specification === undefined) return;
  const requirements =
    specification.draft?.requirements.map((item) => item.id) ?? [];
  if (
    draft.tasks.some(
      (task) =>
        task.requirements.length === 0 ||
        task.requirements.some((id) => !requirements.includes(id)),
    ) ||
    (draft.tasks.length > 0 &&
      requirements.some(
        (id) => !draft.tasks.some((task) => task.requirements.includes(id)),
      ))
  )
    throw new Error(
      "Cover every frozen requirement and link each task to known requirement IDs",
    );
}

interface ActiveFeedback {
  requestId: string;
  prompt: string;
  observed: boolean;
  timer?: ReturnType<typeof setTimeout>;
  changes: DocumentChange[];
  outcome?: { summary: string; callId: string };
}

export class DocumentHost {
  private ctx: ExtensionContext | undefined;
  private generation = randomUUID();
  private journal: DocumentJournal | undefined;
  private known = new Map<
    DocumentKind,
    { ref: DocumentRef; revision: string; markdown?: string }
  >();
  private listeners = new Set<() => void>();
  private promptListeners = new Set<
    (admission: DocumentPromptAdmission, ctx: ExtensionContext) => void
  >();
  private dialogs = 0;
  private active: ActiveFeedback | undefined;
  private dispatching = false;
  private disposed = false;
  private saves = 0;
  private blockedRun: string | undefined;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly adapter: DocumentHostAdapter,
  ) {
    pi.on("session_start", (_event, ctx) => {
      this.reset(ctx);
    });
    pi.on("session_tree", (_event, ctx) => {
      this.reset(ctx);
    });
    pi.on("session_shutdown", () => {
      this.dispose();
    });
    pi.on("before_agent_start", (event, ctx) => {
      this.ctx = ctx;
      this.blockedRun = undefined;
      const active = this.active;
      const request =
        event.messageType === "user"
          ? this.journal
              ?.list()
              .find((row) => feedbackPrompt(row) === event.prompt)
          : undefined;
      if (request !== undefined) {
        if (
          active?.requestId !== request.requestId ||
          request.generation !== this.generation
        ) {
          this.blockedRun =
            "This feedback delivery is no longer admitted; inspect its original chat before retrying";
        } else {
          active.observed = true;
          clearTimeout(active.timer);
          try {
            this.requireOwner(request.ref);
            this.store().change(request.requestId, (row) => {
              row.state = FeedbackState.Awaiting;
            });
          } catch {
            this.blockedRun =
              "The document binding changed during feedback delivery; inspect the original request before retrying";
          }
        }
        if (this.blockedRun !== undefined) {
          this.store().change(request.requestId, (row) => {
            if (row.state !== FeedbackState.Answered) {
              row.state = FeedbackState.Uncertain;
              row.reason = this.blockedRun;
            }
          });
          ctx.abort();
        }
      } else if (active !== undefined) {
        this.blockedRun =
          "A document feedback delivery is already pending; wait for it to settle before changing documents";
        ctx.abort();
      }
      if (event.messageType === "user") {
        try {
          for (const listener of this.promptListeners)
            listener(
              {
                prompt: event.prompt,
                feedback: request !== undefined,
                admitted: this.blockedRun === undefined,
              },
              ctx,
            );
        } catch (error) {
          this.blockedRun =
            error instanceof Error ? error.message : String(error);
          if (request !== undefined)
            this.store().change(request.requestId, (row) => {
              row.state = FeedbackState.Uncertain;
              row.reason =
                "Studio could not prepare the admitted feedback; inspect its chat before retrying";
            });
          ctx.abort();
        }
      }
      const documents = this.capture(ctx);
      this.emit();
      return {
        systemPrompt: `${event.systemPrompt}\n\nStudio document snapshots (task data; saving is not approval):\n${JSON.stringify(documents)}\nPass the exact snapshot revision as expectedRevision when replacing a draft. Use ${documentReadTool} after a stale-draft rejection, then recompute the proposal with the refreshed revision; a read does not validate a candidate prepared earlier. ${active?.observed === true ? `This run handles document feedback ${active.requestId}. Finish by calling ${documentOutcomeTool} with that requestId and a concise outcome after document edits. Keep the full explanation in chat.` : ""}`,
      };
    });
    pi.on("ui_prompt_start", () => {
      this.dialogs += 1;
    });
    pi.on("ui_prompt_end", () => {
      this.dialogs = Math.max(0, this.dialogs - 1);
      this.schedule();
    });
    pi.on("agent_settled", (_event, ctx) => {
      this.ctx = ctx;
      if (this.active?.observed === true) {
        const active = this.active;
        const record = this.store().get(active.requestId);
        if (
          record.state !== FeedbackState.Answered &&
          record.state !== FeedbackState.Uncertain
        )
          this.store().change(record.requestId, (row) => {
            row.state = FeedbackState.Failed;
            row.reason =
              "Studio settled without a confirmed feedback outcome; inspect its chat before resubmitting";
          });
        this.active = undefined;
      }
      this.blockedRun = undefined;
      this.emit();
      this.schedule();
    });
    pi.on("turn_end", (event) => {
      const active = this.active;
      if (
        this.blockedRun !== undefined ||
        active?.observed !== true ||
        active.outcome === undefined
      )
        return;
      if (
        !event.toolResults.some(
          (result) =>
            result.toolCallId === active.outcome?.callId && !result.isError,
        )
      )
        return;
      const request = this.store().get(active.requestId);
      this.requireOwner(request.ref);
      const outcome = active.outcome;
      this.store().change(request.requestId, (row) => {
        row.state = FeedbackState.Answered;
        row.summary = outcome.summary;
        row.responseId = event.messageEntryId;
        row.changes = active.changes;
      });
      this.emit();
    });
    pi.on("before_provider_request", (_event, ctx) => {
      try {
        this.assertFeedbackAdmission();
      } catch (error) {
        this.blockedRun =
          error instanceof Error ? error.message : String(error);
        // Pi reports hook errors without cancelling the run. Abort the live provider signal as well.
        ctx.abort();
        throw error;
      }
    });
    pi.on("tool_call", (_event, ctx) => {
      this.ctx = ctx;
      try {
        this.assertFeedbackAdmission();
      } catch (error) {
        return {
          block: true,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      return undefined;
    });
    pi.registerTool({
      name: documentReadTool,
      label: "Read Studio documents",
      description:
        "Read the selected specification and plan with their exact revisions. Recompute replacements from this content and pass its revision as expectedRevision; this read does not authorize previously prepared candidates.",
      parameters: Type.Object({}),
      execute: (_call, _params, _signal, _update, ctx) =>
        Promise.resolve({
          content: [{ type: "text", text: JSON.stringify(this.capture(ctx)) }],
          details: {},
        }),
    });
    pi.registerTool({
      name: documentOutcomeTool,
      label: "Record document feedback outcome",
      description:
        "After responding to the active selection feedback and making any document changes, record a short outcome. The host links only actual committed document revisions; this does not save or approve anything.",
      parameters: Type.Object({
        requestId: Type.String(),
        summary: Type.String(),
      }),
      execute: (callId, params, _signal, _update, ctx) => {
        this.ctx = ctx;
        this.assertFeedbackAdmission();
        const active = this.active;
        if (active?.observed !== true || params.requestId !== active.requestId)
          throw new Error("No matching active document feedback request");
        this.requireOwner(this.store().get(active.requestId).ref);
        const summary = params.summary.trim();
        if (summary.length === 0 || summary.length > 1000)
          throw new Error(
            "Use a concise nonempty outcome of at most 1000 characters",
          );
        active.outcome = { summary, callId };
        return Promise.resolve({
          content: [{ type: "text", text: summary }],
          details: { requestId: active.requestId },
        });
      },
    });
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Apply user-admission state changes before supplying revision-bound model context. */
  onPromptAdmission(
    listener: (
      admission: DocumentPromptAdmission,
      ctx: ExtensionContext,
    ) => void,
  ): () => void {
    this.promptListeners.add(listener);
    return () => {
      this.promptListeners.delete(listener);
    };
  }
  pending(): boolean {
    return this.active !== undefined || this.dispatching || this.saves > 0;
  }
  private emit(): void {
    for (const listener of this.listeners) listener();
  }
  private store(): DocumentJournal {
    this.journal ??= new DocumentJournal(stateDirectory());
    return this.journal;
  }
  private reset(ctx: ExtensionContext): void {
    this.finishUncertain(
      "Studio conversation or branch changed; inspect the original request before retrying",
    );
    this.ctx = ctx;
    this.generation = randomUUID();
    this.known.clear();
    this.blockedRun = undefined;
    this.disposed = false;
    this.emit();
  }
  private finishUncertain(reason: string): void {
    if (this.active !== undefined) {
      clearTimeout(this.active.timer);
      const record = this.store().get(this.active.requestId);
      if (record.state !== FeedbackState.Answered)
        this.store().change(record.requestId, (row) => {
          row.state = FeedbackState.Uncertain;
          row.reason = reason;
        });
      this.active = undefined;
    }
  }
  dispose(): void {
    this.finishUncertain(
      "The Studio process closed before a confirmed response",
    );
    this.disposed = true;
    this.journal?.close();
    this.journal = undefined;
    this.ctx = undefined;
    this.known.clear();
  }
  private owner(): DocumentOwner | undefined {
    return this.ctx === undefined ? undefined : this.adapter.current(this.ctx);
  }
  private requireOwner(ref: DocumentRef): DocumentOwner {
    const owner = this.owner();
    if (owner === undefined || !ownerMatches(owner, ref))
      throw new Error(
        "The owning Studio document is no longer selected; return to its discovery before continuing",
      );
    return owner;
  }
  private assertFeedbackAdmission(): void {
    if (this.blockedRun !== undefined) throw new Error(this.blockedRun);
    if (this.active !== undefined) {
      const request = this.store().get(this.active.requestId);
      if (request.generation !== this.generation || !this.active.observed)
        throw new Error(
          "The pending feedback has not been admitted to this agent run; wait for delivery to settle",
        );
      this.requireOwner(request.ref);
    }
  }
  capture(ctx: ExtensionContext): DocumentSnapshot[] {
    this.ctx = ctx;
    const owner = this.owner();
    this.known.clear();
    if (owner === undefined) return [];
    const record = owner.read();
    for (const kind of Object.values(DocumentKind)) {
      const ref = refFor(owner, kind);
      const markdown = snapshotFor(owner, record, kind)?.markdown;
      this.known.set(kind, {
        ref,
        revision: revisionFor(ref, record),
        ...(markdown === undefined ? {} : { markdown }),
      });
    }
    return this.snapshots(owner, record);
  }
  private snapshots(
    owner: DocumentOwner,
    record = owner.read(),
  ): DocumentSnapshot[] {
    return Object.values(DocumentKind).flatMap((kind) => {
      const snapshot = snapshotFor(owner, record, kind);
      return snapshot === undefined ? [] : [snapshot];
    });
  }
  assertAgent(
    kind: DocumentKind,
    record: DocumentState,
    ctx: ExtensionContext,
    expectedRevision?: string,
  ): void {
    this.ctx = ctx;
    this.assertFeedbackAdmission();
    const owner = this.owner();
    if (owner === undefined || owner.id !== record.id)
      throw new Error(
        "The document owner changed before this proposal was saved",
      );
    const ref = refFor(owner, kind);
    const known = this.known.get(kind);
    const empty =
      kind === DocumentKind.Specification
        ? record.specification?.draft == null
        : record.leadPlan?.draft == null;
    if (
      (!empty && expectedRevision === undefined) ||
      (expectedRevision !== undefined &&
        expectedRevision !== revisionFor(ref, record))
    )
      throw new Error(
        `The Studio document changed after the agent read it, or the candidate has no expectedRevision. Call ${documentReadTool}, then recompute the candidate with that document's exact revision in expectedRevision.`,
      );
    // Initial tool-created discoveries have no preceding snapshot; only an absent draft can use this path.
    if (known === undefined && empty) {
      this.known.set(kind, { ref, revision: revisionFor(ref, record) });
      return;
    }
    if (
      known === undefined ||
      !isDeepStrictEqual(known.ref, ref) ||
      known.revision !== revisionFor(ref, record)
    )
      throw new Error(
        `The Studio document changed after the agent read it. Call ${documentReadTool}, preserve current edits, and recompute this proposal.`,
      );
  }
  committed(kind: DocumentKind, ctx: ExtensionContext): void {
    this.ctx = ctx;
    const owner = this.owner();
    if (owner === undefined) return;
    const ref = refFor(owner, kind);
    const before = this.known.get(kind);
    const after = revisionFor(ref, owner.read());
    const snapshot = snapshotFor(owner, owner.read(), kind);
    this.known.set(kind, {
      ref,
      revision: after,
      ...(snapshot === undefined ? {} : { markdown: snapshot.markdown }),
    });
    if (
      this.active?.observed === true &&
      before !== undefined &&
      before.revision !== after
    ) {
      const previous = this.active.changes.find((change) =>
        isDeepStrictEqual(change.ref, ref),
      );
      const change: DocumentChange = {
        ref,
        beforeRevision: previous?.beforeRevision ?? before.revision,
        afterRevision: after,
        ...(snapshot === undefined
          ? {}
          : {
              range: changedRange(before.markdown ?? "", snapshot.markdown),
            }),
      };
      if (previous === undefined) this.active.changes.push(change);
      else Object.assign(previous, change);
    }
    this.adapter.changed?.(ctx);
    this.emit();
  }
  sync(): Promise<{
    documents: DocumentSnapshot[];
    feedback: FeedbackRecord[];
  }> {
    const owner = this.owner();
    if (owner === undefined)
      return Promise.resolve({ documents: [], feedback: [] });
    const feedback = this.store()
      .list()
      .filter(
        (record) =>
          record.ref.conversationId === owner.conversationId &&
          record.ref.project === owner.project,
      );
    for (const record of feedback) {
      if (
        record.generation !== this.generation &&
        [
          FeedbackState.Queued,
          FeedbackState.Dispatching,
          FeedbackState.Awaiting,
        ].includes(record.state)
      )
        this.store().change(record.requestId, (row) => {
          row.state = FeedbackState.Uncertain;
          row.reason =
            "This request belongs to an earlier Studio activation; inspect its original chat before resubmitting";
        });
      else if (
        record.state === FeedbackState.Queued &&
        !ownerMatches(owner, record.ref)
      )
        this.store().change(record.requestId, (row) => {
          row.state = FeedbackState.Parked;
          row.reason =
            "Return to the original discovery to process this comment";
        });
      else if (
        record.state === FeedbackState.Parked &&
        record.generation === this.generation &&
        ownerMatches(owner, record.ref)
      )
        this.store().change(record.requestId, (row) => {
          row.state = FeedbackState.Queued;
          delete row.reason;
        });
    }
    this.schedule();
    return Promise.resolve({
      documents: this.snapshots(owner),
      feedback: feedback.map((record) => this.store().get(record.requestId)),
    });
  }
  async save(input: unknown): Promise<DocumentSnapshot> {
    this.saves += 1;
    try {
      return await this.saveDraft(input);
    } finally {
      this.saves -= 1;
    }
  }
  private async saveDraft(input: unknown): Promise<DocumentSnapshot> {
    const generation = this.generation;
    const request = saveDraftSchema.parse(input);
    const owner = this.requireOwner(request.ref);
    const ctx = this.ctx;
    if (ctx === undefined)
      throw new Error("Studio has no current conversation");
    await owner.validate(ctx);
    if (this.generation !== generation || this.disposed)
      throw new Error(
        "The Studio activation changed while validating this save",
      );
    this.requireOwner(request.ref);
    const receipt = this.store().save(request);
    if (receipt.accepted !== undefined) return receipt.accepted;
    let accepted: DocumentSnapshot | undefined;
    owner.change((record) => {
      if (this.generation !== generation || this.disposed)
        throw new Error(
          "The Studio activation changed before this save committed",
        );
      this.requireOwner(request.ref);
      const current = snapshotFor(owner, record, request.ref.kind);
      if (current === undefined) throw new Error("The draft no longer exists");
      if (current.revision !== request.expectedRevision) {
        // A lost receipt can be reconciled only when this exact candidate is already canonical.
        if (current.markdown !== request.markdown)
          throw new Error(
            "The Studio draft changed; compare and reconcile your unsaved text before saving",
          );
        accepted = current;
        return;
      }
      applyDocument(record, request.ref.kind, request.markdown, owner.kind);
      accepted = snapshotFor(owner, record, request.ref.kind);
    });
    if (accepted === undefined)
      throw new Error(
        "The save outcome is uncertain; inspect this operation before retrying",
      );
    this.store().accept(request, accepted);
    this.adapter.changed?.(ctx);
    this.emit();
    return accepted;
  }
  feedback(input: unknown): Promise<FeedbackRecord> {
    return Promise.resolve().then(() => {
      const request = selectionFeedbackSchema.parse(input);
      this.requireOwner(request.ref);
      const record = this.store().submit(request, this.generation);
      this.emit();
      this.schedule();
      return record;
    });
  }
  private schedule(): void {
    queueMicrotask(() => {
      this.pump().catch((error: unknown) => {
        this.ctx?.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      });
    });
  }
  private async pump(): Promise<void> {
    const ctx = this.ctx;
    if (
      this.disposed ||
      this.dispatching ||
      this.active !== undefined ||
      this.journal === undefined ||
      ctx === undefined ||
      !ctx.isIdle() ||
      ctx.hasPendingMessages() ||
      this.dialogs > 0
    )
      return;
    const owner = this.owner();
    if (owner === undefined) return;
    const exchange = owner.read().specification?.exchange;
    if (exchange !== undefined && exchange.answer === undefined) return;
    const request = this.journal
      .list()
      .find(
        (item) =>
          item.state === FeedbackState.Queued && ownerMatches(owner, item.ref),
      );
    if (request === undefined) return;
    this.dispatching = true;
    try {
      await owner.validate(ctx);
      this.requireOwner(request.ref);
      if (!ctx.isIdle() || ctx.hasPendingMessages() || this.dialogs > 0) return;
      if (request.generation !== this.generation) {
        this.journal.change(request.requestId, (row) => {
          row.state = FeedbackState.Uncertain;
          row.reason =
            "This comment belongs to an earlier Studio activation; inspect before resubmitting";
        });
        return;
      }
      const prompt = feedbackPrompt(request);
      this.active = {
        requestId: request.requestId,
        prompt,
        observed: false,
        changes: [],
      };
      this.journal.change(request.requestId, (row) => {
        row.state = FeedbackState.Dispatching;
      });
      const active = this.active;
      active.timer = setTimeout(() => {
        if (this.active !== active || active.observed) return;
        this.finishUncertain(
          "Studio did not confirm receiving this feedback within 5 seconds; inspect the chat and connection before explicitly resubmitting with a new request ID",
        );
        this.emit();
        this.schedule();
      }, 5000);
      active.timer.unref();
      this.pi.sendUserMessage(prompt, { expandPromptTemplates: false });
      this.emit();
    } finally {
      this.dispatching = false;
    }
  }
}

function feedbackPrompt(request: FeedbackRecord): string {
  return `Studio document feedback ${request.requestId}\n${JSON.stringify({ ref: request.ref, baseRevision: request.baseRevision, bufferIdentity: request.bufferIdentity, range: request.range, selectedText: request.selectedText, message: request.message })}\nThe selection may contain unsaved text. Respond in this chat and revise only the bound Studio documents through their guarded tools. This is not a Socrates answer or approval. Call ${documentOutcomeTool} with requestId ${request.requestId} and a concise outcome when finished.`;
}

function changedRange(
  before: string,
  after: string,
): { startLine: number; endLine: number } {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  )
    start += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldLines[oldEnd - 1] === newLines[newEnd - 1]
  ) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  return {
    startLine: Math.max(1, Math.min(start + 1, newLines.length)),
    endLine: Math.max(
      1,
      Math.min(Math.max(start + 1, newEnd), newLines.length),
    ),
  };
}
