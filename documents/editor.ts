import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AttachmentState,
  EditorLauncher,
  LaunchRequest,
} from "@lanej/copydesk";
import type { EditorRegistration } from "@lanej/copydesk/protocol";
import type { StudioConfig } from "../config.ts";
import { requireIntegration } from "../integrations.ts";
import { processStart, run } from "../process.ts";
import { Zellij } from "../zellij.ts";

const processBinding = z.object({
  pid: z.number().int().positive(),
  pane: z.string(),
  session: z.string(),
  connection: z.string(),
});

interface RetainedDocumentPane {
  zellij: Zellij;
  pid: number;
  started: string;
  manifestPath: string;
}

declare global {
  var studioRetainedDocumentPanes:
    | Map<number, RetainedDocumentPane>
    | undefined;
}

globalThis.studioRetainedDocumentPanes ??= new Map();
const retainedPanes = globalThis.studioRetainedDocumentPanes;

export async function preserveDocumentPanesOnQuit(): Promise<void> {
  for (const [pane, retained] of retainedPanes) {
    const started = await processStart(retained.pid).catch(() => "");
    if (started !== retained.started) continue;
    await retained.zellij.keepFloatingPaneOnExit(pane, retained.manifestPath);
  }
}

/** Studio owns the pane and process proof; the independent core owns its protocol. */
export class StudioEditorLauncher implements EditorLauncher {
  private zellij: Zellij | undefined;
  private pane: number | undefined;
  private request: LaunchRequest | undefined;
  private attempted = false;
  private disposed = false;
  private registered: { pid: number; started: string } | undefined;
  private attachmentId: string | undefined;
  private executable: string | undefined;
  private readonly name = `Studio documents ${randomUUID().slice(0, 8)}`;
  constructor(
    private readonly config: StudioConfig,
    private readonly session: string,
  ) {}
  private isDisposed(): boolean {
    return this.disposed;
  }

  private async observe(): Promise<AttachmentState> {
    const zellij = this.zellij;
    const request = this.request;
    if (zellij === undefined || request === undefined)
      return { state: "closed" };
    let panes: Awaited<ReturnType<Zellij["panes"]>>;
    try {
      panes = await zellij.panes();
    } catch (cause) {
      return {
        state: "uncertain",
        reason: cause instanceof Error ? cause.message : String(cause),
      };
    }
    if (this.pane === undefined) {
      const candidates = panes.filter(
        (pane) =>
          !pane.exited &&
          !pane.is_plugin &&
          pane.terminal_command?.includes(request.manifestPath) === true,
      );
      if (candidates.length !== 1)
        return {
          state: "uncertain",
          reason:
            "Editor launch is unconfirmed; inspect the existing pane before retrying",
        };
      this.pane = candidates[0]?.id;
    }
    const pane = panes.find(
      (pane) => pane.id === this.pane && !pane.exited && !pane.is_plugin,
    );
    if (pane === undefined) {
      return { state: "closed" };
    }
    if (this.registered !== undefined) {
      try {
        if (
          (await processStart(this.registered.pid)) !== this.registered.started
        ) {
          return { state: "closed" };
        }
      } catch {
        return { state: "closed" };
      }
    } else if (pane.terminal_command?.includes(request.manifestPath) !== true) {
      return {
        state: "uncertain",
        reason: "The editor pane no longer identifies the issued launch",
      };
    }
    this.attachmentId ??= JSON.stringify({
      server: zellij.identity,
      pane: this.pane,
      launchId: request.launchId,
    });
    return { state: "open", attachmentId: this.attachmentId };
  }
  async inspect(attachmentId: string): Promise<AttachmentState> {
    if (this.isDisposed())
      return {
        state: "uncertain",
        reason: "The Studio editor activation ended",
      };
    if (attachmentId !== this.attachmentId)
      return { state: "uncertain", reason: "The editor attachment changed" };
    return await this.observe();
  }
  async ensure(request: LaunchRequest): Promise<AttachmentState> {
    if (this.isDisposed())
      return {
        state: "uncertain",
        reason: "The Studio editor activation ended",
      };
    if (this.attempted) {
      const existing = await this.observe();
      if (existing.state !== "closed") return existing;
      if (!request.explicit) return existing;
    }
    const executable = await requireIntegration(this.config, "neovim");
    await requireIntegration(this.config, "zellij");
    const zellij = new Zellij(this.session);
    const tab = await zellij.launchTab();
    await zellij.requireUnsharedTab(tab);
    if (this.isDisposed())
      return {
        state: "uncertain",
        reason: "The Studio editor activation ended during launch validation",
      };
    this.request = { ...request };
    this.zellij = zellij;
    this.executable = executable;
    this.attempted = true;
    this.registered = undefined;
    this.pane = undefined;
    this.attachmentId = undefined;
    try {
      this.pane = await zellij.launch(
        tab,
        this.name,
        request.workingDirectory,
        [
          `COPYDESK_RUNTIME=${request.runtimePath}`,
          `COPYDESK_CONNECTION=${request.manifestPath}`,
          executable,
          "-c",
          "lua dofile(vim.env.COPYDESK_RUNTIME .. '/bootstrap.lua')",
        ],
        "pinned-floating",
      );
    } catch (cause) {
      const recovered = await this.observe();
      return recovered.state === "open"
        ? recovered
        : {
            state: "uncertain",
            reason: cause instanceof Error ? cause.message : String(cause),
          };
    }
    return await this.observe();
  }
  async verifyRegistration(
    request: LaunchRequest,
    registration: EditorRegistration,
  ): Promise<{ attachmentId: string; processIdentity: string }> {
    if (
      this.isDisposed() ||
      this.request?.launchId !== request.launchId ||
      registration.launchId !== request.launchId ||
      this.executable === undefined ||
      this.zellij === undefined
    )
      throw new Error("No matching Studio editor launch is pending");
    const binding = processBinding.parse(
      JSON.parse(
        await run(
          this.executable,
          [
            "--server",
            registration.rpcAddress,
            "--remote-expr",
            "json_encode({'pid':getpid(),'pane':$ZELLIJ_PANE_ID,'session':$ZELLIJ_SESSION_NAME,'connection':$COPYDESK_CONNECTION})",
          ],
          { timeout: 3000 },
        ),
      ),
    );
    const pane = Number(binding.pane.replace(/^terminal_/u, ""));
    if (
      !Number.isSafeInteger(pane) ||
      pane < 0 ||
      binding.pid !== registration.processId ||
      binding.session !== this.session ||
      binding.connection !== request.manifestPath ||
      (this.pane !== undefined && pane !== this.pane)
    )
      throw new Error(
        "The Neovim process does not belong to the issued Studio pane",
      );
    const livePanes = (await this.zellij.panes()).filter(
      (entry) => !entry.exited && !entry.is_plugin,
    );
    const live = livePanes.find((entry) => entry.id === pane);
    if (
      live === undefined ||
      (this.pane === undefined &&
        live.terminal_command?.includes(request.manifestPath) !== true)
    )
      throw new Error("The pending Studio pane could not be verified");
    const started = await processStart(registration.processId);
    if (
      started.length === 0 ||
      this.isDisposed() ||
      this.request.launchId !== request.launchId
    )
      throw new Error("The editor activation changed during registration");
    this.pane = pane;
    this.registered = { pid: registration.processId, started };
    // A closed workspace can leave a dirty editor alive across a Studio reload.
    const liveIds = new Set(livePanes.map((entry) => entry.id));
    for (const id of retainedPanes.keys()) {
      if (!liveIds.has(id)) retainedPanes.delete(id);
    }
    retainedPanes.set(pane, {
      zellij: this.zellij,
      ...this.registered,
      manifestPath: request.manifestPath,
    });
    this.attachmentId ??= JSON.stringify({
      server: this.zellij.identity,
      pane,
      launchId: request.launchId,
    });
    return {
      attachmentId: this.attachmentId,
      processIdentity: JSON.stringify(this.registered),
    };
  }
  dispose(): Promise<void> {
    this.disposed = true;
    return Promise.resolve();
  }
}
