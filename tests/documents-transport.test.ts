import assert from "node:assert/strict";
import { stat, readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { test } from "node:test";
import { z } from "zod";
import { DocumentMethod, serveDocuments } from "../documents/server.ts";

async function exchange(path: string, request: unknown): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.setTimeout(2_000, () =>
      socket.destroy(new Error("Document response timed out")),
    );
    let text = "";
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (bytes: Buffer) => {
      text += bytes.toString("utf8");
    });
    socket.once("error", reject);
    socket.once("end", () => {
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

await test("document IPC admits only the bound private connection and returns confirmed effects", async () => {
  let writes = 0;
  const server = await serveDocuments((method, params) => {
    assert.equal(method, DocumentMethod.Save);
    writes++;
    return Promise.resolve({ accepted: params, revision: "next" });
  });
  try {
    assert.equal((await stat(server.manifest)).mode & 0o777, 0o600);
    assert.equal((await stat(server.connection.socket)).mode & 0o777, 0o600);
    assert.deepEqual(
      JSON.parse(await readFile(server.manifest, "utf8")),
      server.connection,
    );
    const wire = {
      id: "save-1",
      token: server.connection.token,
      generation: server.connection.generation,
      method: DocumentMethod.Save,
      params: { text: "edit" },
    };
    const accepted = await exchange(server.connection.socket, wire);
    assert.deepEqual(accepted, {
      id: "save-1",
      ok: true,
      result: { accepted: { text: "edit" }, revision: "next" },
    });
    const rejected = await exchange(server.connection.socket, {
      ...wire,
      token: "wrong",
    });
    assert.equal(z.object({ ok: z.boolean() }).parse(rejected).ok, false);
    const stale = await exchange(server.connection.socket, {
      ...wire,
      generation: "00000000-0000-4000-8000-000000000000",
    });
    assert.equal(z.object({ ok: z.boolean() }).parse(stale).ok, false);
    assert.equal(writes, 1, "rejected connections cannot reach a save effect");
  } finally {
    await server.close();
  }
  await assert.rejects(stat(server.connection.socket));
});

await test("document IPC preserves host rejection without claiming a saved revision", async () => {
  const server = await serveDocuments(() =>
    Promise.reject(new Error("Draft changed; reload before saving")),
  );
  try {
    const { socket, ...identity } = server.connection;
    assert.deepEqual(
      await exchange(socket, {
        id: "stale",
        ...identity,
        method: DocumentMethod.Save,
        params: {},
      }),
      {
        id: "stale",
        ok: false,
        error: {
          code: "rejected",
          message: "Draft changed; reload before saving",
        },
      },
    );
  } finally {
    await server.close();
  }
});
