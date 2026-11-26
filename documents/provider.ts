import { createHash } from "node:crypto";
import { closeSync, createReadStream, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { create, equals, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { ProviderError, type HostProvider, type SnapshotItem, type SnapshotReader } from "@lanej/copydesk";
import {
  CallContextSchema,
  DocumentRefSchema,
  DocumentSnapshotSchema,
  FeedbackRecordSchema,
  FeedbackState as WireFeedbackState,
  RejectionCode,
  SaveCommandSchema,
  SaveResultSchema,
  SessionRefSchema,
  SyncHeaderSchema,
  type CallContext,
  type DocumentRef as WireDocumentRef,
  type DocumentSnapshot as WireDocumentSnapshot,
  type FeedbackCommand,
  type SaveCommand,
  type SaveResult,
} from "@lanej/copydesk/protocol";
import { z } from "zod";
import { OperationIdReused } from "../operation-witness.ts";
import { type PlanningDocuments, PlanningSaveError, type PlanningBinding } from "../planning/documents.ts";
import { FeedbackRequestReused, FeedbackState, type FeedbackRecord } from "../planning/feedback.ts";
import {
  DocumentKind,
  type DocumentOwnerKind,
  documentRefSchema,
  type DocumentRef,
  type DocumentSnapshot,
} from "../planning/model.ts";

const states = {
  [FeedbackState.Queued]: WireFeedbackState.QUEUED,
  [FeedbackState.Dispatching]: WireFeedbackState.DISPATCHING,
  [FeedbackState.Awaiting]: WireFeedbackState.AWAITING,
  [FeedbackState.Parked]: WireFeedbackState.PARKED,
  [FeedbackState.Answered]: WireFeedbackState.ANSWERED,
  [FeedbackState.Failed]: WireFeedbackState.FAILED,
  [FeedbackState.Uncertain]: WireFeedbackState.UNCERTAIN,
} satisfies Record<FeedbackState, WireFeedbackState>;
const rejectionCodes = {
  invalid: RejectionCode.INVALID,
  conflict: RejectionCode.CONFLICT,
  protected: RejectionCode.PROTECTED,
  wrong_owner: RejectionCode.WRONG_OWNER,
} as const;
const spoolItem = z.strictObject({
  kind: z.enum(["document", "feedback"]),
  value: z.string(),
});
const ownerId = (kind: DocumentOwnerKind, id: string) => `${kind}:${id}`;

/** The protocol sees opaque identities; only this Studio adapter interprets them. */
export class StudioDocumentProvider implements HostProvider {
  readonly context: CallContext;
  constructor(
    private readonly authority: PlanningDocuments,
    private readonly binding: PlanningBinding,
  ) {
    this.context = create(CallContextSchema, {
      generation: binding.generation,
      session: {
        providerId: "studio",
        projectId: createHash("sha256").update(binding.project).digest("hex"),
        conversationId: binding.conversationId,
      },
    });
  }
  private assertCall(call: CallContext): void {
    if (!equals(CallContextSchema, call, this.context))
      throw new ProviderError(
        "failed_precondition",
        "The Studio activation changed; reconnect to its current conversation",
      );
    try {
      this.authority.assertBinding(this.binding);
    } catch (cause) {
      throw new ProviderError("failed_precondition", cause instanceof Error ? cause.message : String(cause));
    }
  }
  private ref(value: DocumentRef): WireDocumentRef {
    if (value.project !== this.binding.project || value.conversationId !== this.binding.conversationId)
      throw new Error("A document belongs to another Studio conversation");
    return create(DocumentRefSchema, {
      session: this.context.session,
      ownerId: ownerId(value.ownerKind, value.ownerId),
      documentId: value.kind,
    });
  }
  private originalRef(value: WireDocumentRef | undefined): DocumentRef {
    if (
      value?.session === undefined ||
      this.context.session === undefined ||
      !equals(SessionRefSchema, value.session, this.context.session)
    )
      throw new PlanningSaveError("wrong_owner", "This document belongs to another Studio conversation");
    const delimiter = value.ownerId.indexOf(":");
    return documentRefSchema.parse({
      ownerKind: value.ownerId.slice(0, delimiter),
      ownerId: value.ownerId.slice(delimiter + 1),
      kind: value.documentId,
      project: this.binding.project,
      conversationId: this.binding.conversationId,
    });
  }
  private document(value: DocumentSnapshot): WireDocumentSnapshot {
    return create(DocumentSnapshotSchema, {
      ref: this.ref(value.ref),
      revision: value.revision,
      title: value.ref.kind === DocumentKind.Specification ? "Specification" : "Implementation plan",
      text: value.markdown,
      writable: value.writable,
      reason: value.reason ?? "",
    });
  }
  private feedback(value: FeedbackRecord) {
    return create(FeedbackRecordSchema, {
      request: {
        requestId: value.requestId,
        ref: this.ref(value.ref),
        baseRevision: value.baseRevision,
        bufferIdentity: value.bufferIdentity,
        range: value.range,
        selectedText: value.selectedText,
        message: value.message,
      },
      generation: value.generation,
      state: states[value.state],
      reason: value.reason ?? "",
      summary: value.summary ?? "",
      responseId: value.responseId ?? "",
      changes: value.changes.map((change) => ({
        ref: this.ref(change.ref),
        beforeRevision: change.beforeRevision,
        afterRevision: change.afterRevision,
        ...(!change.range ? {} : { range: change.range }),
      })),
    });
  }
  openSnapshot(call: CallContext): Promise<SnapshotReader> {
    this.assertCall(call);
    const directory = mkdtempSync(join(tmpdir(), "studio-document-snapshot-"));
    const path = join(directory, "items.jsonl");
    const file = openSync(path, "wx", 0o600);
    let view: ReturnType<PlanningDocuments["visitSnapshot"]>;
    try {
      // No await or aggregate history: one SQLite read view is spooled before events can advance it.
      view = this.authority.visitSnapshot(
        (document) =>
          writeSync(
            file,
            `${JSON.stringify({ kind: "document", value: toJsonString(DocumentSnapshotSchema, this.document(document)) })}\n`,
          ),
        (feedback) =>
          writeSync(
            file,
            `${JSON.stringify({ kind: "feedback", value: toJsonString(FeedbackRecordSchema, this.feedback(feedback)) })}\n`,
          ),
      );
    } catch (cause) {
      closeSync(file);
      rmSync(directory, { recursive: true, force: true });
      throw cause;
    }
    closeSync(file);
    const input = createReadStream(path, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    const values = lines[Symbol.asyncIterator]();
    let closed = false;
    return Promise.resolve({
      header: create(SyncHeaderSchema, {
        session: this.context.session,
        ...(!view.owner ? {} : { activeOwnerId: ownerId(view.owner.kind, view.owner.id) }),
      }),
      async next(): Promise<SnapshotItem | undefined> {
        if (closed) return undefined;
        const line = await values.next();
        if (line.done === true) return undefined;
        const item = spoolItem.parse(JSON.parse(line.value));
        return item.kind === "document"
          ? {
              kind: "document",
              value: fromJsonString(DocumentSnapshotSchema, item.value),
            }
          : {
              kind: "feedback",
              value: fromJsonString(FeedbackRecordSchema, item.value),
            };
      },
      close(): Promise<void> {
        if (!closed) {
          closed = true;
          lines.close();
          input.destroy();
          rmSync(directory, { recursive: true, force: true });
        }
        return Promise.resolve();
      },
    });
  }
  async save(call: CallContext, command: SaveCommand): Promise<SaveResult> {
    this.assertCall(call);
    let ref: DocumentRef;
    try {
      ref = this.originalRef(command.ref);
    } catch (cause) {
      return create(SaveResultSchema, {
        result: {
          case: "rejected",
          value: {
            operationId: command.operationId,
            code: cause instanceof PlanningSaveError ? RejectionCode.WRONG_OWNER : RejectionCode.INVALID,
            reason: cause instanceof Error ? cause.message : String(cause),
          },
        },
      });
    }
    try {
      const accepted = await this.authority.saveWithWitness(
        {
          operationId: command.operationId,
          ref,
          expectedRevision: command.expectedRevision,
          markdown: command.text,
        },
        {
          command: toJsonString(SaveCommandSchema, command),
          presentation: (document) => toJsonString(DocumentSnapshotSchema, this.document(document)),
        },
      );
      if (accepted.presentation === undefined)
        throw new Error("The operation witness has no retained protocol document");
      return create(SaveResultSchema, {
        result: {
          case: "accepted",
          value: {
            operationId: command.operationId,
            document: fromJsonString(DocumentSnapshotSchema, accepted.presentation),
            commitWitnessId: accepted.commitWitnessId,
          },
        },
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      if (cause instanceof OperationIdReused || (cause instanceof PlanningSaveError && cause.code !== "uncertain")) {
        let current: WireDocumentSnapshot | undefined;
        try {
          const value = this.authority.currentDocument(ref);
          if (value) current = this.document(value);
        } catch {
          /* The original owner may no longer be selected. */
        }
        return create(SaveResultSchema, {
          result: {
            case: "rejected",
            value: {
              operationId: command.operationId,
              code:
                cause instanceof OperationIdReused
                  ? RejectionCode.OPERATION_ID_REUSED
                  : rejectionCodes[cause.code === "uncertain" ? "invalid" : cause.code],
              reason,
              ...(current === undefined ? {} : { current }),
            },
          },
        });
      }
      return create(SaveResultSchema, {
        result: {
          case: "uncertain",
          value: { operationId: command.operationId, reason },
        },
      });
    }
  }
  async submitFeedback(call: CallContext, command: FeedbackCommand) {
    this.assertCall(call);
    let ref: DocumentRef;
    try {
      ref = this.originalRef(command.ref);
    } catch (cause) {
      throw new ProviderError("failed_precondition", cause instanceof Error ? cause.message : String(cause));
    }
    try {
      return this.feedback(
        await this.authority.feedback(
          {
            requestId: command.requestId,
            ref,
            baseRevision: command.baseRevision,
            bufferIdentity: command.bufferIdentity,
            range:
              command.range === undefined
                ? undefined
                : {
                    startLine: command.range.startLine,
                    endLine: command.range.endLine,
                  },
            selectedText: command.selectedText,
            message: command.message,
          },
          this.binding,
        ),
      );
    } catch (cause) {
      if (cause instanceof FeedbackRequestReused) throw new ProviderError("already_exists", cause.message);
      if (cause instanceof PlanningSaveError) throw new ProviderError("failed_precondition", cause.message);
      throw cause;
    }
  }
  onChanged(listener: () => void): () => void {
    return this.authority.onChange(listener);
  }
}
