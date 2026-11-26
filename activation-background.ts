import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { stateDirectory } from "./attempts.ts";

const rowSchema = z.object({
  kind: z.string(),
  id: z.string(),
  record: z.string(),
});
const authoritySchema = z.looseObject({
  id: z.string().min(1),
  pid: z.number().int().positive().optional(),
  started: z.string().optional(),
  phase: z.string().optional(),
  launchToken: z.string().optional(),
  launchSettled: z.boolean().optional(),
  controllerSession: z.string().optional(),
  controllerSessionFile: z.string().optional(),
});
export interface BackgroundAuthority {
  target: string;
  process: {
    pid: number;
    start_identity: string;
    native_id: string;
    owner_verified: true;
  } | null;
  sessions: {
    session_id: string;
    restoration: "blocked";
    transcript_path?: string;
  }[];
  reason: string;
}

function ownerUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Native background runtime inspection requires a Unix owner");
  return uid;
}

function processBinding(record: z.infer<typeof authoritySchema>): BackgroundAuthority["process"] | undefined {
  if (record.pid === undefined || record.started === undefined) return undefined;
  const result = spawnSync("ps", ["-p", String(record.pid), "-o", "uid=,lstart="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  if (result.status !== 0 || result.stdout.trim().length === 0) {
    try {
      process.kill(record.pid, 0);
    } catch (error) {
      if (z.object({ code: z.literal("ESRCH") }).safeParse(error).success) return null;
    }
    return undefined;
  }
  const match = result.stdout.trim().match(/^(\d+)\s+(.+)$/u);
  if (match?.[2] === undefined || Number(match[1]) !== ownerUid()) return undefined;
  if (match[2] !== record.started) {
    return /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/u.test(record.started) ? null : undefined;
  } // Both values use this owner's UTC OS start scheme.
  return {
    pid: record.pid,
    start_identity: record.started,
    native_id: `legacy-runtime:${record.id}:${record.started}`,
    owner_verified: true,
  };
}
/** Read the owning runtime ledger without creating, draining, cancelling or recovering it. */
export function backgroundAuthorities(): BackgroundAuthority[] {
  const directory = stateDirectory();
  const path = join(directory, "runtime.sqlite");
  if (!existsSync(path)) return [];
  const parent = lstatSync(directory);
  const info = lstatSync(path);
  if (
    !parent.isDirectory() ||
    parent.uid !== ownerUid() ||
    (parent.mode & 0o077) !== 0 ||
    !info.isFile() ||
    info.uid !== ownerUid()
  )
    throw new Error("Native runtime ledger is not private and owned");
  const database = new Database(path, { readonly: true });
  try {
    database.run("PRAGMA busy_timeout=1000");
    const rows = database
      .query("SELECT kind,id,record FROM records WHERE kind IN ('supervisor','allocation','attempt')")
      .all();
    const authorities: BackgroundAuthority[] = [];
    for (const value of rows) {
      const row = rowSchema.parse(value);
      const record = authoritySchema.parse(JSON.parse(row.record));
      if (row.kind === "attempt" && record.phase === "complete" && record.launchSettled === true) continue;
      const process = processBinding(record);
      if (process === null && row.kind !== "attempt") continue;
      authorities.push({
        target: `runtime:${row.kind}:${record.id}`,
        process: process ?? null,
        sessions:
          record.controllerSession === undefined
            ? []
            : [
                {
                  session_id: record.controllerSession,
                  restoration: "blocked",
                  ...(record.controllerSessionFile === undefined
                    ? {}
                    : { transcript_path: record.controllerSessionFile }),
                },
              ],
        reason:
          process === undefined
            ? "native-background-runtime-owner-or-launch-outcome-unknown"
            : "native-background-runtime-has-no-admission-and-writer-checkpoint",
      });
    }
    return authorities;
  } finally {
    database.close();
  }
}
