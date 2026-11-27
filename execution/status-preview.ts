import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import { selectorText, type StatusMark, type StatusTheme, type StatusTone } from "@lanej/pi-components";
import { basename } from "node:path";
import { knownTaskStatus, TaskStatus } from "../beads.ts";
import { changeRuntimeBead, inspectRuntimeBead, type BeadAction, type RuntimeBead } from "./status-beads.ts";
import { statusLine } from "./status.ts";
import { RuntimeBeadEditor } from "./status-edit.ts";
import { pendingDecision, VerificationPhase, type Execution } from "./store.ts";

const tabs = ["Task", "Execution", "Evidence"] as const;
const controls = [
  { kind: "edit", key: "e", label: "Edit" },
  { kind: "close", key: "c", label: "Close" },
  { kind: "delete", key: "d", label: "Delete" },
] as const;
const summary = (value: string | undefined) => {
  const text = value?.trim() ?? "";
  return text === "" ? "Unavailable" : text;
};
type Field = readonly [string, string | number | undefined];
export interface RuntimeStatusStyle extends StatusTheme {
  info: (text: string) => string;
  attention: (text: string) => string;
  off: (text: string) => string;
  priority: (text: string) => string;
}
type CategoryTone = StatusTone | "info" | "attention" | "off" | "priority";
type Category = readonly [text: string, tone: CategoryTone];
type StatusRow = readonly [
  dimension: string,
  state: string,
  tone: CategoryTone,
  evidence?: string | readonly Category[] | undefined,
];

const priorityTones: readonly CategoryTone[] = ["error", "warning", "priority", "muted", "off"];
type Section =
  | { title: string; body: readonly string[] }
  | { title: string; fields: readonly Field[] }
  | { title: string; matrix: readonly StatusRow[] };

function fields(title: string, values: readonly Field[]): Section {
  return { title, fields: values.filter(([, value]) => value !== undefined && value !== "") };
}

function verificationRow(attempt: Execution): StatusRow {
  const verification = attempt.verification;
  const command = (verification?.check ?? attempt.check).join(" ");
  if (verification?.exitCode === 0) return ["Verification", "Passed", "success", "Exit 0"];
  if (verification?.exitCode !== undefined && verification.exitCode !== null)
    return ["Verification", "Failed", "error", `Exit ${String(verification.exitCode)}`];
  if (verification !== undefined && verification.check.length === 0)
    return ["Verification", "No executable", "muted", "Independent criteria review"];
  if (attempt.verifier?.phase === VerificationPhase.Running) return ["Verification", "Running", "accent", command];
  if (attempt.verifier?.phase === VerificationPhase.Launching) return ["Verification", "Launching", "accent", command];
  return ["Verification", "No result", "muted", command];
}

function renderSection(section: Section, width: number, theme: RuntimeStatusStyle): string[] {
  const paint = (tone: CategoryTone) => theme[tone] ?? theme.accent;
  const wrap = (value: string, columns: number) =>
    wrapTextWithAnsi(selectorText(value).replaceAll("\t", "  "), columns);
  let lines: string[];
  if ("body" in section) {
    lines = section.body.flatMap((line) => wrap(line, width));
  } else {
    const labels =
      "matrix" in section ? section.matrix.map(([label]) => label) : section.fields.map(([label]) => label);
    const labelWidth = Math.min(Math.floor(width * 0.35), Math.max(9, ...labels.map(visibleWidth)));
    const valueWidth = width - labelWidth - 3;
    const cell = (value: string, columns: number) => {
      const text = truncateToWidth(value, columns);
      return text + " ".repeat(Math.max(0, columns - visibleWidth(text)));
    };
    const divider = theme.muted(" │ ");
    const row = (label: string, value: string) => theme.muted(cell(label, labelWidth)) + divider + value;
    if ("matrix" in section) {
      const evidenceColumn = width >= 64;
      const stateWidth = evidenceColumn ? Math.min(24, Math.floor(valueWidth * 0.45)) : valueWidth;
      lines = [
        row(
          "Dimension",
          evidenceColumn
            ? theme.muted(cell("State", stateWidth)) + divider + theme.muted("Evidence")
            : theme.muted("State / evidence"),
        ),
        ...section.matrix.flatMap(([label, state, tone, evidence]) => {
          const stateLines = wrap(state, stateWidth).map(paint(tone));
          const evidenceText =
            typeof evidence === "string"
              ? theme.muted(selectorText(evidence))
              : evidence?.map(([value, color]) => paint(color)(statusLine(value))).join(theme.muted(" · "));
          const evidenceLines =
            evidenceText === undefined || visibleWidth(evidenceText) === 0
              ? []
              : wrapTextWithAnsi(evidenceText, evidenceColumn ? valueWidth - stateWidth - 3 : valueWidth);
          if (!evidenceColumn) {
            const stateText = stateLines[0] ?? "";
            const detail = evidenceLines[0];
            if (
              stateLines.length === 1 &&
              evidenceLines.length === 1 &&
              detail !== undefined &&
              visibleWidth(stateText) + visibleWidth(detail) + 3 <= valueWidth
            )
              return [row(label, stateText + theme.muted(" · ") + detail)];
            return [...stateLines, ...evidenceLines].map((value, index) => row(index === 0 ? label : "", value));
          }
          return Array.from({ length: Math.max(stateLines.length, evidenceLines.length) }, (_, index) =>
            row(
              index === 0 ? label : "",
              cell(stateLines[index] ?? "", stateWidth) + divider + (evidenceLines[index] ?? ""),
            ),
          );
        }),
      ];
    } else {
      lines = section.fields.flatMap(([label, value]) =>
        wrap(String(value), valueWidth).map((line, index) => row(index === 0 ? label : "", line)),
      );
    }
  }
  return lines.length === 0 ? [] : [theme.accent(theme.bold(section.title)), ...lines, ""];
}

type BeadView =
  | { kind: "loading" }
  | { kind: "ready"; value: RuntimeBead }
  | { kind: "unavailable"; message: string }
  | { kind: "deleted" };

interface Confirmation {
  kind: Exclude<BeadAction["kind"], "edit">;
  before: RuntimeBead;
  input: Input;
}

export class RuntimeTaskPreview {
  private tab = 0;
  private offset = 0;
  private page = 1;
  private maximum = 0;
  private live: BeadView = { kind: "loading" };
  private form: Confirmation | undefined;
  private edit: RuntimeBeadEditor | undefined;
  private busy = false;
  private notice: { kind: "success" | "error"; text: string } | undefined;

  constructor(
    private attempt: Execution,
    private readonly projectRoot: string | undefined,
    private readonly phaseMark: (attempt: Execution) => StatusMark,
    private readonly theme: RuntimeStatusStyle,
    private readonly tui: TUI,
    private readonly redraw: () => void,
    private readonly back: () => void,
  ) {
    this.reload();
  }

  update(attempt: Execution): void {
    this.attempt = attempt;
  }

  private projectLabel(): string {
    if (this.projectRoot === undefined) return this.attempt.project;
    return this.projectRoot === "/" ? "/" : basename(this.projectRoot);
  }

  private reload(): void {
    const id = this.attempt.bead?.id;
    if (id === undefined) {
      this.live = { kind: "unavailable", message: "This attempt has no claimed bead" };
      return;
    }
    if (this.busy || this.live.kind === "deleted") return;
    this.busy = true;
    this.live = { kind: "loading" };
    void inspectRuntimeBead({ project: this.attempt.project, id })
      .then(
        (value) => {
          this.live = { kind: "ready", value };
        },
        (cause: unknown) => {
          this.live = {
            kind: "unavailable",
            message: statusLine(cause instanceof Error ? cause.message : String(cause)),
          };
        },
      )
      .finally(() => {
        this.busy = false;
        this.redraw();
      })
      .catch((cause: unknown) => {
        this.notice = { kind: "error", text: statusLine(String(cause)) };
      });
    this.redraw();
  }

  private begin(kind: BeadAction["kind"]): void {
    if (this.live.kind !== "ready" || this.busy) return;
    const before = this.live.value;
    if (before.blocked !== undefined || (kind === "close" && knownTaskStatus(before.bead.status) === TaskStatus.Closed))
      return;
    this.notice = undefined;
    if (kind === "edit") {
      this.edit = new RuntimeBeadEditor(before, this.theme, this.tui);
      return;
    }
    const input = new Input({ prompt: kind === "close" ? "Reason › " : "Bead ID › " });
    input.focused = true;
    this.form = { kind, before, input };
  }

  private submit(form: Confirmation): void {
    const value = form.input.getValue();
    if (form.kind === "delete" && value !== form.before.bead.id) {
      this.notice = { kind: "error", text: "Enter the exact bead ID to confirm deletion" };
      return;
    }
    if (form.kind === "close" && value.trim() === "") {
      this.notice = { kind: "error", text: "Enter a reason to close this bead" };
      return;
    }
    const action: BeadAction = form.kind === "close" ? { kind: "close", reason: value.trim() } : { kind: "delete" };
    this.perform(form.before, action);
  }

  private saveEdit(editor: RuntimeBeadEditor): void {
    try {
      const patch = editor.patch();
      if (Object.keys(patch).length === 0) {
        this.edit = undefined;
        this.notice = { kind: "success", text: "No changes to save" };
        return;
      }
      this.perform(editor.before, { kind: "edit", patch });
    } catch (cause) {
      this.notice = { kind: "error", text: statusLine(cause instanceof Error ? cause.message : String(cause)) };
    }
  }

  private perform(before: RuntimeBead, action: BeadAction): void {
    this.busy = true;
    this.notice = undefined;
    void changeRuntimeBead(before, action)
      .then(
        (bead) => {
          this.live = bead === undefined ? { kind: "deleted" } : { kind: "ready", value: { ...before, bead } };
          this.notice = {
            kind: "success",
            text: `${before.bead.id} ${action.kind === "edit" ? "updated" : action.kind === "close" ? "closed" : "deleted"} in Beads`,
          };
          this.form = undefined;
          this.edit = undefined;
          this.tab = 0;
          this.offset = 0;
        },
        (cause: unknown) => {
          this.notice = { kind: "error", text: statusLine(cause instanceof Error ? cause.message : String(cause)) };
          this.live = { kind: "unavailable", message: "Reload the current Beads record to review available actions" };
          this.form = undefined;
        },
      )
      .finally(() => {
        this.busy = false;
        this.redraw();
      })
      .catch((cause: unknown) => {
        this.notice = { kind: "error", text: statusLine(String(cause)) };
      });
  }

  handleInput(input: string): void {
    if (this.edit !== undefined) {
      if (this.busy) return;
      if (matchesKey(input, "escape")) {
        this.edit = undefined;
        this.notice = undefined;
      } else if (matchesKey(input, "ctrl+s")) this.saveEdit(this.edit);
      else this.edit.handleInput(input);
      this.redraw();
      return;
    }
    const control = controls.find(({ key }) => matchesKey(input, key));
    if (this.form !== undefined) {
      if (this.busy) return;
      if (matchesKey(input, "escape")) {
        this.form = undefined;
        this.notice = undefined;
      } else if (matchesKey(input, "enter")) this.submit(this.form);
      else this.form.input.handleInput(input);
    } else if (matchesKey(input, "escape")) this.back();
    else if (matchesKey(input, "r")) {
      this.notice = undefined;
      this.reload();
    } else if (control !== undefined) this.begin(control.kind);
    else if (matchesKey(input, "tab") || matchesKey(input, "shift+tab")) {
      this.tab = (this.tab + (matchesKey(input, "tab") ? 1 : tabs.length - 1)) % tabs.length;
      this.offset = 0;
    } else if (matchesKey(input, "home")) this.offset = 0;
    else if (matchesKey(input, "end")) this.offset = this.maximum;
    else if (matchesKey(input, "down") || matchesKey(input, "j")) this.offset += 1;
    else if (matchesKey(input, "up") || matchesKey(input, "k")) this.offset -= 1;
    else if (matchesKey(input, "pageDown")) this.offset += this.page;
    else if (matchesKey(input, "pageUp")) this.offset -= this.page;
    this.redraw();
  }

  private sections(): Section[] {
    const attempt = this.attempt;
    const decision = pendingDecision(attempt);
    const current = this.live.kind === "ready" ? this.live.value.bead : undefined;
    const bead = current ?? attempt.bead;
    const closeReason = current?.["close_reason"];
    const phase = this.phaseMark(attempt);
    if (this.tab === 0) {
      const beadStatus = current === undefined ? undefined : knownTaskStatus(current.status);
      const issueType = current?.["issue_type"];
      const priority = current?.["priority"];
      const classification: Category[] = [["Live record", "info"]];
      if (typeof issueType === "string" && issueType !== "") classification.push([issueType, "accent"]);
      if (typeof priority === "number") {
        const tone = priorityTones[priority];
        if (tone !== undefined) classification.push([`P${String(priority)}`, tone]);
      }
      const beadRow: StatusRow =
        this.live.kind === "ready"
          ? [
              "Beads",
              (current?.status ?? "").replace(/(^.|_.)/gu, (part) => part.replace("_", " ").toUpperCase()),
              beadStatus === TaskStatus.Closed ? "success" : beadStatus === TaskStatus.Blocked ? "warning" : "accent",
              classification,
            ]
          : this.live.kind === "deleted"
            ? ["Beads", "Deleted", "muted", "Retained brief below"]
            : this.live.kind === "loading"
              ? ["Beads", "Loading", "info"]
              : ["Beads", "Unavailable", "warning", this.live.message];
      const actionBlock = this.live.kind === "ready" ? this.live.value.blocked : undefined;
      return [
        {
          title: "Status matrix",
          matrix: [
            beadRow,
            ["Execution", phase.label, phase.tone, "Retained attempt"],
            [
              "Assignment",
              current === undefined ? "Unobserved" : current.assignee === "" ? "Unassigned" : "Assigned",
              current === undefined ? "off" : current.assignee === "" ? "attention" : "info",
              current?.assignee,
            ],
            [
              "Decision",
              decision === undefined ? "None pending" : "Awaiting answer",
              decision === undefined ? "off" : "warning",
            ],
            [
              "Bead actions",
              current === undefined ? "Unavailable" : actionBlock !== undefined ? "Blocked" : "Available",
              actionBlock !== undefined ? "warning" : current === undefined ? "off" : "success",
              actionBlock ??
                (current === undefined
                  ? undefined
                  : beadStatus === TaskStatus.Closed
                    ? "Edit or delete"
                    : "Edit, close, delete"),
            ],
          ],
        },
        fields("Task identity", [
          ["Bead", bead?.id],
          ["Project", this.projectLabel()],
          ["Revision", current?.revision],
          ["Close reason", typeof closeReason === "string" ? closeReason : undefined],
        ]),
        ...(decision === undefined
          ? []
          : [
              fields("Operator decision", [
                ["Question", decision.question],
                ["Request ID", decision.id],
              ]),
            ]),
        { title: current === undefined ? "Retained brief" : "Description", body: [summary(bead?.description)] },
        { title: "Acceptance criteria", body: [summary(bead?.acceptance_criteria)] },
      ];
    }
    if (this.tab === 1)
      return [
        {
          title: "Execution matrix",
          matrix: [
            ["Phase", phase.label, phase.tone],
            [
              "Binding",
              attempt.interactive === undefined ? "No interactive tab" : "Interactive tab",
              "muted",
              attempt.interactive?.session,
            ],
            [
              "Host",
              attempt.pid === undefined ? "No PID recorded" : "PID recorded",
              "muted",
              attempt.pid === undefined ? undefined : String(attempt.pid),
            ],
            ["Checkout", attempt.checkout === undefined ? "Unrecorded" : "Recorded", "muted", attempt.checkout?.branch],
          ],
        },
        fields("Progress", [
          ["Status", attempt.message],
          ["Result", attempt.summary],
          ["Decision request", decision?.id],
          ["Recoveries", attempt.recoveries],
        ]),
        fields("Execution identity", [
          ["Attempt", attempt.id],
          ["Project ID", attempt.project],
          ["Project root", this.projectRoot],
          ["Profile", attempt.profile],
        ]),
        fields("Ownership", [
          ["Recorded host PID", attempt.pid],
          ["Host start", attempt.started],
          ["Interactive session", attempt.interactive?.session],
          ["Interactive tab", attempt.interactive?.tab],
          ["Worker pane", attempt.pane],
          ["Checkout", attempt.checkout?.path],
          ["Owned paths", attempt.owns.join(", ")],
        ]),
      ];
    const sessions = [
      ...new Set([attempt.workerSessionFile, attempt.controllerSessionFile, ...attempt.sessions]),
    ].filter((file) => file !== undefined);
    return [
      {
        title: "Evidence matrix",
        matrix: [
          verificationRow(attempt),
          [
            "Review",
            attempt.reviewFinding !== undefined
              ? "Finding recorded"
              : attempt.review !== undefined
                ? "Review recorded"
                : "Unrecorded",
            attempt.reviewFinding !== undefined ? "warning" : "muted",
          ],
          [
            "Publication",
            attempt.url !== undefined || attempt.pr !== undefined
              ? "PR recorded"
              : attempt.publication !== undefined
                ? "Receipt recorded"
                : "Unrecorded",
            "muted",
          ],
          [
            "Merge",
            attempt.merged !== undefined
              ? "Confirmed"
              : attempt.mergeReceipt !== undefined
                ? "Record retained"
                : "Unrecorded",
            attempt.merged !== undefined ? "success" : "muted",
          ],
        ],
      },
      fields("Verification", [
        ["Command", attempt.check.join(" ")],
        ["Summary", attempt.verification?.summary],
        ["Reason", attempt.verification?.reason],
      ]),
      fields("Review & delivery", [
        ["Finding", attempt.reviewFinding],
        ["Review", attempt.review],
        ["Pull request", attempt.url ?? attempt.pr],
        ["Reviewed head", attempt.readyNotice?.head],
        ["Retained head", attempt.head],
        ["Result ref", attempt.resultRef],
      ]),
      { title: "Retained sessions", body: sessions },
    ];
  }

  render(width: number, height: number): readonly string[] {
    const theme = this.theme;
    const notice =
      this.notice === undefined ? "" : (this.notice.kind === "success" ? theme.success : theme.error)(this.notice.text);
    if (this.edit !== undefined) return this.edit.render(width, height, this.busy, notice);
    if (this.form !== undefined) {
      const { kind, before, input } = this.form;
      const copy =
        kind === "close"
          ? "Record why this bead is being closed. Closing it can make dependents eligible."
          : "Permanently remove this bead, its Beads history, and its dependency links. Beads may rewrite references. The Studio attempt remains available.";
      const intro = [
        theme.bold(kind === "close" ? "Close bead" : "Delete bead"),
        ...wrapTextWithAnsi(statusLine(`${before.bead.id} · ${before.bead.title}`), width),
        ...wrapTextWithAnsi(statusLine(`Project  ${this.projectLabel()} (${before.target.project})`), width),
        ...wrapTextWithAnsi(copy, width),
      ];
      return [
        ...intro.slice(0, height - 4),
        "",
        ...(this.busy ? ["Waiting for Beads…"] : input.render(width)),
        notice,
        theme.muted(this.busy ? "Waiting for a confirmed outcome" : "Enter confirm · Esc cancel"),
      ]
        .slice(0, height)
        .map((line) => truncateToWidth(line, width));
    }
    const current = this.live.kind === "ready" ? this.live.value : undefined;
    const title = statusLine(current?.bead.title ?? this.attempt.bead?.title ?? "Unclaimed attempt");
    const beadId = this.attempt.bead?.id;
    const heading =
      beadId === undefined
        ? theme.bold(title)
        : `${theme.info(statusLine(beadId))}${theme.muted(" · ")}${theme.bold(title)}`;
    const buttons = controls.map(({ kind, key, label }) => {
      const enabled =
        current !== undefined &&
        current.blocked === undefined &&
        (kind !== "close" || knownTaskStatus(current.bead.status) !== TaskStatus.Closed);
      const button = `[${key}] ${label}`;
      return enabled ? (kind === "delete" ? theme.error(button) : theme.accent(button)) : theme.off(button);
    });
    const header = [
      heading,
      tabs.map((tab, index) => (index === this.tab ? theme.selected(` ${tab} `) : ` ${tab} `)).join(" "),
      ...wrapTextWithAnsi(buttons.join("  "), width),
      "",
    ];
    const body = this.sections().flatMap((section) => renderSection(section, width, theme));
    const hint = (scroll: string) =>
      wrapTextWithAnsi(theme.muted(`Esc back · Tab sections${scroll} · r reload`), width);
    const usable = height - header.length - 1;
    const baseHint = hint("");
    const footer = body.length > usable - baseHint.length ? hint(" · ↑↓ scroll") : baseHint;
    this.page = Math.max(1, usable - footer.length);
    this.maximum = Math.max(0, body.length - this.page);
    this.offset = Math.min(this.maximum, Math.max(0, this.offset));
    const displayed = body.slice(this.offset, this.offset + this.page);
    return [...header, ...displayed, ...Array<string>(this.page - displayed.length).fill(""), notice, ...footer]
      .slice(0, height)
      .map((line) => truncateToWidth(line, width));
  }
}
