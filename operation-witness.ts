import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { z } from "zod";

const witnessSchema = z.strictObject({
  id: z.uuid(),
  operationId: z.string().min(1),
  ownerId: z.string().min(1),
  command: z.string().min(1),
  result: z.string().min(1),
});
export type OperationWitness = z.infer<typeof witnessSchema>;

export class OperationIdReused extends Error {
  readonly code = "OPERATION_ID_REUSED";
  constructor() {
    super("This save operation ID already belongs to different content");
  }
}

export function initializeOperationWitnesses(db: Database): void {
  db.run(
    "CREATE TABLE IF NOT EXISTS operation_witnesses (operation_id TEXT PRIMARY KEY, record TEXT NOT NULL)",
  );
}

function findWitness(
  db: Database,
  ownerId: string,
  operationId: string,
  command: string,
): OperationWitness | undefined {
  const row = db
    .query("SELECT record FROM operation_witnesses WHERE operation_id=?")
    .get(operationId);
  if (row === null) return undefined;
  const witness = witnessSchema.parse(
    JSON.parse(z.object({ record: z.string() }).parse(row).record),
  );
  if (
    witness.operationId !== operationId ||
    witness.ownerId !== ownerId ||
    witness.command !== command
  )
    throw new OperationIdReused();
  return witness;
}

/** Historical acceptance is read without activating or mutating its old owner. */
export function readOperationWitness(
  file: string,
  ownerId: string,
  operationId: string,
  command: string,
): OperationWitness | undefined {
  if (!existsSync(file)) return undefined;
  const db = new Database(file, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout=5000");
    if (
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='operation_witnesses'",
        )
        .get() === null
    )
      return undefined;
    return findWitness(db, ownerId, operationId, command);
  } finally {
    db.close();
  }
}

export function transaction<T>(db: Database, update: () => T): T {
  db.run("BEGIN IMMEDIATE");
  try {
    const result = update();
    db.run("COMMIT");
    return result;
  } catch (cause) {
    db.run("ROLLBACK");
    throw cause;
  }
}

/** The caller's state change and its immutable result share this database commit. */
export function commitOperation(
  db: Database,
  ownerId: string,
  operationId: string,
  command: string,
  update: () => string,
): OperationWitness {
  return transaction(db, () => {
    const previous = findWitness(db, ownerId, operationId, command);
    if (previous !== undefined) return previous;
    const witness = witnessSchema.parse({
      id: randomUUID(),
      operationId,
      ownerId,
      command,
      result: update(),
    });
    db.query("INSERT INTO operation_witnesses VALUES (?,?)").run(
      operationId,
      JSON.stringify(witness),
    );
    return witness;
  });
}
