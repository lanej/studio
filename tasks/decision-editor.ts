import {
  getSelectListTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Editor,
  getKeybindings,
  Text,
  type TUI,
  type TuiMouseEvent,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  defaultPaneKeybindings,
  matchesPaneKey,
  paneKeyHint,
  paneKeyPair,
} from "../pane-keybindings.ts";
import { selectorText } from "@lanej/pi-components";
import { paintPaneLine, paneMouse } from "../floating-pane.ts";

export class DecisionEditor {
  readonly capturesViewportInput = true;
  readonly hideInactiveCursors = true;
  private readonly editor: Editor;
  private readonly question: Text;
  private offset = 0;
  private questionHeight = 1;
  private maxOffset = 0;
  private replyArea = { top: 0, start: 0, rows: 0, prefix: 0 };

  constructor(
    private readonly tui: TUI,
    private readonly theme: Pick<Theme, "fg" | "bg" | "bold" | "getBgAnsi">,
    question: string,
    private readonly done: (answer: string | undefined) => void,
    private readonly bindings = defaultPaneKeybindings,
    private readonly taskTitle?: string,
  ) {
    this.question = new Text(
      selectorText(question).replace(/\p{Cc}/gu, " "),
      1,
      0,
    );
    this.editor = new Editor(
      tui,
      {
        borderColor: (line) => theme.fg("borderAccent", line),
        selectList: getSelectListTheme(),
      },
      { paddingX: 1 },
    );
    this.editor.onSubmit = done;
  }

  get focused(): boolean {
    return this.editor.focused;
  }
  set focused(value: boolean) {
    this.editor.focused = value;
  }

  invalidate(): void {
    this.question.invalidate();
    this.editor.invalidate();
  }

  render(width: number): string[] {
    if (width < 1) return [];
    const height = Math.max(
      1,
      Math.min(12, Math.floor(this.tui.terminal.rows / 3)),
    );
    const showHeading = height >= 3;
    const showHints = height >= 4;
    const contentHeight = height - Number(showHeading) - Number(showHints);
    const prefix = width >= 4 ? " ›" : "";
    const inner = width - prefix.length;
    // Use the editor's wrapped, cursor-aware rows inside the drawer's own surface.
    const editing = this.editor.render(inner).slice(1, -1);
    const prompt = this.question.render(width);
    this.questionHeight = Math.min(
      contentHeight - 1,
      Math.max(1, contentHeight - editing.length),
    );
    this.maxOffset = Math.max(0, prompt.length - this.questionHeight);
    this.offset = Math.min(this.offset, this.maxOffset);
    const visibleQuestion = prompt.slice(
      this.offset,
      this.offset + this.questionHeight,
    );
    const answerHeight = contentHeight - visibleQuestion.length;
    const cursor = editing.findIndex((line) => line.includes(CURSOR_MARKER));
    const start = Math.max(0, cursor - answerHeight + 1);
    const reply = editing.slice(start, start + answerHeight);
    this.replyArea = {
      top: Number(showHeading) + visibleQuestion.length,
      start,
      rows: reply.length,
      prefix: prefix.length,
    };
    const keys = getKeybindings();
    const submit = keys.getKeys("tui.input.submit");
    const newline = keys.getKeys("tui.input.newLine");
    const cancel = keys.getKeys("tui.select.cancel");
    const reserved = new Set([...submit, ...newline, ...cancel]);
    const scroll = paneKeyPair(
      this.bindings.decision.pageUp.filter((key) => !reserved.has(key)),
      this.bindings.decision.pageDown.filter((key) => !reserved.has(key)),
    );
    const instructions = [
      paneKeyHint(submit, "submit"),
      paneKeyHint(newline, "newline"),
      paneKeyHint(cancel, "cancel"),
    ]
      .filter(Boolean)
      .join("  ");
    const title =
      this.taskTitle === undefined
        ? ""
        : selectorText(this.taskTitle).replace(/\s+/gu, " ").trim();
    const questionScroll =
      this.maxOffset > 0 && scroll.length > 0
        ? this.theme.fg("muted", `  ${scroll} scroll question`)
        : "";
    const header =
      this.theme.fg("warning", this.theme.bold(" Worker question")) +
      questionScroll +
      (title.length === 0 ? "" : this.theme.fg("muted", `  ·  ${title}`));
    const rows = [
      ...(showHeading ? [header] : []),
      ...visibleQuestion.map((line) => this.theme.fg("text", line)),
      ...reply.map((line, index) => {
        // At one column Pi can render the end-of-line cursor just past the text.
        if (
          width === 1 &&
          line.includes(CURSOR_MARKER) &&
          visibleWidth(line) > 1
        )
          return line.slice(line.indexOf(CURSOR_MARKER));
        return (
          (index === 0
            ? this.theme.fg("accent", prefix)
            : " ".repeat(prefix.length)) + line
        );
      }),
      ...(showHints ? [this.theme.fg("muted", ` ${instructions}`)] : []),
    ];
    return rows.map((line) =>
      paintPaneLine(
        this.theme,
        "userMessageBg",
        visibleWidth(line) > width
          ? truncateToWidth(line, width, "…")
          : line + " ".repeat(width - visibleWidth(line)),
      ),
    );
  }

  handleMouse(event: TuiMouseEvent) {
    if (event.type === "click" && event.button === "left") {
      const row = event.y - this.replyArea.top;
      if (row >= 0 && row < this.replyArea.rows) {
        // Pi's editor includes its top border and may have more visible rows than the drawer.
        this.editor.handleMouse({
          ...event,
          x: event.x - this.replyArea.prefix,
          y: row + this.replyArea.start + 1,
          width: event.width - this.replyArea.prefix,
        });
      }
      return { handled: true, focus: true };
    }
    return paneMouse(event, (delta) => {
      this.offset = Math.max(0, Math.min(this.maxOffset, this.offset + delta));
    });
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    if (keys.matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }
    if (
      keys.matches(data, "tui.input.submit") ||
      keys.matches(data, "tui.input.newLine")
    )
      this.editor.handleInput(data);
    else if (
      this.maxOffset > 0 &&
      matchesPaneKey(data, this.bindings.decision.pageUp)
    )
      this.offset = Math.max(0, this.offset - this.questionHeight);
    else if (
      this.maxOffset > 0 &&
      matchesPaneKey(data, this.bindings.decision.pageDown)
    )
      this.offset = Math.min(this.maxOffset, this.offset + this.questionHeight);
    else this.editor.handleInput(data);
    this.tui.requestRender();
  }
}
