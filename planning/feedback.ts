import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  documentRefSchema,
  documentSnapshotSchema,
  DocumentOwnerKind,
} from "./model.ts";
import { OperationIdReused } from "../operation-witness.ts";

export enum FeedbackState {
  Queued = "queued",
  Dispatching = "dispatching",
  Awaiting = "awaiting",
  Parked = "parked",
  Answered = "answered",
  Failed = "failed",
  Uncertain = "uncertain",
}
export class FeedbackRequestReused extends Error {
  constructor() {
    super("This feedback request ID already belongs to different content");
  }
}

export const selectionFeedbackSchema = z.strictObject({
  requestId: z.string().min(1).max(200),
  ref: documentRefSchema,
  baseRevision: z.string().min(1),
  bufferIdentity: z.string().min(1),
  range: z
    .strictObject({
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive(),
    })
    .refine(
      (range) => range.endLine >= range.startLine,
      "Invalid selection range",
    ),
  selectedText: z.string().max(100_000),
  message: z
    .string()
    .min(1)
    .max(20_000)
    .refine((value) => value.trim().length > 0),
});
export type SelectionFeedback = z.infer<typeof selectionFeedbackSchema>;
export const documentChangeSchema = z.strictObject({
  ref: documentRefSchema,
  beforeRevision: z.string(),
  afterRevision: z.string(),
  range: z
    .strictObject({
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive(),
    })
    .optional(),
});
export type DocumentChange = z.infer<typeof documentChangeSchema>;
const feedbackSchema = selectionFeedbackSchema.extend({
  generation: z.string(),
  state: z.enum(FeedbackState),
  summary: z.string().optional(),
  responseId: z.string().optional(),
  reason: z.string().optional(),
  changes: z.array(documentChangeSchema),
});
export type FeedbackRecord = z.infer<typeof feedbackSchema>;
export const saveDraftSchema = z.strictObject({
  operationId: z.string().min(1).max(200),
  ref: documentRefSchema,
  expectedRevision: z.string().min(1),
  markdown: z.string().max(2_000_000),
});
export type SaveDraft = z.infer<typeof saveDraftSchema>;
const saveReceiptSchema = z.strictObject({
  request: saveDraftSchema,
  reservation: z
    .strictObject({
      version: z.literal(1),
      authority: z.enum(["attempts.sqlite", "discoveries.sqlite"]),
      ownerId: z.string().min(1),
      command: z.string().min(1),
    })
    .optional(),
  commitWitnessId: z.uuid().optional(),
  accepted: documentSnapshotSchema.optional(),
});
export type SaveReceipt = z.infer<typeof saveReceiptSchema>;

/** Retained receipts make a lost IPC reply inspectable without replaying a chat turn. */
export class DocumentJournal {
  private readonly db: Database;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new Database(join(directory, "documents.sqlite"), {
      create: true,
    });
    this.db.run("PRAGMA busy_timeout=5000");
    this.db.run(
      "CREATE TABLE IF NOT EXISTS document_feedback (id TEXT PRIMARY KEY, record TEXT NOT NULL)",
    );
    this.db.run(
      "CREATE TABLE IF NOT EXISTS document_saves (id TEXT PRIMARY KEY, record TEXT NOT NULL)",
    );
  }
  close(): void {
    this.db.close();
  }
  list(): FeedbackRecord[] {
    return this.db
      .query("SELECT record FROM document_feedback ORDER BY rowid")
      .all()
      .map((row) => decode(row, feedbackSchema));
  }
  *records(
    project: string,
    conversation: string,
  ): IterableIterator<FeedbackRecord> {
    for (const row of this.db
      .query(
        "SELECT record FROM document_feedback WHERE json_extract(record,'$.ref.project')=? AND json_extract(record,'$.ref.conversationId')=? ORDER BY rowid",
      )
      .iterate(project, conversation))
      yield decode(row, feedbackSchema);
  }
  reconcile(
    generation: string,
    project: string,
    conversation: string,
    owner?: { id: string; kind: DocumentOwnerKind },
  ): void {
    this.db.run("BEGIN IMMEDIATE");
    try {
      this.db
        .query(
          "UPDATE document_feedback SET record=json_set(record,'$.state',?,'$.reason',?) WHERE json_extract(record,'$.ref.project')=? AND json_extract(record,'$.ref.conversationId')=? AND json_extract(record,'$.generation')!=? AND json_extract(record,'$.state') IN (?,?,?,?)",
        )
        .run(
          FeedbackState.Uncertain,
          "This request belongs to an earlier Studio activation; inspect its original chat before resubmitting",
          project,
          conversation,
          generation,
          FeedbackState.Queued,
          FeedbackState.Dispatching,
          FeedbackState.Awaiting,
          FeedbackState.Parked,
        );
      this.db
        .query(
          "UPDATE document_feedback SET record=json_set(record,'$.state',?,'$.reason',?) WHERE json_extract(record,'$.ref.project')=? AND json_extract(record,'$.ref.conversationId')=? AND json_extract(record,'$.state')=? AND (json_extract(record,'$.ref.ownerId')!=? OR json_extract(record,'$.ref.ownerKind')!=?)",
        )
        .run(
          FeedbackState.Parked,
          "Return to the original discovery to process this comment",
          project,
          conversation,
          FeedbackState.Queued,
          owner?.id ?? "",
          owner?.kind ?? "",
        );
      if (owner !== undefined)
        this.db
          .query(
            "UPDATE document_feedback SET record=json_remove(json_set(record,'$.state',?),'$.reason') WHERE json_extract(record,'$.ref.project')=? AND json_extract(record,'$.ref.conversationId')=? AND json_extract(record,'$.generation')=? AND json_extract(record,'$.state')=? AND json_extract(record,'$.ref.ownerId')=? AND json_extract(record,'$.ref.ownerKind')=?",
          )
          .run(
            FeedbackState.Queued,
            project,
            conversation,
            generation,
            FeedbackState.Parked,
            owner.id,
            owner.kind,
          );
      this.db.run("COMMIT");
    } catch (cause) {
      this.db.run("ROLLBACK");
      throw cause;
    }
  }
  submit(request: SelectionFeedback, generation: string): FeedbackRecord {
    const record: FeedbackRecord = {
      ...request,
      generation,
      state: FeedbackState.Queued,
      changes: [],
    };
    this.db
      .query("INSERT OR IGNORE INTO document_feedback VALUES (?,?)")
      .run(request.requestId, JSON.stringify(record));
    const retained = this.submitted(request);
    if (retained === undefined)
      throw new Error("The feedback receipt was not retained");
    return retained;
  }
  submitted(request: SelectionFeedback): FeedbackRecord | undefined {
    const row = this.db
      .query("SELECT record FROM document_feedback WHERE id=?")
      .get(request.requestId);
    if (row === null) return undefined;
    const retained = decode(row, feedbackSchema);
    if (
      !isDeepStrictEqual(
        selectionFeedbackSchema.parse(stripFeedback(retained)),
        request,
      )
    )
      throw new FeedbackRequestReused();
    return retained;
  }
  get(id: string): FeedbackRecord {
    return decode(
      this.db.query("SELECT record FROM document_feedback WHERE id=?").get(id),
      feedbackSchema,
    );
  }
  change(id: string, update: (record: FeedbackRecord) => void): FeedbackRecord {
    this.db.run("BEGIN IMMEDIATE");
    try {
      const record = this.get(id);
      update(record);
      const checked = feedbackSchema.parse(record);
      this.db
        .query("UPDATE document_feedback SET record=? WHERE id=?")
        .run(JSON.stringify(checked), id);
      this.db.run("COMMIT");
      return checked;
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
  }
  save(request: SaveDraft, command = JSON.stringify(request)): SaveReceipt {
    // This reservation prevents payload reuse across authority databases. It is
    // never evidence of acceptance; only an authoritative witness proves that.
    const reservation = {
      version: 1,
      authority:
        request.ref.ownerKind === DocumentOwnerKind.Attempt
          ? "attempts.sqlite"
          : "discoveries.sqlite",
      ownerId: request.ref.ownerId,
      command,
    };
    this.db
      .query("INSERT OR IGNORE INTO document_saves VALUES (?,?)")
      .run(request.operationId, JSON.stringify({ request, reservation }));
    const receipt = this.saved(request, command);
    if (receipt === undefined)
      throw new Error("The save reservation was not retained");
    return receipt;
  }
  saved(
    request: SaveDraft,
    command = JSON.stringify(request),
  ): SaveReceipt | undefined {
    const row = this.db
      .query("SELECT record FROM document_saves WHERE id=?")
      .get(request.operationId);
    if (row === null) return undefined;
    const receipt = decode(row, saveReceiptSchema);
    if (!isDeepStrictEqual(receipt.request, request))
      throw new OperationIdReused();
    if (
      receipt.reservation !== undefined &&
      (receipt.reservation.command !== command ||
        receipt.reservation.ownerId !== request.ref.ownerId ||
        receipt.reservation.authority !==
          (request.ref.ownerKind === DocumentOwnerKind.Attempt
            ? "attempts.sqlite"
            : "discoveries.sqlite"))
    )
      throw new OperationIdReused();
    return receipt;
  }
  accept(
    request: SaveDraft,
    accepted: z.infer<typeof documentSnapshotSchema>,
    commitWitnessId: string,
    command = JSON.stringify(request),
  ): void {
    const receipt = this.save(request, command);
    if (
      receipt.accepted !== undefined &&
      !isDeepStrictEqual(receipt.accepted, accepted)
    )
      throw new Error(
        "The save receipt already identifies another accepted revision",
      );
    this.db
      .query("UPDATE document_saves SET record=? WHERE id=?")
      .run(
        JSON.stringify(
          saveReceiptSchema.parse({ ...receipt, accepted, commitWitnessId }),
        ),
        request.operationId,
      );
  }
}

function decode<T>(row: unknown, schema: z.ZodType<T>): T {
  return schema.parse(
    JSON.parse(z.object({ record: z.string() }).parse(row).record),
  );
}
function stripFeedback(record: FeedbackRecord): SelectionFeedback {
  return {
    requestId: record.requestId,
    ref: record.ref,
    baseRevision: record.baseRevision,
    bufferIdentity: record.bufferIdentity,
    range: record.range,
    selectedText: record.selectedText,
    message: record.message,
  };
}
