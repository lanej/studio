import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { stateDirectory } from "../attempts.ts";
import { executionSchema, type Execution } from "../execution/store.ts";

/** Reading the inspector must neither create a runtime store nor enroll a project. */
export function readTaskEvidence(
  project: string | undefined,
  directory = stateDirectory(),
): { attempts: Execution[]; evidenceError?: string } {
  if (project === undefined) return { attempts: [] };
  const path = join(directory, "runtime.sqlite");
  let db: Database | undefined;
  try {
    statSync(path);
    db = new Database(path, { readonly: true });
    db.run("PRAGMA busy_timeout=1000");
    const rows = db
      .query(
        "SELECT record FROM records WHERE kind='attempt' AND json_extract(record,'$.project')=? ORDER BY rowid",
      )
      .all(project);
    return {
      attempts: rows.map((row) =>
        executionSchema.parse(
          JSON.parse(z.object({ record: z.string() }).parse(row).record),
        ),
      ),
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { attempts: [] };
    return {
      attempts: [],
      evidenceError: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db?.close();
  }
}
