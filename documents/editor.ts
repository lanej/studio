import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { StudioConfig } from "../config.ts";
import { requireIntegration } from "../integrations.ts";
import { packageRoot } from "../package-resources.ts";
import { processStart } from "../process.ts";
import { Zellij } from "../zellij.ts";

const registration = z.object({
  pid: z.number().int().positive(),
  socket: z.string().min(1),
  pane: z.union([z.string(), z.number()]),
  session: z.string().min(1),
});

export class DocumentEditor {
  private zellij: Zellij | undefined;
  private pane: number | undefined;
  private attempted = false;
  private closed = false;
  private disposed = false;
  private registered: { pid: number; started: string } | undefined;
  private readonly name = `Studio documents ${randomUUID().slice(0, 8)}`;

  constructor(
    private readonly manifest: string,
    private readonly session: string,
  ) {}

  dispose(): void {
    this.disposed = true;
  }

  private isDisposed(): boolean {
    return this.disposed;
  }

  private async recoverPane(): Promise<boolean> {
    const zellij = this.zellij;
    if (zellij === undefined) return false;
    const panes = await zellij.panes();
    if (this.pane !== undefined) {
      const live = panes.find(
        (entry) => entry.id === this.pane && !entry.exited && !entry.is_plugin,
      );
      if (live !== undefined && this.registered !== undefined) {
        try {
          if (
            (await processStart(this.registered.pid)) ===
            this.registered.started
          )
            return true;
        } catch {
          // A reused PID or pane must not inherit this editor's binding.
        }
      }
      if (live?.terminal_command?.includes(this.manifest) === true) return true;
      this.closed = true;
      return false;
    }
    const matches = panes.filter(
      (entry) =>
        !entry.exited &&
        !entry.is_plugin &&
        entry.terminal_command?.includes(this.manifest) === true,
    );
    if (matches.length !== 1) return false;
    const matched = matches[0];
    if (matched === undefined) return false;
    this.pane = matched.id;
    return true;
  }

  async open(
    config: StudioConfig,
    cwd: string,
    explicit = false,
  ): Promise<void> {
    if (this.isDisposed()) return;
    if (await this.recoverPane()) return;
    if (this.closed && !explicit) return;
    if (this.attempted && !this.closed)
      throw new Error(
        "Editor launch is uncertain; inspect the Studio documents pane before trying again",
      );
    const executable = await requireIntegration(config, "neovim");
    await requireIntegration(config, "zellij");
    const zellij = new Zellij(this.session);
    const tab = await zellij.launchTab();
    await zellij.requireUnsharedTab(tab);
    if (this.isDisposed()) return;
    this.zellij = zellij;
    this.attempted = true;
    this.closed = false;
    this.registered = undefined;
    this.pane = undefined;
    try {
      this.pane = await zellij.launch(tab, this.name, cwd, [
        `STUDIO_NVIM_RUNTIME=${join(packageRoot, "resources/nvim")}`,
        `STUDIO_DOCUMENT_CONNECTION=${this.manifest}`,
        executable,
        "-c",
        "lua dofile(vim.env.STUDIO_NVIM_RUNTIME .. '/bootstrap.lua')",
      ]);
    } catch (error) {
      if (!(await this.recoverPane())) throw error;
    }
  }

  async register(value: unknown): Promise<{ registered: true }> {
    if (this.disposed) throw new Error("The Studio document session ended");
    const candidate = registration.parse(value);
    const pane = Number(String(candidate.pane).replace(/^terminal_/u, ""));
    if (!Number.isSafeInteger(pane) || candidate.session !== this.session)
      throw new Error("The document editor belongs to another Zellij session");
    if (this.zellij === undefined)
      throw new Error("No document editor launch is pending");
    const live = (await this.zellij.panes()).find(
      (entry) => entry.id === pane && !entry.is_plugin && !entry.exited,
    );
    if (live === undefined || (this.pane !== undefined && this.pane !== pane))
      throw new Error("The document editor pane changed");
    if (
      this.pane === undefined &&
      live.terminal_command?.includes(this.manifest) !== true
    )
      throw new Error("The pending editor launch could not be verified");
    const started = await processStart(candidate.pid);
    if (started.length === 0)
      throw new Error("The document editor process has exited");
    this.pane = pane;
    this.registered = { pid: candidate.pid, started };
    return { registered: true };
  }
}
