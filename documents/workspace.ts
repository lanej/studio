import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { stateDirectory } from "../attempts.ts";
import { loadConfig } from "../config.ts";
import { PiMode, piModeSchema } from "../runtime.ts";
import { DocumentEditor } from "./editor.ts";
import { getDocumentHost } from "./host.ts";
import type { DocumentSnapshot } from "./model.ts";
import { DocumentMethod, serveDocuments } from "./server.ts";

export function registerDocumentWorkspace(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let server: Awaited<ReturnType<typeof serveDocuments>> | undefined;
  let editor: DocumentEditor | undefined;
  let releaseHost: (() => void) | undefined;
  let observedHost: ReturnType<typeof getDocumentHost>;
  let generation = 0;
  let refreshing = false;
  let lastError: string | undefined;
  let projection: Promise<unknown> = Promise.resolve();
  const materialized = new Map<string, string>();

  const report = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message === lastError) return;
    lastError = message;
    context?.ui.notify(`Studio documents: ${message}`, "warning");
  };
  const documentPath = (snapshot: DocumentSnapshot) => {
    const key = createHash("sha256")
      .update(JSON.stringify(snapshot.ref))
      .digest("hex");
    return join(stateDirectory(), "documents", key, `${snapshot.ref.kind}.md`);
  };
  const materialize = async (snapshot: DocumentSnapshot) => {
    const path = documentPath(snapshot);
    const currentGeneration = generation;
    if (materialized.get(path) !== snapshot.revision) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, snapshot.markdown, { mode: 0o600 });
      if (currentGeneration !== generation) {
        await rm(temporary);
        throw new Error("The Studio session changed");
      }
      await rename(temporary, path);
      materialized.set(path, snapshot.revision);
    }
    return { ...snapshot, path };
  };
  const host = () => {
    const current = getDocumentHost(pi);
    if (current === undefined)
      throw new Error("No planning document is bound to this Studio session");
    return current;
  };
  const close = async () => {
    generation++;
    releaseHost?.();
    releaseHost = undefined;
    observedHost = undefined;
    const previous = server;
    server = undefined;
    editor?.dispose();
    editor = undefined;
    materialized.clear();
    await previous?.close();
  };
  const refresh = async (explicit = false) => {
    if (
      refreshing ||
      context === undefined ||
      piModeSchema.parse(context.mode) !== PiMode.Tui
    )
      return;
    refreshing = true;
    const currentGeneration = generation;
    try {
      const config = await loadConfig();
      if (
        !config.integrations.neovim.enabled ||
        !config.integrations.zellij.enabled
      ) {
        if (explicit)
          throw new Error(
            "Enable integrations.neovim and integrations.zellij to open documents",
          );
        return;
      }
      const current = getDocumentHost(pi);
      if (current === undefined) return;
      if (current !== observedHost) {
        releaseHost?.();
        observedHost = current;
        releaseHost = current.onChange(() => {
          refresh().catch(report);
        });
      }
      const snapshot = await current.sync();
      if (snapshot.documents.length === 0) {
        if (explicit)
          throw new Error("No specification or plan has been drafted yet");
        return;
      }
      if (currentGeneration !== generation) return;
      if (server === undefined) {
        const session = process.env["ZELLIJ_SESSION_NAME"];
        if (session === undefined)
          throw new Error(
            "Start Studio inside Zellij to open the companion editor",
          );
        const candidate = await serveDocuments(async (method, params) => {
          if (currentGeneration !== generation)
            throw new Error("The Studio session changed");
          if (
            method === DocumentMethod.Sync ||
            method === DocumentMethod.Save
          ) {
            const operation = projection
              .catch(() => undefined)
              .then(async () => {
                if (currentGeneration !== generation)
                  throw new Error("The Studio session changed");
                const saved =
                  method === DocumentMethod.Save
                    ? await host().save(params)
                    : undefined;
                const state = await host().sync();
                const documents = await Promise.all(
                  state.documents.map(materialize),
                );
                // Replayed save receipts acknowledge their candidate without reverting the current file.
                return saved === undefined
                  ? { ...state, documents }
                  : { ...saved, path: documentPath(saved) };
              });
            projection = operation;
            return await operation;
          }
          switch (method) {
            case DocumentMethod.Feedback:
              return await host().feedback(params);
            case DocumentMethod.Register:
              if (editor === undefined)
                throw new Error("The companion editor has not been launched");
              return await editor.register(params);
          }
        });
        if (currentGeneration !== generation) {
          await candidate.close();
          return;
        }
        server = candidate;
        editor = new DocumentEditor(candidate.manifest, session);
      }
      await editor?.open(config, context.cwd, explicit);
      lastError = undefined;
    } finally {
      refreshing = false;
    }
  };

  pi.registerCommand("documents", {
    description:
      "Open or reconnect this Studio session's specification and plan editor",
    async handler(_argument, ctx) {
      context = ctx;
      await refresh(true);
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    await close();
    context = ctx;
    lastError = undefined;
    await refresh().catch(report);
  });
  pi.on("session_shutdown", async () => {
    context = undefined;
    await close();
  });
  pi.on("tool_execution_end", async (_event, ctx) => {
    context = ctx;
    await refresh().catch(report);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    context = ctx;
    await refresh().catch(report);
  });
}
