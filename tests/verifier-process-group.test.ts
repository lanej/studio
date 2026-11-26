import assert from "node:assert/strict";
import { test } from "node:test";
import { processGroupHasLiveMembers } from "../process.ts";
import { runCheck } from "../task-verification.ts";

await test("verifier cleanup distinguishes exhausted groups from live descendants", () => {
  const members = "  42 Z\n  42 Z+\n  51 Ss+\n";
  assert.equal(processGroupHasLiveMembers(42, members), false);
  assert.equal(processGroupHasLiveMembers(43, members), false);
  assert.equal(processGroupHasLiveMembers(42, `${members}  42 S\n`), true);
  assert.throws(() => processGroupHasLiveMembers(42, ""), /group state/u);
});

await test("exit and close signal a finished verifier group only once", async (context) => {
  let group: number | undefined;
  let kills = 0;
  const original = process.kill.bind(process);
  context.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
    if (group === undefined || pid !== -group || signal !== "SIGKILL") return original(pid, signal);
    if (++kills > 1)
      throw Object.assign(new Error("kill() failed: EPERM"), {
        code: "EPERM",
      });
    return true;
  });
  const result = await runCheck([process.execPath, "-e", "process.exit(0)"], process.cwd(), undefined, (pid) => {
    group = pid;
    return Promise.resolve();
  });
  assert.equal(result.exitCode, 0);
  assert.equal(kills, 1);
});
