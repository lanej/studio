import assert from "node:assert/strict";
import { test } from "node:test";
import { workerTerminal } from "../execution/worker-terminal.ts";

await test("creates one detached worker session without inheriting the lead pane address", async () => {
  let starts = 0;
  const baseline = { TERM: "xterm-256color", ZELLIJ: "1", ZELLIJ_SESSION_NAME: "lead", ZELLIJ_PANE_ID: "7" };
  let identity = "original";
  const target = workerTerminal("studio-runtime-fixture", baseline, {
    run(executable, args, options) {
      starts++;
      assert.equal(executable, "/fixture/zellij");
      assert.deepEqual(args, ["attach", "--create-background", "studio-runtime-fixture"]);
      assert.deepEqual(options, { cwd: "/project", env: { TERM: "xterm-256color" } });
      return Promise.resolve("");
    },
    connect(session) {
      assert.equal(session, "studio-runtime-fixture");
      return { identity, detachedTab: () => Promise.resolve(12), launch: () => Promise.resolve(42) };
    },
  });
  assert.equal((await target("/fixture/zellij", "/project")).tab, 12);
  assert.equal((await target("/fixture/zellij", "/project")).tab, 12);
  identity = "replacement";
  await assert.rejects(target("/fixture/zellij", "/project"), /was replaced/u);
  assert.equal(starts, 1);
  assert.equal(baseline.ZELLIJ_SESSION_NAME, "lead");
});

await test("does not repeat or adopt a session after an unconfirmed creation", async () => {
  let starts = 0;
  const target = workerTerminal(
    "studio-runtime-fixture",
    {},
    {
      run() {
        starts++;
        return Promise.reject(new Error("creation acknowledgement lost"));
      },
      connect() {
        assert.fail("Unconfirmed session must not be adopted");
      },
    },
  );
  await assert.rejects(target("/fixture/zellij", "/project"), /acknowledgement lost/u);
  await assert.rejects(target("/fixture/zellij", "/project"), /creation .* is unconfirmed/iu);
  assert.equal(starts, 1);
});
