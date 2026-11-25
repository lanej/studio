import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export enum DocumentMethod {
  Sync = "sync",
  Save = "save",
  Feedback = "feedback",
  Register = "register",
}

export const documentConnection = z.strictObject({
  socket: z.string().min(1),
  token: z.string().min(1),
  generation: z.uuid(),
});
export type DocumentConnection = z.infer<typeof documentConnection>;

const requestSchema = z.strictObject({
  id: z.string().min(1).max(200),
  token: z.string().min(1).max(200),
  generation: z.uuid(),
  method: z.enum(DocumentMethod),
  params: z.unknown().optional(),
});
const frameLimit = 4 * 1024 * 1024;

function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function serveDocuments(
  handle: (method: DocumentMethod, params: unknown) => Promise<unknown>,
) {
  // Short private paths also fit macOS's Unix socket path limit.
  const directory = await mkdtemp(join(tmpdir(), "studio-doc-"));
  await chmod(directory, 0o700);
  const connection: DocumentConnection = {
    socket: join(directory, "ipc"),
    token: randomBytes(32).toString("hex"),
    generation: randomUUID(),
  };
  const manifest = join(directory, "connection.json");
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    socket.on("error", () => {
      // A disconnected client retains its operation ID for reconciliation.
    });
    socket.setTimeout(10_000, () => socket.destroy());
    let bytes = Buffer.alloc(0);
    let processing = false;
    const respond = (value: unknown) => {
      if (!socket.destroyed) socket.end(`${JSON.stringify(value)}\n`);
    };
    socket.on("data", (chunk: Buffer) => {
      if (processing) return;
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > frameLimit) {
        socket.destroy();
        return;
      }
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      processing = true;
      let request: z.infer<typeof requestSchema>;
      try {
        request = requestSchema.parse(
          JSON.parse(bytes.subarray(0, newline).toString("utf8")),
        );
        if (
          request.generation !== connection.generation ||
          !sameToken(request.token, connection.token)
        ) {
          respond({
            id: request.id,
            ok: false,
            error: {
              code: "disconnected",
              message: "The Studio connection changed",
            },
          });
          return;
        }
      } catch {
        respond({
          id: null,
          ok: false,
          error: { code: "invalid", message: "Invalid document request" },
        });
        return;
      }
      handle(request.method, request.params).then(
        (result) => {
          respond({ id: request.id, ok: true, result });
        },
        (cause: unknown) => {
          respond({
            id: request.id,
            ok: false,
            error: {
              code: "rejected",
              message:
                cause instanceof Error
                  ? cause.message
                  : "Document request failed",
            },
          });
        },
      );
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(connection.socket, resolve);
    });
    await chmod(connection.socket, 0o600);
    await writeFile(manifest, JSON.stringify(connection), { mode: 0o600 });
  } catch (error) {
    server.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    connection,
    manifest,
    async close() {
      for (const socket of clients) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      await rm(directory, { recursive: true, force: true });
    },
  };
}
