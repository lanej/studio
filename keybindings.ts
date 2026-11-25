import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  type KeybindingsConfig,
  type KeybindingsManager,
} from "@earendil-works/pi-tui";
import { isDeepStrictEqual } from "node:util";
import { PiMode, piModeSchema } from "./runtime.ts";

const historyDefaults = {
  "tui.editor.historyPrevious": "ctrl+p",
  "tui.editor.historyNext": "ctrl+n",
} as const;

/** Session-local defaults over Pi's authored keybindings. */
export class HistoryBindings {
  private applied: KeybindingsConfig | undefined;

  constructor(private readonly manager: KeybindingsManager) {}

  apply(): void {
    // Pi aliases this public module to its host copy. Refuse the plain TUI
    // fallback manager if this extension is loaded by an incompatible host.
    if (
      !Object.hasOwn(
        this.manager.getResolvedBindings(),
        "app.model.cycleForward",
      )
    )
      return;
    const source = this.manager.getUserBindings();
    if (isDeepStrictEqual(source, this.applied)) return;
    const applied = { ...source };
    for (const [action, key] of Object.entries(historyDefaults)) {
      const claimed = Object.values(source).some((binding) =>
        Array.isArray(binding) ? binding.includes(key) : binding === key,
      );
      // An explicit empty array disables an action. Any authored claim on the
      // proposed key also wins, even when it belongs to another action.
      if (source[action] === undefined && !claimed) applied[action] = key;
    }
    this.applied = applied;
    this.manager.setUserBindings(applied);
  }
}

export function registerHistoryBindings(pi: ExtensionAPI): void {
  let layer: HistoryBindings | undefined;
  let removeInputListener: (() => void) | undefined;
  const release = () => {
    removeInputListener?.();
    removeInputListener = undefined;
    // Pi owns authoritative reload/reset. Its public manager has no origin
    // marker, so teardown never removes entries that may now be authored.
    layer = undefined;
  };
  pi.on("session_start", (_event, ctx) => {
    release();
    if (piModeSchema.parse(ctx.mode) !== PiMode.Tui) return;
    layer = new HistoryBindings(getKeybindings());
    layer.apply();
    // Pi reloads authored keybindings after session_start. The raw input hook
    // restores this default layer before the first key reaches its editor.
    removeInputListener = ctx.ui.onTerminalInput(() => {
      layer?.apply();
      return undefined;
    });
  });
  pi.on("session_shutdown", release);
}
