import { type KeyId, matchesKey } from "@earendil-works/pi-tui";

export { defaultPaneKeybindings, type PaneKeybindings } from "./pane-keybindings-config.ts";

export function matchesPaneKey(input: string, keys: readonly KeyId[]): boolean {
  return keys.some((key) => matchesKey(input, key));
}

const labels = new Map(
  Object.entries({
    escape: "Esc",
    enter: "Enter",
    space: "Space",
    tab: "Tab",
    up: "↑",
    down: "↓",
    left: "←",
    right: "→",
    pageUp: "PgUp",
    pageDown: "PgDn",
    backspace: "Backspace",
    delete: "Delete",
    insert: "Insert",
    clear: "Clear",
    home: "Home",
    end: "End",
    ctrl: "Ctrl",
    shift: "Shift",
    alt: "Alt",
    super: "Super",
  }),
);

export function paneKeyLabel(keys: readonly KeyId[]): string {
  const key = keys[0];
  if (key === undefined) return "";
  return key.replace(
    /[a-z][a-z0-9]*/giu,
    (part) => labels.get(part) ?? (part === key && part.length === 1 ? part : part.toUpperCase()),
  );
}

export function paneKeyHint(keys: readonly KeyId[], action: string): string {
  const label = paneKeyLabel(keys);
  return label.length === 0 ? "" : `${label} ${action}`;
}

export function paneKeyPair(first: readonly KeyId[], second: readonly KeyId[]): string {
  const labels = [paneKeyLabel(first), paneKeyLabel(second)].filter(Boolean);
  return labels.join(labels[0] === "↑" && labels[1] === "↓" ? "" : "/");
}
