import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { stateDirectory } from "../attempts.ts";

export const loopSchema = z.object({
  session: z.string().min(1),
  revision: z.number().int().nonnegative(),
  prompt: z.string().trim().min(1),
  cadenceMs: z.number().int().positive(),
  state: z.enum(["paused", "running", "stopped"]),
  needsInspection: z.boolean().default(false),
  attempts: z.number().int().nonnegative().default(0),
  count: z.number().int().nonnegative(),
  intent: z
    .object({
      id: z.string(),
      ordinal: z.number().int().positive(),
      at: z.number(),
    })
    .nullable(),
  lastSettled: z
    .object({
      id: z.string(),
      ordinal: z.number().int().positive(),
      at: z.number(),
    })
    .nullable()
    .default(null),
  reason: z.string(),
  owner: z
    .object({
      token: z.string(),
      pid: z.number().int().positive(),
      started: z.string(),
    })
    .nullable(),
});
export type LoopRecord = z.infer<typeof loopSchema>;
export type LoopOwner = NonNullable<LoopRecord["owner"]>;
const iterationSchema = z.object({
  session: z.string(),
  id: z.string(),
  ordinal: z.number(),
  at: z.number(),
  prompt: z.string(),
  state: z.enum(["pending", "uncertain", "settled"]),
  settledAt: z.number().optional(),
  acknowledgedAt: z.number().optional(),
});
const rowSchema = z.object({ record: z.string() });

/** Local intent and ownership are atomic; provider effects remain uncertain across crashes. */
export class LoopStore {
  private readonly db: Database;
  constructor(directory = stateDirectory()) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new Database(join(directory, "prompt-loops.sqlite"), {
      create: true,
    });
    this.db.run("PRAGMA busy_timeout=5000");
    this.db.run(
      "CREATE TABLE IF NOT EXISTS loops (session TEXT PRIMARY KEY, revision INTEGER NOT NULL, record TEXT NOT NULL)",
    );
    this.db.run(
      "CREATE TABLE IF NOT EXISTS iterations (session TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(session,id))",
    );
  }
  close(): void {
    this.db.close();
  }
  get(session: string): LoopRecord | undefined {
    const row: unknown = this.db.query("SELECT record FROM loops WHERE session=?").get(session);
    return row === null ? undefined : loopSchema.parse(JSON.parse(rowSchema.parse(row).record));
  }
  iterations(session: string): z.infer<typeof iterationSchema>[] {
    return this.db
      .query("SELECT record FROM iterations WHERE session=? ORDER BY rowid")
      .all(session)
      .map((row) => iterationSchema.parse(JSON.parse(rowSchema.parse(row).record)));
  }
  save(record: LoopRecord, expected: number | undefined): LoopRecord {
    const next = loopSchema.parse({
      ...record,
      revision: (expected ?? -1) + 1,
    });
    this.db.run("BEGIN IMMEDIATE");
    try {
      const current = this.get(record.session);
      if (current?.revision !== expected)
        throw new Error("Loop ownership changed; inspect /loop status before continuing");
      this.db
        .query(
          "INSERT INTO loops VALUES (?,?,?) ON CONFLICT(session) DO UPDATE SET revision=excluded.revision, record=excluded.record",
        )
        .run(next.session, next.revision, JSON.stringify(next));
      const intent = next.intent ?? current?.intent;
      if (intent !== null && intent) {
        const settled = next.lastSettled?.id === intent.id;
        const iteration = iterationSchema.parse({
          ...intent,
          session: next.session,
          prompt: current?.prompt ?? next.prompt,
          state: settled ? "settled" : next.intent === null || next.needsInspection ? "uncertain" : "pending",
          ...(settled ? { settledAt: next.lastSettled?.at } : {}),
          ...(next.intent === null && !settled ? { acknowledgedAt: Date.now() } : {}),
        });
        this.db
          .query("INSERT INTO iterations VALUES (?,?,?) ON CONFLICT(session,id) DO UPDATE SET record=excluded.record")
          .run(next.session, intent.id, JSON.stringify(iteration));
      }
      this.db.run("COMMIT");
      return next;
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
  }
}
