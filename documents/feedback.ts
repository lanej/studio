import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { documentRefSchema, documentSnapshotSchema } from "./model.ts";

export enum FeedbackState {
  Queued = "queued",
  Dispatching = "dispatching",
  Awaiting = "awaiting",
  Parked = "parked",
  Answered = "answered",
  Failed = "failed",
  Uncertain = "uncertain",
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
  message: z.string().trim().min(1).max(20_000),
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
    const retained = this.get(request.requestId);
    if (
      !isDeepStrictEqual(
        selectionFeedbackSchema.parse(stripFeedback(retained)),
        request,
      )
    )
      throw new Error(
        "This feedback request ID already belongs to different content",
      );
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
  save(request: SaveDraft): SaveReceipt {
    this.db
      .query("INSERT OR IGNORE INTO document_saves VALUES (?,?)")
      .run(request.operationId, JSON.stringify({ request }));
    const receipt = decode(
      this.db
        .query("SELECT record FROM document_saves WHERE id=?")
        .get(request.operationId),
      saveReceiptSchema,
    );
    if (!isDeepStrictEqual(receipt.request, request))
      throw new Error(
        "This save operation ID already belongs to different content",
      );
    return receipt;
  }
  accept(
    request: SaveDraft,
    accepted: z.infer<typeof documentSnapshotSchema>,
  ): void {
    const receipt = this.save(request);
    if (
      receipt.accepted !== undefined &&
      !isDeepStrictEqual(receipt.accepted, accepted)
    )
      throw new Error(
        "The save receipt already identifies another accepted revision",
      );
    this.db
      .query("UPDATE document_saves SET record=? WHERE id=?")
      .run(JSON.stringify({ request, accepted }), request.operationId);
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
