import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { z } from "zod";
import { processStart, run, signalProcessGroup } from "../process.ts";
import { setTimeout as delay } from "node:timers/promises";
import { finishAllocationFixture, settleOwnedAllocationGroup } from "./helpers/allocation-cleanup.ts";
import { groupExists } from "../execution/recovery.ts";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withAllocation } from "../execution/allocation.ts";
import { ExecutionStore } from "../execution/store.ts";
import { WorktreeManager } from "../vendor/task-runtime/worktrees.ts";

await test("independent task hosts serialize manager mutations and release on failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-allocation-"));
  const first = new ExecutionStore(directory);
  const second = new ExecutionStore(directory);
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: (() => void) | undefined;
  const acquired = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let waiting: (() => void) | undefined;
  const queued = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const order: string[] = [];
  const attempt = randomUUID();
  try {
    const one = withAllocation(
      first,
      attempt,
      () => Promise.resolve(),
      async () => {
        order.push("first entered");
        entered?.();
        await held;
        order.push("first finished");
      },
    );
    await acquired;
    let polls = 0;
    const two = withAllocation(
      second,
      randomUUID(),
      () => {
        if (++polls >= 2) waiting?.();
        return Promise.resolve();
      },
      () => {
        order.push("second entered");
        return Promise.resolve();
      },
    );
    await queued;
    assert.deepEqual(order, ["first entered"]);
    assert.equal(second.allocationOwner()?.attempt, attempt);
    release?.();
    await Promise.all([one, two]);
    assert.deepEqual(order, ["first entered", "first finished", "second entered"]);
    assert.equal(first.allocationOwner(), undefined);
    await assert.rejects(
      withAllocation(
        second,
        randomUUID(),
        () => Promise.resolve(),
        () => Promise.reject(new Error("Retained allocation uncertainty")),
      ),
      /allocation uncertainty/u,
    );
    assert.equal(first.allocationOwner(), undefined);
  } finally {
    release?.();
    second.close();
    first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("a dead allocation controller retains its lease while its manager process group survives", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-allocation-group-"));
  const store = new ExecutionStore(directory);
  const controller = spawn(
    process.execPath,
    [
      "--no-env-file",
      "-e",
      'const {spawn}=require("node:child_process");const child=spawn(process.execPath,["--no-env-file","-e","setTimeout(()=>{},15000)"],{stdio:"ignore"});child.unref();console.log(JSON.stringify({child:child.pid}));setTimeout(()=>{},15000);',
    ],
    { cwd: directory, detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  const reader = createInterface({ input: controller.stdout });
  let pending: Promise<void> | undefined;
  const abort = new AbortController();
  const identities: { pid: number; started: string }[] = [];
  let primary: { error: unknown } | undefined;
  try {
    const line: unknown[] = await once(reader, "line");
    const receipt = z.object({ child: z.number().int().positive() }).parse(JSON.parse(z.string().parse(line[0])));
    assert(receipt.child > 0 && controller.pid !== undefined);
    const pid = controller.pid;
    const started = await processStart(pid);
    identities.push({ pid, started }, { pid: receipt.child, started: await processStart(receipt.child) });
    const owner = { id: randomUUID(), attempt: randomUUID(), pid, started };
    assert.equal(store.reserveAllocation(owner, undefined), true);
    const stopped = once(controller, "close");
    process.kill(pid, "SIGKILL");
    await stopped;
    assert.equal(groupExists(pid), true, "The owned manager child still holds the prior controller group");
    let entered = false;
    let checked: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      checked = resolve;
    });
    let observations = 0;
    pending = withAllocation(
      store,
      randomUUID(),
      () => {
        abort.signal.throwIfAborted();
        if (++observations >= 2) checked?.();
        return Promise.resolve();
      },
      () => {
        entered = true;
        return Promise.resolve();
      },
    );
    await waiting;
    assert.equal(entered, false);
    assert.equal(store.allocationOwner()?.id, owner.id);
    process.kill(-pid, "SIGKILL");
    const deadline = setTimeout(() => {
      abort.abort(new Error("Owned process group did not settle"));
    }, 5000);
    try {
      await pending;
    } finally {
      clearTimeout(deadline);
    }
    assert.equal(entered, true, "Allocation recovers once the old controller and its children are gone");
    assert.equal(store.allocationOwner(), undefined);
  } catch (error) {
    primary = { error };
  } finally {
    await finishAllocationFixture(primary, {
      abort: () => {
        abort.abort();
      },
      stop: async () => {
        const group = controller.pid;
        if (group === undefined) return;
        await settleOwnedAllocationGroup({
          probe: () => groupExists(group),
          verify: async () => {
            for (const identity of identities) {
              try {
                if (
                  (await processStart(identity.pid)) === identity.started &&
                  (await run("/bin/ps", ["-p", String(identity.pid), "-o", "pgid="])).trim() === String(group)
                )
                  return true;
              } catch {
                // Another recorded member may still prove ownership; otherwise retain the fixture.
              }
            }
            return false;
          },
          signal: () => {
            signalProcessGroup(group, "SIGKILL");
          },
          wait: async () => {
            const deadline = Date.now() + 2000;
            while (groupExists(group)) {
              if (Date.now() >= deadline) throw new Error("Owned allocation group did not settle");
              await delay(10);
            }
          },
        });
      },
      drain: async () => {
        await pending?.catch(() => {});
      },
      closeReader: () => {
        reader.close();
      },
      closeStore: () => {
        store.close();
      },
      dispose: async (safe) => {
        if (!safe) throw new Error(`Retained allocation fixture at ${directory}: process settlement is unconfirmed`);
        await rm(directory, { recursive: true, force: true });
      },
    });
  }
});

await test("manager allocation remains verifiable with a large incomplete global inventory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-manager-inventory-"));
  const executable = join(directory, "manager");
  const id = "1234567890abcdef1234567890abcdef";
  const allocation = {
    primary: directory,
    root: join(directory, ".worktrees"),
    path: join(directory, ".worktrees/pi-12345678"),
    task_id: id,
    owner_id: "canary-owner",
    agent: "pi",
    branch: "pi/canary",
    created_at: "2026-11-24T00:00:00Z",
    base_ref: "main",
  };
  const task = {
    id,
    path: allocation.path,
    branch: allocation.branch,
    owner_id: allocation.owner_id,
    agent: allocation.agent,
    created_at: allocation.created_at,
    state: "active",
  };
  const save = async (owner: string) => {
    await writeFile(
      executable,
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({schema_version:1,command:"status",result:{complete:false,repositories:[{diagnostics:"x".repeat(3*1024*1024)}],tasks:[${JSON.stringify({ ...task, owner_id: owner })}]}}));process.exitCode=1;\n`,
      { mode: 0o755 },
    );
  };
  try {
    await save(allocation.owner_id);
    await new WorktreeManager(executable).requireAllocation(allocation);
    await save("different-owner");
    await assert.rejects(
      new WorktreeManager(executable).requireAllocation(allocation),
      /cannot verify this active allocation/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
