import { CURSOR_MARKER, Editor, matchesKey, truncateToWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import { selectorText, type StatusTheme } from "@lanej/pi-components";
import { beadEditSchema, type BeadEdit, type RuntimeBead } from "./status-beads.ts";
import { statusLine } from "./status.ts";

const labels = ["Title", "Description", "Acceptance criteria", "Priority"] as const;

export class RuntimeBeadEditor {
  private readonly editors;
  private readonly originals;
  private selection = 0;

  constructor(
    readonly before: RuntimeBead,
    private readonly theme: StatusTheme,
    tui: TUI,
  ) {
    const bead = before.bead;
    const priority = bead["priority"];
    this.editors = [
      bead.title,
      bead.description,
      bead.acceptance_criteria,
      typeof priority === "number" ? `P${String(priority)}` : "",
    ].map((value) => {
      const editor = new Editor(
        tui,
        {
          borderColor: theme.muted,
          selectList: {
            selectedPrefix: theme.accent,
            selectedText: theme.selected,
            description: theme.muted,
            scrollInfo: theme.muted,
            noMatch: theme.muted,
          },
        },
        { paddingX: 1 },
      );
      editor.disableSubmit = true;
      editor.setText(selectorText(value));
      return editor;
    });
    this.originals = this.editors.map((editor) => editor.getExpandedText());
  }

  handleInput(input: string): void {
    if (matchesKey(input, "tab") || matchesKey(input, "shift+tab")) {
      this.selection = (this.selection + (matchesKey(input, "tab") ? 1 : labels.length - 1)) % labels.length;
      return;
    }
    this.editors[this.selection]?.handleInput(matchesKey(input, "enter") ? "\n" : input);
  }

  patch(): BeadEdit {
    const changed = this.editors.map((editor, index) => {
      const value = editor.getExpandedText();
      return value === this.originals[index] ? undefined : value;
    });
    const [title, description, acceptance, priority] = changed;
    if (title !== undefined && (title.trim() === "" || /[\p{Cc}\u2028\u2029]/u.test(title.trim()))) {
      this.selection = 0;
      throw new Error("Enter a nonempty title on one line");
    }
    const priorityValue = priority?.trim().replace(/^p/iu, "");
    if (priorityValue !== undefined && !/^[0-4]$/u.test(priorityValue)) {
      this.selection = 3;
      throw new Error("Enter a priority from P0 to P4");
    }
    return beadEditSchema.parse({
      ...(title === undefined ? {} : { title }),
      ...(description === undefined ? {} : { description }),
      ...(acceptance === undefined ? {} : { acceptance_criteria: acceptance }),
      ...(priorityValue === undefined ? {} : { priority: Number(priorityValue) }),
    });
  }

  render(width: number, height: number, busy: boolean, notice: string): readonly string[] {
    const theme = this.theme;
    const heading = theme.bold(statusLine(`Edit bead · ${this.before.bead.id}`));
    const tabs = labels
      .map((label, index) => (index === this.selection ? theme.selected(` ${label} `) : ` ${label} `))
      .join(" ");
    const footer = wrapTextWithAnsi(
      theme.muted(busy ? "Waiting for Beads…" : "Ctrl+S save · Esc cancel · Tab next field · Enter new line"),
      width,
    );
    const editor = this.editors[this.selection];
    const panel =
      editor === undefined
        ? []
        : (() => {
            editor.focused = !busy;
            return editor.render(width);
          })();
    const available = Math.max(1, height - footer.length - 4);
    const cursor = panel.findIndex((line) => line.includes(CURSOR_MARKER));
    const start = Math.max(0, cursor - available + 1);
    const content = panel.slice(start, start + available);
    return [
      truncateToWidth(heading, width),
      truncateToWidth(tabs, width),
      theme.accent(this.selection === 3 ? "Priority · P0 to P4" : (labels[this.selection] ?? "")),
      ...content,
      ...Array<string>(available - content.length).fill(""),
      truncateToWidth(notice, width),
      ...footer,
    ].slice(0, height);
  }
}
