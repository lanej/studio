import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { EditorWorkspace } from "@lanej/editor-interop";
import { loadConfig } from "../config.ts";
import { PiMode, piModeSchema } from "../runtime.ts";
import {
  getPlanningDocuments,
  type PlanningBinding,
} from "../planning/documents.ts";

/** Optional editor composition; planning controls do not load the interoperability package. */
export function registerDocumentWorkspace(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let workspace: EditorWorkspace | undefined;
  let bound: PlanningBinding | undefined;
  let releaseHost: (() => void) | undefined;
  let observedHost: ReturnType<typeof getPlanningDocuments>;
  let epoch = 0;
  let refreshing: Promise<void> | undefined;
  let again = false;
  const needsRefresh = () => again;
  let explicit = false;
  let lastError: string | undefined;
  const report = (cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message !== lastError)
      context?.ui.notify(`Studio documents: ${message}`, "warning");
    lastError = message;
  };
  const close = async (quitting = false) => {
    epoch++;
    releaseHost?.();
    releaseHost = undefined;
    observedHost = undefined;
    bound = undefined;
    const previous = workspace;
    workspace = undefined;
    if (quitting && context !== undefined && context.mode === PiMode.Tui) {
      const { preserveDocumentPanesOnQuit } = await import("./editor.ts");
      await preserveDocumentPanesOnQuit().catch(report);
    }
    await previous?.dispose();
  };
  const refreshNow = async (open: boolean) => {
    const ctx = context;
    if (ctx === undefined || piModeSchema.parse(ctx.mode) !== PiMode.Tui)
      return;
    const activation = epoch;
    const config = await loadConfig();
    if (activation !== epoch) return;
    if (
      !config.integrations.neovim.enabled ||
      !config.integrations.zellij.enabled
    ) {
      if (workspace !== undefined) await close();
      if (open)
        throw new Error(
          "Enable integrations.neovim and integrations.zellij to open documents",
        );
      return;
    }
    const authority = getPlanningDocuments(pi);
    const binding = authority?.binding();
    if (authority === undefined || binding === undefined) return;
    if (authority !== observedHost) {
      releaseHost?.();
      observedHost = authority;
      releaseHost = authority.onChange(() => {
        refresh().catch(report);
      });
    }
    if (workspace !== undefined && !isDeepStrictEqual(bound, binding)) {
      const previous = workspace;
      workspace = undefined;
      bound = undefined;
      await previous.dispose();
      if (activation !== epoch) return;
    }
    if (workspace === undefined) {
      const session = process.env["ZELLIJ_SESSION_NAME"];
      if (session === undefined)
        throw new Error(
          "Start Studio inside Zellij to open the companion editor",
        );
      const [
        { createWorkspace },
        { StudioDocumentProvider },
        { StudioEditorLauncher },
      ] = await Promise.all([
        import("@lanej/editor-interop"),
        import("./provider.ts"),
        import("./editor.ts"),
      ]);
      if (activation !== epoch) return;
      authority.assertBinding(binding);
      const provider = new StudioDocumentProvider(authority, binding);
      const candidate = await createWorkspace({
        context: provider.context,
        provider,
        launcher: new StudioEditorLauncher(config, session),
        directory: await mkdtemp(join(tmpdir(), "studio-editor-")),
        runtimePath: dirname(
          fileURLToPath(import.meta.resolve("@lanej/editor-interop/neovim")),
        ),
        workingDirectory: binding.project,
        title: "Studio documents",
      });
      if (
        activation !== epoch ||
        !isDeepStrictEqual(authority.binding(), binding)
      ) {
        await candidate.dispose();
        return;
      }
      workspace = candidate;
      bound = binding;
    } else await workspace.refresh();
    if (open) {
      const result = await workspace.open();
      if (result.state === "uncertain") throw new Error(result.reason);
    }
    lastError = undefined;
  };
  const refresh = (open = false): Promise<void> => {
    explicit ||= open;
    if (refreshing !== undefined) {
      again = true;
      return refreshing;
    }
    refreshing = (async () => {
      do {
        again = false;
        const requested = explicit;
        explicit = false;
        await refreshNow(requested);
      } while (needsRefresh());
    })().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
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
  pi.on("session_shutdown", async (event) => {
    try {
      await close(event.reason === "quit");
    } finally {
      context = undefined;
    }
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
