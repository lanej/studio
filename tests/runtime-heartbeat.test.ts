import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runtimeProjectSchema, StudioProfile } from "../config.ts";
import { beadSchema } from "../task-service.ts";
import { ExecutionPhase, ExecutionStore, executionSchema } from "../execution/store.ts";
import { maintainAttempt } from "../execution/supervisor.ts";
import { startAssignmentHeartbeat } from "../execution/worker.ts";

const deferred = () => {
  let resolve = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

await test("supervisor lease maintenance preserves completion and new owners across awaited failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-heartbeat-"));
  const store = new ExecutionStore(directory);
  const peer = new ExecutionStore(directory);
  const projectId = randomUUID();
  const project = {
    ...runtimeProjectSchema.parse({
      root: directory,
      source: { url: "http://127.0.0.1:9", projectId },
      profile: StudioProfile.Personal,
      base: "main",
      beadsWorkspace: directory,
      beadsDatabase: "fixture",
    }),
    id: projectId,
  };
  const create = () => {
    const record = executionSchema.parse({
      id: randomUUID(),
      project: projectId,
      profile: StudioProfile.Personal,
      phase: ExecutionPhase.Queued,
      bead: beadSchema.parse({
        id: "fixture",
        title: "Fixture",
        status: "in_progress",
        revision: "1",
      }),
      message: "queued",
    });
    store.saveAttempt(record);
    return record;
  };
  try {
    const live = create();
    peer.change(live.id, (row) => {
      row.phase = ExecutionPhase.Running;
      row.launchToken = randomUUID();
    });
    await maintainAttempt(store, project, live.id, {
      reconcile: async () => {},
      heartbeat: () => Promise.reject(new Error("duplicate control-host heartbeat")),
    });
    assert.equal(store.attempt(live.id).phase, ExecutionPhase.Running);

    for (const outcome of [ExecutionPhase.Complete, ExecutionPhase.Launching, ExecutionPhase.Uncertain]) {
      const record = create();
      const entered = deferred();
      const pending = deferred();
      const maintenance = maintainAttempt(store, project, record.id, {
        reconcile: async () => {},
        heartbeat: async () => {
          entered.resolve();
          await pending.promise;
        },
      });
      await entered.promise;
      if (outcome !== ExecutionPhase.Uncertain)
        peer.change(record.id, (row) => {
          row.phase = outcome;
          row.message = "new lifecycle decision";
          if (outcome === ExecutionPhase.Launching) row.launchToken = randomUUID();
        });
      pending.reject(new Error("heartbeat rejected: task closed or ownership changed"));
      await maintenance;
      const current = store.attempt(record.id);
      assert.equal(current.phase, outcome);
      assert.equal(
        current.message,
        outcome === ExecutionPhase.Uncertain
          ? "This attempt needs reconciliation: heartbeat rejected: task closed or ownership changed"
          : "new lifecycle decision",
      );
    }

    const completing = create();
    await maintainAttempt(store, project, completing.id, {
      reconcile: () => {
        peer.change(completing.id, (row) => {
          row.phase = ExecutionPhase.Complete;
        });
        return Promise.reject(new Error("stale reconciliation failure"));
      },
      heartbeat: () => Promise.reject(new Error("unreachable heartbeat")),
    });
    assert.equal(store.attempt(completing.id).phase, ExecutionPhase.Complete);
  } finally {
    peer.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("worker stops scheduling and drains its heartbeat before guarded completion", async () => {
  for (const fail of [false, true]) {
    const pending = deferred();
    const events: string[] = [];
    let tick = () => {};
    const stop = startAssignmentHeartbeat(
      () => {
        events.push("heartbeat started");
        return pending.promise;
      },
      () => {
        events.push("heartbeat renewed");
      },
      () => {
        events.push("heartbeat failed");
      },
      (callback) => {
        tick = callback;
        return () => {
          events.push("scheduling stopped");
        };
      },
    );
    tick();
    tick();
    const drained = stop().then(() => {
      events.push("drained");
    });
    tick();
    assert.deepEqual(events, ["heartbeat started", "scheduling stopped"]);
    if (fail) pending.reject(new Error("lease lost"));
    else pending.resolve();
    await drained;
    assert.deepEqual(events, [
      "heartbeat started",
      "scheduling stopped",
      fail ? "heartbeat failed" : "heartbeat renewed",
      "drained",
    ]);
    tick();
    assert.equal(events.length, 4);
  }
});
