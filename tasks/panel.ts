import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import {
  loadTaskSnapshot,
  TaskBrowser,
  type BrowserSource,
} from "./browser.ts";

interface PanelSource extends BrowserSource {
  key: string;
  focusPane: (id: string) => Promise<void>;
}
type PanelContext = Pick<ExtensionContext, "hasUI"> & {
  ui: Pick<ExtensionContext["ui"], "custom" | "notify">;
};

export class TaskPanel {
  private generation = 0;
  private key: string | undefined;
  private handle: OverlayHandle | undefined;
  private closeView: (() => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly refreshMs = 5000) {}

  close(): void {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    const close = this.closeView;
    this.closeView = undefined;
    this.handle = undefined;
    this.key = undefined;
    close?.();
  }

  focus(): void {
    this.handle?.focus();
  }

  async open(
    ctx: PanelContext,
    source: PanelSource,
    initialId?: string,
  ): Promise<void> {
    if (!ctx.hasUI) return;
    if (
      this.key === source.key &&
      this.handle !== undefined &&
      initialId === undefined
    ) {
      this.handle.unfocus();
      return;
    }
    this.close();
    const generation = this.generation;
    this.key = source.key;
    const snapshot = await loadTaskSnapshot(source, initialId).catch(
      (error: unknown) => {
        if (generation !== this.generation) return undefined;
        this.close();
        throw error;
      },
    );
    if (snapshot === undefined || generation !== this.generation) return;
    const current = () => generation === this.generation;
    const failed = (error: unknown) => {
      if (!current()) return;
      this.close();
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    };
    const view = ctx.ui.custom<undefined>(
      (tui, theme, _keys, done) => {
        if (!current()) {
          done(undefined);
          return { invalidate() {}, render: () => [] };
        }
        this.closeView = () => {
          done(undefined);
        };
        const leave = () => {
          this.handle?.unfocus();
          tui.requestRender();
        };
        const browser = new TaskBrowser(
          snapshot,
          source,
          theme,
          () => Math.max(1, tui.terminal.rows - 5),
          () => {
            tui.requestRender();
          },
          (id) => {
            if (id === undefined) this.close();
            else {
              leave();
              source.focusPane(id).catch((error: unknown) => {
                if (current())
                  ctx.ui.notify(
                    error instanceof Error ? error.message : String(error),
                    "error",
                  );
              });
            }
          },
          initialId,
          { focused: () => this.handle?.isFocused() === true, leave },
        );
        const schedule = () => {
          if (!current()) return;
          this.timer = setTimeout(() => {
            browser.refresh().then(schedule, failed);
          }, this.refreshMs);
          this.timer.unref();
        };
        schedule();
        return browser;
      },
      {
        overlay: true,
        overlayOptions: {
          width: 80,
          maxHeight: 24,
          anchor: "top-right",
          margin: { bottom: 5 },
          nonCapturing: true,
        },
        onHandle: (handle) => {
          if (current()) this.handle = handle;
          else handle.hide();
        },
      },
    );
    view.then(() => {
      if (current()) this.close();
    }, failed);
  }
}
