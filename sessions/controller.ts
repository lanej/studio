import { randomUUID } from "node:crypto";
import type { LoopOwner, LoopRecord, LoopStore } from "./store.ts";

export interface LoopAdmission {
  session: string;
  eligible: boolean;
  settled: boolean;
  pendingInput: boolean;
  editorText: string;
  dialogs: number;
}
export interface LoopHost {
  snapshot(): LoopAdmission;
  dispatch(prompt: string): void;
  changed(record: LoopRecord): void;
  schedule(callback: () => void, milliseconds: number): () => void;
}

export class PromptLoop {
  private cancel: (() => void) | undefined;
  private released = false;
  private dispatched: string | undefined;
  private candidate: string | undefined;
  private active: string | undefined;
  constructor(
    private readonly store: LoopStore,
    private record: LoopRecord,
    private readonly owner: LoopOwner,
    private readonly host: LoopHost,
  ) {}
  get current(): LoopRecord {
    return this.record;
  }
  private change(update: Partial<LoopRecord>): void {
    if (this.released) throw new Error("Loop controller has been released");
    const current = this.store.get(this.record.session);
    if (current?.owner?.token !== this.owner.token)
      throw new Error("Another process owns this loop");
    this.record = this.store.save(
      { ...this.record, ...update },
      this.record.revision,
    );
    this.host.changed(this.record);
  }
  start(): void {
    if (this.record.needsInspection || this.record.intent !== null)
      throw new Error(
        "Inspect the uncertain iteration with /loop status, then /loop resume inspected",
      );
    this.change({
      state: "running",
      reason: "Waiting for cadence and idle input",
    });
    this.arm();
  }
  input(extension: boolean, prompt: string): void {
    this.candidate =
      extension &&
      prompt === this.record.prompt &&
      this.dispatched === this.record.intent?.id
        ? this.dispatched
        : undefined;
  }
  started(user: boolean): void {
    this.active = user ? this.candidate : undefined;
    this.candidate = undefined;
    this.dispatched = undefined;
  }
  resume(): void {
    // Explicit inspection acknowledges uncertainty; it never replays the previous intent.
    this.dispatched = undefined;
    this.candidate = undefined;
    this.active = undefined;
    this.change({ intent: null, needsInspection: false });
    this.start();
  }
  configure(prompt: string, cadenceMs: number): void {
    if (this.record.intent !== null)
      throw new Error("Inspect the uncertain iteration before reconfiguring");
    this.stop();
    this.change({
      prompt,
      cadenceMs,
      count: 0,
      attempts: 0,
      lastSettled: null,
      needsInspection: false,
      state: "paused",
      reason: "Configured; use /loop start",
    });
  }
  stop(): void {
    this.clear();
    this.change({
      state: "stopped",
      reason: "Stopped; current turn may finish",
    });
  }
  pause(reason: string): void {
    this.clear();
    this.change({ state: "paused", reason, needsInspection: true });
  }
  settled(aborted: boolean): void {
    if (this.record.intent !== null) {
      // Restored uncertainty has no matching run in this host. A manual turn
      // can settle without supplying any evidence about that older operation.
      if (this.record.intent.id !== this.active) return;
      this.active = undefined;
      if (aborted) {
        this.pause("Interrupted iteration is uncertain; inspect before resume");
        return;
      }
      this.change({
        lastSettled: {
          id: this.record.intent.id,
          ordinal: this.record.intent.ordinal,
          at: Date.now(),
        },
        intent: null,
        count: this.record.count + 1,
        reason:
          this.record.state === "running"
            ? "Iteration settled; waiting for next cadence"
            : this.record.reason,
      });
    }
    this.arm();
  }
  release(): void {
    if (this.released) return;
    this.pause(
      this.record.intent === null
        ? "Session left; explicit resume required"
        : "Session left with uncertain iteration; inspect before resume",
    );
    this.change({ owner: null });
    this.released = true;
  }
  private clear(): void {
    this.cancel?.();
    this.cancel = undefined;
  }
  private arm(): void {
    this.clear();
    if (this.record.state !== "running" || this.record.intent !== null) return;
    this.cancel = this.host.schedule(() => {
      this.cancel = undefined;
      try {
        const now = this.host.snapshot();
        if (now.session !== this.record.session || !now.eligible) {
          this.pause("Target is no longer eligible; explicit resume required");
          return;
        }
        if (
          !now.settled ||
          now.pendingInput ||
          now.editorText.length > 0 ||
          now.dialogs > 0
        ) {
          this.arm();
          return;
        }
        this.change({
          intent: {
            id: randomUUID(),
            ordinal: this.record.attempts + 1,
            at: Date.now(),
          },
          attempts: this.record.attempts + 1,
          reason: "Iteration dispatched",
        });
        this.dispatched = this.record.intent?.id;
        this.host.dispatch(this.record.prompt);
      } catch (error) {
        this.dispatched = undefined;
        this.candidate = undefined;
        this.active = undefined;
        this.clear();
        // A dispatch exception is not evidence that the provider received nothing.
        try {
          this.pause(
            `Uncertain dispatch: ${error instanceof Error ? error.message : String(error)}`,
          );
        } catch {
          this.released = true;
        }
      }
    }, this.record.cadenceMs);
  }
}
