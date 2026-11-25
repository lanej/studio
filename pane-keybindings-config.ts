import type { KeyId } from "@earendil-works/pi-tui";
import { z } from "zod";

// Pi exports the KeyId type, but its configuration parser is private. Keep this
// grammar independent of its TUI runtime so Studio's CLI can read the same file.
const modifiers = ["ctrl", "shift", "alt", "super"] as const;
const specialKeys = [
  "escape",
  "enter",
  "tab",
  "space",
  "backspace",
  "delete",
  "insert",
  "clear",
  "home",
  "end",
  "pageUp",
  "pageDown",
  "up",
  "down",
  "left",
  "right",
  "f1",
  "f2",
  "f3",
  "f4",
  "f5",
  "f6",
  "f7",
  "f8",
  "f9",
  "f10",
  "f11",
  "f12",
] as const satisfies readonly KeyId[];
const baseKeys = new Map<string, string>(
  specialKeys.map((key) => [key.toLowerCase(), key]),
);
baseKeys.set("return", "enter");
baseKeys.set("esc", "escape");
const printable = /^[!-~]$/u;
function canonicalKey(value: string): string {
  const lower = value.trim().toLowerCase();
  const prefix = /^(?:(?:ctrl|shift|alt|super)\+)*/u.exec(lower)?.[0] ?? "";
  const parts = prefix.split("+");
  // Preserve repeats so the grammar rejects duplicate modifiers.
  const sorted = modifiers.flatMap((modifier) =>
    parts.filter((part) => part === modifier),
  );
  const base = lower.slice(prefix.length);
  return [...sorted, baseKeys.get(base) ?? base].join("+");
}

const keySchema = z
  .string()
  .transform(canonicalKey)
  .pipe(
    z.custom<KeyId>((value) => {
      if (typeof value !== "string") return false;
      const base = value.replace(
        /^(?:ctrl\+)?(?:shift\+)?(?:alt\+)?(?:super\+)?/u,
        "",
      );
      // Pi only matches Escape without modifiers, even with CSI-u reporting.
      if (base === "escape" && value !== base) return false;
      return (
        baseKeys.has(base.toLowerCase()) ||
        (printable.test(base) && base !== '"')
      );
    }, "Invalid Pi key identifier"),
  );
function binding(...defaults: KeyId[]) {
  return z
    .union([keySchema, z.array(keySchema)])
    .transform((value) => [
      ...new Set(typeof value === "string" ? [value] : value),
    ])
    .default(() => [...defaults]);
}

const paneGroups = z
  .strictObject({
    lead: z
      .strictObject({
        openPicker: binding(),
        openWorkers: binding(),
        openTasks: binding(),
        toggleStatus: binding(),
      })
      .prefault({}),
    picker: z
      .strictObject({
        workers: binding("w"),
        tasks: binding("t"),
        status: binding("s"),
      })
      .prefault({}),
    pane: z
      .strictObject({
        up: binding("up", "k"),
        down: binding("down", "j"),
        activate: binding("enter"),
        close: binding("escape", "ctrl+c"),
        pageUp: binding("pageUp"),
        pageDown: binding("pageDown"),
        focusWorker: binding("right"),
      })
      .prefault({}),
    tasks: z
      .strictObject({
        back: binding("left"),
        refresh: binding("r"),
        nextLink: binding("tab"),
        previousLink: binding("shift+tab"),
        quit: binding("q"),
      })
      .prefault({}),
    decision: z
      .strictObject({
        pageUp: binding("pageUp"),
        pageDown: binding("pageDown"),
      })
      .prefault({}),
  })
  .prefault({});

export type PaneKeybindings = z.output<typeof paneGroups>;

export const paneKeybindingsSchema = paneGroups.superRefine((bindings, ctx) => {
  const { lead, picker, pane, tasks, decision } = bindings;
  const claims = new Map<string, string>();
  const reported = new Set<string>();
  function check(
    group: keyof PaneKeybindings,
    actions: Record<string, KeyId[]>,
  ) {
    for (const [action, keys] of Object.entries(actions)) {
      const name = `${group}.${action}`;
      for (const key of keys) {
        const previous = claims.get(key);
        if (previous === undefined) {
          claims.set(key, name);
          continue;
        }
        // These controls all dismiss the focused picker or browser.
        if (
          previous === "pane.close" &&
          (name === "lead.openPicker" || name === "tasks.quit")
        )
          continue;
        const conflict = `${name} conflicts with ${previous} on ${key}`;
        if (reported.has(conflict)) continue;
        reported.add(conflict);
        ctx.addIssue({
          code: "custom",
          path: [group, action],
          message: conflict,
        });
      }
    }
  }

  check("lead", lead);
  claims.clear();
  check("pane", pane); // Worker inspector uses every shared action.
  claims.clear();
  const { focusWorker, pageUp, pageDown, ...navigation } = pane;
  check("pane", { ...navigation, pageUp, pageDown });
  check("picker", picker);
  check("lead", { openPicker: lead.openPicker });
  claims.clear();
  check("pane", { ...navigation, focusWorker });
  check("tasks", tasks);
  claims.clear();
  check("decision", decision);
  for (const [action, keys] of Object.entries(decision)) {
    if (keys.some((key) => /^(?:shift\+)?(?:[!-~]|space)$/u.test(key))) {
      ctx.addIssue({
        code: "custom",
        path: ["decision", action],
        message: "Use a non-printing shortcut to keep guidance editable",
      });
    }
  }
});

export const defaultPaneKeybindings = paneKeybindingsSchema.parse({});
