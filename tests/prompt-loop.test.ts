import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopStore, loopSchema } from "../sessions/store.ts";
import { PromptLoop, type LoopAdmission } from "../sessions/controller.ts";

await test("loop intent survives lost dispatch acknowledgement; stop settles current only and cadence never catches up", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-loops-"));
  const store = new LoopStore(directory);
  const owner = { token: "owner", pid: process.pid, started: "fixture" };
  const admission: LoopAdmission = {
    session: "one",
    eligible: true,
    settled: true,
    pendingInput: false,
    editorText: "",
    dialogs: 0,
  };
  let timer: (() => void) | undefined;
  let dispatches = 0;
  let fail = false;
  const initial = store.save(
    loopSchema.parse({
      session: "one",
      revision: 0,
      prompt: "Check progress",
      cadenceMs: 100,
      state: "paused",
      count: 0,
      intent: null,
      reason: "Configured",
      owner,
    }),
    undefined,
  );
  const controller = new PromptLoop(store, initial, owner, {
    snapshot: () => admission,
    changed: () => undefined,
    dispatch: () => {
      dispatches++;
      assert.notEqual(store.get("one")?.intent, null);
      if (fail) throw new Error("Lost acknowledgement");
      controller.input(true, "Check progress");
      controller.started(true);
    },
    schedule: (callback, milliseconds) => {
      assert.equal(milliseconds, 100);
      timer = callback;
      return () => {
        timer = undefined;
      };
    },
  });
  const tick = () => {
    const callback = timer;
    timer = undefined;
    callback?.();
  };
  try {
    controller.start();
    for (const guard of [
      "settled",
      "pendingInput",
      "editorText",
      "dialogs",
    ] as const) {
      const previous = admission[guard];
      if (guard === "settled") admission.settled = false;
      if (guard === "pendingInput") admission.pendingInput = true;
      if (guard === "editorText") admission.editorText = "Unsent draft";
      if (guard === "dialogs") admission.dialogs = 1;
      tick();
      assert.equal(dispatches, 0);
      Object.assign(admission, { [guard]: previous });
    }
    tick();
    assert.equal(dispatches, 1);
    assert.equal(timer, undefined);
    controller.stop();
    assert.notEqual(store.get("one")?.intent, null);
    controller.settled(false);
    assert.equal(controller.current.count, 1);
    assert.equal(controller.current.lastSettled?.ordinal, 1);
    assert.equal(controller.current.state, "stopped");
    tick();
    assert.equal(dispatches, 1);
    controller.start();
    fail = true;
    tick();
    assert.equal(dispatches, 2);
    assert.equal(controller.current.state, "paused");
    assert.deepEqual(
      store.iterations("one").map((row) => row.state),
      ["settled", "uncertain"],
    );
    assert.equal(controller.current.attempts, 2);
    const intent = controller.current.intent;
    assert.ok(intent !== null);
    assert.throws(() => {
      controller.start();
    }, /Inspect/u);
    store.close();
    const restored = new LoopStore(directory);
    try {
      assert.deepEqual(restored.get("one")?.intent, intent);
      assert.equal(restored.get("one")?.state, "paused");
    } finally {
      restored.close();
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("atomic ownership revisions reject another writer and stale controller without provider effects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-loop-cas-"));
  const first = new LoopStore(directory);
  const second = new LoopStore(directory);
  try {
    const record = first.save(
      loopSchema.parse({
        session: "one",
        revision: 0,
        prompt: "Check",
        cadenceMs: 100,
        state: "paused",
        count: 0,
        intent: null,
        reason: "configured",
        owner: { token: "first", pid: process.pid, started: "fixture" },
      }),
      undefined,
    );
    assert.throws(() => second.save(record, undefined), /ownership changed/u);
    const controller = new PromptLoop(
      first,
      record,
      record.owner ?? assert.fail(),
      {
        snapshot: () => assert.fail(),
        dispatch: () => assert.fail(),
        changed: () => undefined,
        schedule: () => assert.fail(),
      },
    );
    second.save(
      {
        ...record,
        owner: { token: "second", pid: process.pid, started: "fixture" },
      },
      record.revision,
    );
    assert.throws(() => {
      controller.start();
    }, /Another process/u);
    assert.equal(first.get("one")?.count, 0);
  } finally {
    first.close();
    second.close();
    await rm(directory, { recursive: true, force: true });
  }
});
