import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { withBeadsServer } from "../acceptance/beads-http-fixture.ts";

const receiptSchema = z.object({
  pid: z.number(),
  event: z.string(),
  args: z.array(z.string()).optional(),
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "studio-http-startup-"));
  const executable = join(directory, "bd-fixture");
  await writeFile(
    executable,
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const record = event => appendFileSync(process.env.FIXTURE_RECORD, JSON.stringify({pid:process.pid,event,args:process.argv.slice(2)})+"\\n");
record("started");
let server;
process.on("SIGTERM",()=>{record("stopped");server?.stop(true);process.exit(0);});
const mode=process.env.FIXTURE_MODE;
if(mode==="exit") {process.stderr.write("fixture startup failed");process.exit(7);}
if(mode==="oversize") process.stdout.write("x".repeat(8001));
else if(mode==="hang") process.stderr.write("fixture waiting without an announcement");
else if(mode!=="chunked"&&mode!=="exit-after-bind") process.stdout.write("bd serve: listening on "+mode+"\\n");
else {
  server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response("owned listener")});
  process.stdout.write("startup information\\nbd serve: list");
  setTimeout(()=>{process.stdout.write("ening on http://127.0.0.1:"+server.port+"\\r\\n");if(mode==="exit-after-bind")setTimeout(()=>process.exit(9),20);},5);
}
setInterval(()=>{},1000);
`,
    { mode: 0o700 },
  );
  let sequence = 0;
  const run = async <T>(
    mode: string,
    use: Parameters<typeof withBeadsServer<T>>[2],
    timeout = 2000,
  ) => {
    const record = join(directory, `process-${String(++sequence)}.jsonl`);
    try {
      return await withBeadsServer(
        executable,
        {
          cwd: directory,
          env: { ...process.env, FIXTURE_MODE: mode, FIXTURE_RECORD: record },
        },
        use,
        timeout,
      );
    } finally {
      const receipts = (await readFile(record, "utf8"))
        .trim()
        .split("\n")
        .map((line) => receiptSchema.parse(JSON.parse(line)));
      const started = receipts[0];
      assert.ok(started !== undefined);
      assert.deepEqual(started.args, ["serve", "--addr", "127.0.0.1:0"]);
      assert.throws(() => process.kill(started.pid, 0), { code: "ESRCH" });
      if (mode !== "exit" && mode !== "exit-after-bind")
        assert.equal(receipts.at(-1)?.event, "stopped");
    }
  };
  return {
    directory,
    run,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

await test("owned HTTP service announces its atomic port-zero bind across stdout chunks without taking an occupied listener", async () => {
  const owned = await fixture();
  const occupied = createServer((_request, response) => {
    response.end("occupied listener");
  });
  occupied.listen(0, "127.0.0.1");
  await once(occupied, "listening");
  const address = occupied.address();
  assert.ok(address !== null && typeof address !== "string");
  const occupiedUrl = `http://127.0.0.1:${String(address.port)}`;
  try {
    await owned.run("chunked", async ({ url, assertRunning }) => {
      assert.notEqual(url, occupiedUrl);
      assertRunning();
      assert.equal(await (await fetch(url)).text(), "owned listener");
      assert.equal(
        await (await fetch(occupiedUrl)).text(),
        "occupied listener",
      );
    });
    assert.equal(await (await fetch(occupiedUrl)).text(), "occupied listener");
    await assert.rejects(
      owned.run("chunked", () => {
        throw new Error("caller failed");
      }),
      /caller failed/u,
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      occupied.close((error) => {
        if (error !== undefined) reject(error);
        else resolve();
      });
    });
    await owned.close();
  }
});

await test("invalid address, oversized output, early exit, spawn error and startup timeout close only the owned HTTP child", async () => {
  const owned = await fixture();
  const never = (): Promise<never> => {
    assert.fail("Invalid service reached fixture callback");
  };
  try {
    for (const url of [
      "http://127.0.0.1:0",
      "http://127.0.0.1:65536",
      "http://127.0.0.1:080",
      "http://localhost:1234",
      "http://192.0.2.1:1234",
      "http://127.0.0.1:1234/path",
      "http://user@127.0.0.1:1234",
    ])
      await assert.rejects(
        owned.run(url, never),
        /Invalid.*address announcement/u,
      );
    await assert.rejects(owned.run("oversize", never), /exceeded 8000 bytes/u);
    await assert.rejects(
      owned.run("exit", never),
      /code 7.*fixture startup failed/u,
    );
    await assert.rejects(
      owned.run("hang", never),
      /did not announce.*fixture waiting/u,
    );
    await assert.rejects(
      owned.run("exit-after-bind", async ({ assertRunning }) => {
        await delay(50);
        assertRunning();
      }),
    );
    await assert.rejects(
      withBeadsServer(
        join(owned.directory, "does-not-exist"),
        { cwd: owned.directory, env: process.env },
        never,
      ),
      /ENOENT/u,
    );
  } finally {
    await owned.close();
  }
});
