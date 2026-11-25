import {
  getSelectListTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Editor,
  getKeybindings,
  matchesKey,
  Text,
  type TUI,
  type TuiMouseEvent,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { selectorText } from "@lanej/pi-components";
import {
  floatingPaneHeight,
  paintPaneLine,
  paneMouse,
} from "../floating-pane.ts";

export class DecisionEditor {
  readonly capturesViewportInput = true;
  private readonly editor: Editor;
  private readonly question: Text;
  private offset = 0;
  private questionHeight = 1;
  private maxOffset = 0;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Pick<Theme, "fg" | "bg" | "bold" | "getBgAnsi">,
    question: string,
    private readonly done: (answer: string | undefined) => void,
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
    const height = floatingPaneHeight(this.tui.terminal.rows);
    const inner = Math.max(1, width - 2);
    const editing = this.editor.render(inner);
    const prompt = this.question.render(inner);
    this.questionHeight = Math.max(1, height - editing.length - 5);
    this.maxOffset = Math.max(0, prompt.length - this.questionHeight);
    this.offset = Math.min(this.offset, this.maxOffset);
    const rows = [
      this.theme.fg("accent", this.theme.bold(" Answer operator decision")),
      ...prompt.slice(this.offset, this.offset + this.questionHeight),
      ...(this.maxOffset > 0
        ? [this.theme.fg("muted", " PgUp/PgDn scroll question")]
        : []),
      ...editing,
      this.theme.fg("muted", " Enter submit  Shift+Enter newline  Esc cancel"),
    ];
    // On very short terminals, keep the insertion point on screen as the answer wraps.
    const cursor = rows.findIndex((line) => line.includes(CURSOR_MARKER));
    const bodyHeight = Math.max(1, height - 2);
    const start = Math.max(0, cursor - bodyHeight + 1);
    const border = (line: string) => this.theme.fg("border", line);
    const body = rows.slice(start, start + bodyHeight).map((line) => {
      const bounded =
        visibleWidth(line) > inner ? truncateToWidth(line, inner) : line;
      return paintPaneLine(
        this.theme,
        "userMessageBg",
        width < 3
          ? bounded
          : border("│") +
              bounded +
              " ".repeat(Math.max(0, inner - visibleWidth(bounded))) +
              border("│"),
      );
    });
    if (height < 3 || width < 3) return body;
    return [
      border("╭" + "─".repeat(inner) + "╮"),
      ...body,
      border("╰" + "─".repeat(inner) + "╯"),
    ];
  }

  handleMouse(event: TuiMouseEvent) {
    return paneMouse(event, (delta) => {
      this.offset = Math.max(0, Math.min(this.maxOffset, this.offset + delta));
    });
  }

  handleInput(data: string): void {
    if (getKeybindings().matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }
    if (this.maxOffset > 0 && matchesKey(data, "pageUp"))
      this.offset = Math.max(0, this.offset - this.questionHeight);
    else if (this.maxOffset > 0 && matchesKey(data, "pageDown"))
      this.offset = Math.min(this.maxOffset, this.offset + this.questionHeight);
    else this.editor.handleInput(data);
    this.tui.requestRender();
  }
}
