import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Database } from "bun:sqlite";
import { Attempts, attemptSchema, Phase } from "../attempts.ts";

await test("attempt mutations and immutable operation results survive together, including reopen and intervening edits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-operation-witness-"));
  let store = new Attempts(directory);
  const id = randomUUID();
  try {
    store.reserve(
      attemptSchema.parse({
        id,
        source: { url: "http://127.0.0.1:1", projectId: randomUUID() },
        bead: {
          id: "task",
          title: "Task",
          status: "in_progress",
          revision: "1",
        },
        revision: "1",
        check: [],
        profile: "personal",
        model: { provider: "openai-codex", model: "fixture", reasoning: "off" },
        live: false,
        processStarted: null,
        reservation: {
          primary: directory,
          root: join(directory, "worktrees"),
          holder: id,
          agent: "pi",
          branch: "task",
          baseRef: "main",
          baseCommit: "a".repeat(40),
          attempted: false,
        },
        checkout: null,
        session: "fixture",
        pane: null,
        pid: null,
        transcript: null,
        phase: Phase.Running,
        verification: null,
        message: "Original",
      }),
    );
    const operationId = randomUUID();
    const command = JSON.stringify({
      operationId,
      owner: id,
      expected: "Original",
      candidate: "Accepted",
    });
    const mutate = () =>
      store.changeWithWitness(
        id,
        operationId,
        command,
        (row) => {
          assert.equal(row.message, "Original");
          row.message = "Accepted";
        },
        (row) => JSON.stringify({ owner: row.id, accepted: row.message }),
      );
    const database = new Database(join(directory, "attempts.sqlite"));
    try {
      database.run(
        "CREATE TRIGGER fail_commit BEFORE INSERT ON operation_witnesses BEGIN SELECT RAISE(ABORT, 'witness write failed'); END",
      );
      assert.throws(mutate, /witness write failed/u);
      assert.equal(store.get(id).message, "Original");
      assert.equal(
        database
          .query("SELECT record FROM operation_witnesses WHERE operation_id=?")
          .get(operationId),
        null,
      );
      database.run("DROP TRIGGER fail_commit");
    } finally {
      database.close();
    }
    const accepted = mutate();
    store.close();
    store = new Attempts(directory);
    store.change(id, (row) => {
      row.message = "Later writer";
    });
    assert.deepEqual(
      mutate(),
      accepted,
      "reopening returns the original result without invoking the stale mutation",
    );
    assert.equal(store.get(id).message, "Later writer");
    assert.throws(
      () =>
        store.changeWithWitness(
          id,
          operationId,
          `${command} `,
          () => assert.fail("a reused operation cannot mutate"),
          () => assert.fail("a reused operation cannot manufacture a result"),
        ),
      /operation ID already belongs/u,
    );
    assert.throws(
      () =>
        store.changeWithWitness(
          randomUUID(),
          operationId,
          command,
          () => assert.fail("a reused operation cannot change owner"),
          () => assert.fail("a reused operation cannot manufacture a result"),
        ),
      /operation ID already belongs/u,
    );
    assert.equal(store.get(id).message, "Later writer");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
