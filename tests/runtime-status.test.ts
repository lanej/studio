import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ExecutionPhase } from "../execution/phase.ts";
import { ExecutionStore, executionSchema } from "../execution/store.ts";

test("runtime status defaults to a bounded snapshot and preserves full JSON on request", () => {
  const scratch = mkdtempSync(join(tmpdir(), "studio-runtime-status-"));
  const state = join(scratch, "state");
  const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
  const status = (...args: string[]) =>
    Bun.spawnSync([process.execPath, cli, "runtime", "status", ...args], {
      env: { ...process.env, STUDIO_STATE_DIR: state, STUDIO_CONFIG: join(scratch, "unused.json") },
      stderr: "pipe",
      timeout: 5_000,
    });

  try {
    const empty = status();
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout.toString()).toContain("No supervisor recorded");
    expect(existsSync(state)).toBe(false);

    const project = crypto.randomUUID();
    const store = new ExecutionStore(state);
    const parked = crypto.randomUUID();
    try {
      for (const phase of [
        ExecutionPhase.Parked,
        ExecutionPhase.Complete,
        ...Array<ExecutionPhase>(9).fill(ExecutionPhase.Running),
      ]) {
        store.saveAttempt(
          executionSchema.parse({
            id: phase === ExecutionPhase.Parked ? parked : crypto.randomUUID(),
            project,
            profile: "work",
            phase,
            sessions: ["/fixture/worker.jsonl"],
            message: "retained blocker ".repeat(100),
          }),
        );
      }
    } finally {
      store.close();
    }

    const plain = status();
    expect(plain.exitCode).toBe(0);
    const summary = plain.stdout.toString();
    expect(status("--summary").stdout.toString()).toBe(summary);
    expect(summary.split("\n")[2]).toStartWith(`needs-review unclaimed ${parked}`);
    expect(summary).toContain("1 need attention · 9 other unfinished · 1 complete");
    expect(summary).toContain("+2 unfinished (see --json)");
    expect(summary).not.toContain("worker.jsonl");
    expect(summary.length).toBeLessThan(1_700);

    const full = status("--json");
    expect(full.exitCode).toBe(0);
    const parsed = z
      .object({
        supervisor: z.null(),
        allocationOwner: z.null(),
        live: z.literal(false),
        attempts: z.array(executionSchema),
        projects: z.tuple([]),
      })
      .parse(JSON.parse(full.stdout.toString()));
    expect(parsed.attempts).toHaveLength(11);
    expect(parsed.attempts[0]?.sessions).toEqual(["/fixture/worker.jsonl"]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
