import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { attemptSchema, type Attempt, stateDirectory } from "../attempts.ts";
import { executionSchema, type Execution } from "../execution/store.ts";

/** Reading the inspector must neither create a runtime store nor enroll a project. */
export function readTaskEvidence(
  project: string | undefined,
  directory = stateDirectory(),
  attemptIds?: readonly string[],
): {
  attempts: Execution[];
  evidenceError?: string;
  interactiveAttempts?: Attempt[];
  interactiveEvidenceError?: string;
} {
  // The sidebar polls only the current owners. The task inspector also reads history.
  const owners = attemptIds === undefined ? [] : [JSON.stringify(attemptIds)];
  const filter = owners.length
    ? " AND id IN (SELECT value FROM json_each(?))"
    : "";
  const interactive = readInteractiveEvidence(
    project,
    directory,
    filter,
    owners,
  );
  if (project === undefined) return { attempts: [], ...interactive };
  const path = join(directory, "runtime.sqlite");
  let db: Database | undefined;
  try {
    statSync(path);
    db = new Database(path, { readonly: true });
    db.run("PRAGMA busy_timeout=1000");
    const rows = db
      .query(
        `SELECT record FROM records WHERE kind='attempt' AND json_extract(record,'$.project')=?${filter} ORDER BY rowid`,
      )
      .all(project, ...owners);
    return {
      ...interactive,
      attempts: rows.map((row) =>
        executionSchema.parse(
          JSON.parse(z.object({ record: z.string() }).parse(row).record),
        ),
      ),
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { attempts: [], ...interactive };
    return {
      attempts: [],
      ...interactive,
      evidenceError: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db?.close();
  }
}

/** Interactive attempts remain a separate authority; a missing store is not created. */
function readInteractiveEvidence(
  project: string | undefined,
  directory: string,
  filter: string,
  owners: string[],
): { interactiveAttempts?: Attempt[]; interactiveEvidenceError?: string } {
  if (project === undefined) return {};
  let db: Database | undefined;
  try {
    const path = join(directory, "attempts.sqlite");
    statSync(path);
    db = new Database(path, { readonly: true });
    db.run("PRAGMA busy_timeout=1000");
    const attempts = db
      .query(
        `SELECT bead,record FROM attempts WHERE project=?${filter} ORDER BY rowid`,
      )
      .all(project, ...owners)
      .map((row) => {
        const stored = z
          .object({ bead: z.string(), record: z.string() })
          .parse(row);
        const attempt = attemptSchema.parse(JSON.parse(stored.record));
        if (attempt.bead.id !== stored.bead)
          throw new Error(
            "Interactive receipt task differs from its stored task",
          );
        return attempt;
      });
    if (attempts.some((attempt) => attempt.source.projectId !== project))
      throw new Error(
        "Interactive receipt project differs from its stored project",
      );
    return { interactiveAttempts: attempts };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return {};
    return {
      interactiveEvidenceError:
        error instanceof Error ? error.message : String(error),
    };
  } finally {
    db?.close();
  }
}
