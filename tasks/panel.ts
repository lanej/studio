import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { StudioConfig } from "../config.ts";
import {
  floatingPaneOptions,
  floatingPaneHeight,
  paneMouse,
  paintPaneLine,
} from "../floating-pane.ts";
import {
  isKeyRelease,
  Text,
  type OverlayHandle,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
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
  ui: Pick<
    ExtensionContext["ui"],
    "custom" | "notify" | "onTerminalInput" | "setWidget"
  >;
};

const answerWidget = "studio:worker-answer";

export class TaskPanel {
  private bindings = defaultPaneKeybindings;
  private generation = 0;
  private paneFocus: AbortController | undefined;
  private removeInputGuard: (() => void) | undefined;
  private browserOverlay: OverlayHandle | undefined;
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
    // Restore the inspector before closing it so Pi returns focus to the lead editor.
    this.closeAnswer?.();
    this.browserOverlay = undefined;
    close?.();
  }

  async editAnswer(
    ctx: PanelContext,
    question: string,
    taskTitle?: string,
  ): Promise<string | undefined> {
    const overlay = this.browserOverlay;
    if (overlay === undefined || this.closeAnswer !== undefined)
      return undefined;
    const generation = this.generation;

    // Keep the inspector mounted so its selection and scroll position survive the reply.
    const answer = await new Promise<string | undefined>((resolve, reject) => {
      const finish = (value: string | undefined, removeWidget = true) => {
        if (this.closeAnswer !== cancel) return;
        this.closeAnswer = undefined;
        if (removeWidget) ctx.ui.setWidget(answerWidget, undefined);
        if (this.browserOverlay === overlay) overlay.setHidden(false);
        resolve(value);
      };
      const cancel = () => {
        finish(undefined);
      };
      this.closeAnswer = cancel;
      try {
        overlay.setHidden(true);
        ctx.ui.setWidget(
          answerWidget,
          (tui, theme) => {
            const editor = new DecisionEditor(
              tui,
              theme,
              question,
              finish,
              this.bindings,
              taskTitle,
            );
            // Pi mounts widgets synchronously. The next key in this read already belongs to the reply.
            tui.setFocus(editor);
            return Object.assign(editor, {
              dispose() {
                // The host may remove widgets during a reload or session switch.
                finish(undefined, false);
              },
            });
          },
          { placement: "aboveEditor" },
        );
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        cancel();
      }
    });
    return generation === this.generation ? answer : undefined;
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
          onHandle: (handle) => {
            if (!current()) return;
            this.browserOverlay = handle;
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
