import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { StudioConfig } from "../config.ts";
import {
  floatingPaneOptions,
  floatingPaneHeight,
  paneMouse,
  paintPaneLine,
} from "../floating-pane.ts";
import { isKeyRelease, Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { defaultPaneKeybindings } from "../pane-keybindings.ts";
import { DecisionEditor } from "./decision-editor.ts";
import {
  closesTaskBrowser,
  taskCloseHint,
  loadTaskSnapshot,
  TaskBrowser,
  type BrowserSource,
} from "./browser.ts";

export type OpenTasks = (
  ctx: ExtensionContext,
  beadId?: string,
  authority?: StudioConfig["beadsService"],
) => Promise<void>;

export interface PanelSource extends BrowserSource {
  focusPane: (
    id: string,
    attemptId: string | undefined,
    signal: AbortSignal,
  ) => Promise<void>;
}
type PanelContext = Pick<ExtensionContext, "hasUI"> & {
  ui: Pick<ExtensionContext["ui"], "custom" | "notify" | "onTerminalInput">;
};

export class TaskPanel {
  private bindings = defaultPaneKeybindings;
  private generation = 0;
  private paneFocus: AbortController | undefined;
  private removeInputGuard: (() => void) | undefined;
  private closeAnswer: (() => void) | undefined;
  private closeView: (() => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly refreshMs = 5000) {}

  close(): void {
    this.generation++;
    this.paneFocus?.abort();
    this.paneFocus = undefined;
    this.removeInputGuard?.();
    this.removeInputGuard = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    const close = this.closeView;
    this.closeView = undefined;
    this.closeAnswer?.();
    this.closeAnswer = undefined;
    close?.();
  }

  async editAnswer(
    ctx: PanelContext,
    question: string,
  ): Promise<string | undefined> {
    const generation = this.generation;
    let releaseInput: (() => void) | undefined;
    const release = () => {
      releaseInput?.();
      releaseInput = undefined;
    };
    try {
      const answer = await ctx.ui.custom<string | undefined>(
        (tui, theme, _keys, done) => {
          const editor = new DecisionEditor(
            tui,
            theme,
            question,
            done,
            this.bindings,
          );
          if (generation !== this.generation) {
            done(undefined);
            return editor;
          }
          this.closeAnswer = () => {
            done(undefined);
          };
          // Until Pi mounts the editor, the task browser still interprets q as quit.
          releaseInput = ctx.ui.onTerminalInput((input) => {
            if (!isKeyRelease(input)) editor.handleInput(input);
            return { consume: true };
          });
          return editor;
        },
        {
          overlay: true,
          overlayOptions: floatingPaneOptions,
          onHandle: release,
        },
      );
      return generation === this.generation ? answer : undefined;
    } finally {
      release();
      if (generation === this.generation) this.closeAnswer = undefined;
    }
  }

  async open(
    ctx: PanelContext,
    getSource: (current: () => boolean) => Promise<PanelSource | undefined>,
    initialId?: string,
    bindings = defaultPaneKeybindings,
  ): Promise<void> {
    if (!ctx.hasUI) return;
    this.close();
    this.bindings = bindings;
    const generation = this.generation;
    const current = () => generation === this.generation;

    // Pi attaches a custom overlay in a microtask. Protect the lead draft if a
    // terminal sends more keys in the same read as the command/shortcut.
    this.removeInputGuard = ctx.ui.onTerminalInput((input) => {
      if (!isKeyRelease(input) && closesTaskBrowser(input, bindings))
        this.close();
      return { consume: true };
    });
    let start: (() => Promise<void>) | undefined;
    const fail = (error: unknown) => {
      if (!current()) return;
      this.close();
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    };
    try {
      await ctx.ui.custom<undefined>(
        (tui, theme, _keys, done) => {
          this.closeView = () => {
            done(undefined);
          };
          const loading = new Text(
            [
              theme.fg("accent", "Tasks") + " · Loading…",
              taskCloseHint(bindings),
            ]
              .filter(Boolean)
              .join("   "),
            1,
            0,
          );
          let browser: TaskBrowser | undefined;
          const schedule = () => {
            if (!current() || browser === undefined) return;
            const view = browser;
            this.timer = setTimeout(() => {
              view.refresh().then(schedule, fail);
            }, this.refreshMs);
            this.timer.unref();
          };
          start = async () => {
            const source = await getSource(current);
            if (!current()) return;
            if (source === undefined) {
              this.close();
              return;
            }
            const snapshot = await loadTaskSnapshot(source, initialId);
            if (!current()) return;
            browser = new TaskBrowser(
              snapshot,
              source,
              theme,
              () => floatingPaneHeight(tui.terminal.rows),
              () => {
                tui.requestRender();
              },
              (id, attemptId) => {
                if (id === undefined) this.close();
                else if (this.paneFocus === undefined) {
                  const focus = new AbortController();
                  this.paneFocus = focus;
                  source.focusPane(id, attemptId, focus.signal).then(
                    () => {
                      if (current()) this.close();
                    },
                    (error: unknown) => {
                      if (!current()) return;
                      this.paneFocus = undefined;
                      ctx.ui.notify(
                        error instanceof Error ? error.message : String(error),
                        "error",
                      );
                    },
                  );
                }
              },
              initialId,
              bindings,
            );
            schedule();
            tui.requestRender();
          };
          return {
            capturesViewportInput: true,
            invalidate() {
              loading.invalidate();
              browser?.invalidate();
            },
            render(width) {
              return (
                browser?.render(width) ??
                loading
                  .render(width)
                  .map((line) => paintPaneLine(theme, "userMessageBg", line))
              );
            },
            handleInput: (input: string) => {
              if (browser !== undefined) browser.handleInput(input);
              else if (closesTaskBrowser(input, bindings)) this.close();
            },
            handleMouse(event: TuiMouseEvent) {
              return browser?.handleMouse(event) ?? paneMouse(event);
            },
            dispose() {
              browser?.dispose();
            },
          };
        },
        {
          overlay: true,
          overlayOptions: floatingPaneOptions,
          onHandle: () => {
            if (!current()) return;
            this.removeInputGuard?.();
            this.removeInputGuard = undefined;
            start?.().catch(fail);
          },
        },
      );
    } finally {
      if (current()) this.close();
    }
  }
}
