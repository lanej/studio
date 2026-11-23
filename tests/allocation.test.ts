import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { z } from "zod";
import { processStart } from "../process.ts";
import { groupExists } from "../execution/recovery.ts";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withAllocation } from "../execution/allocation.ts";
import { ExecutionStore } from "../execution/store.ts";

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
    assert.deepEqual(order, [
      "first entered",
      "first finished",
      "second entered",
    ]);
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
  try {
    const line: unknown[] = await once(reader, "line");
    const receipt = z
      .object({ child: z.number().int().positive() })
      .parse(JSON.parse(z.string().parse(line[0])));
    assert(receipt.child > 0 && controller.pid !== undefined);
    const pid = controller.pid;
    const started = await processStart(pid);
    const owner = { id: randomUUID(), attempt: randomUUID(), pid, started };
    assert.equal(store.reserveAllocation(owner, undefined), true);
    const stopped = once(controller, "close");
    process.kill(pid, "SIGKILL");
    await stopped;
    assert.equal(
      groupExists(pid),
      true,
      "The owned manager child still holds the prior controller group",
    );
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
    assert.equal(
      entered,
      true,
      "Allocation recovers once the old controller and its children are gone",
    );
    assert.equal(store.allocationOwner(), undefined);
  } finally {
    abort.abort();
    if (controller.pid !== undefined && groupExists(controller.pid))
      process.kill(-controller.pid, "SIGKILL");
    await pending?.catch(() => {});
    reader.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
