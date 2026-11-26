"""Exercise the live worker roster against owned fixture receipts in an approved lead."""
import json
from pathlib import Path
import subprocess

question = "If the selected bead disappears on refresh, should focus move to its parent?"
draft = "Keep the graph visible while I inspect the worker."
worker_prompt = "Walk me through the focus change before I answer the worker."
worker_reply = """The lead keeps your draft and cursor while you inspect an assignment. You can return to the same sentence after answering the worker.

### Graph navigation

`worker-restore` keeps the selected bead in place when the task list refreshes. The open question is what to select if that bead disappears.

The parent preserves the workstream. When the parent is gone too, the first remaining bead gives the worker a deterministic fallback.

Answering resumes the same assignment. The reviewer can then check that the agreed fallback works on the updated graph.

The resize and draft-preservation assignments can continue independently while you decide."""


def check_worker_sidebar(terminal_type, project, env, output, authority, served_beads, ready_draft):
    root = Path(__file__).resolve().parents[1]
    source = """
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { Discoveries } from './discovery/store.ts';
import { draftSchema, planDigest } from './lead-plan.ts';
import { runtimeProjectSchema } from './config.ts';
import { coverageToken } from './socrates/assessment.ts';
import { ExecutionStore, executionSchema } from './execution/store.ts';
const [project, sourceJson, question, draftJson] = process.argv.slice(1);
const authority = JSON.parse(sourceJson);
const session = SessionManager.create(project);
const discoveries = new Discoveries();
const runtime = new ExecutionStore();
const record = discoveries.create(project, session.getSessionId(), 'Lead focus and graph navigation');
const titles = {
  base: 'Record the graph selection',
  restore: 'Restore the selected graph node',
  resize: 'Keep the graph visible on resize',
  review: 'Preserve the draft when focus changes',
  keys: 'Document graph navigation keys',
  focus: 'Capture the focused bead',
  empty: 'Explain an empty selection',
  search: 'Find a bead by title',
  edges: 'Describe linked dependencies',
  filter: 'Filter finished assignments',
  resume: 'Resume the selected assignment',
  audit: 'Verify navigation after reload',
};
const parents = {empty:'restore', search:'focus', edges:'search', filter:'edges', resume:'review', audit:'resume'};
const closed = new Set(['base', 'keys', 'focus']);
const phases = {restore:'awaiting-decision',resize:'running',review:'reviewing'};
const tasks = Object.entries(titles).map(([key,title]) => ({
  key,title, description:title, acceptance: 'Keep the lead usable through refresh.',
  blockedBy: key === 'base' ? [] : [parents[key] ?? 'base'], owns:[key+'.ts'], requirements:['R1'],
}));
const graph = draftSchema.parse({summary:'Preserve the lead draft across graph navigation.', tasks});
const target = runtimeProjectSchema.parse({root:project, source:authority, profile:'personal', base:'main', beadsWorkspace:project, beadsDatabase:'fixture'});
const linked = discoveries.change(record.id, row => {
  row.specification = {status:'frozen',version:1,acceptedRevision:row.revision,draft:JSON.parse(draftJson)};
  row.specification.coverageRevision = coverageToken(row.specification);
  row.leadPlan.draft = graph;
  row.approved = planDigest(graph);
  row.graph = Object.fromEntries(tasks.map(task => [task.key, 'worker-'+task.key]));
  row.graph.root = 'worker-root';
  row.handoff = {operation:crypto.randomUUID(), revision:row.revision, digest:row.approved, phase:'complete',target:{...target,id:authority.projectId}};
});
const beads = {};
for (const task of tasks) {
  const id = crypto.randomUUID();
  const phase = phases[task.key];
  const status = phase ? 'in_progress' : closed.has(task.key) ? 'closed' : 'open';
  const bead = {id:linked.graph[task.key],title:task.title,status,
    assignee:phase?'pi:'+id:'', revision:'fixture-revision', acceptance_criteria:task.acceptance,
    metadata:{'studio.graph':linked.revision,'studio.approval':linked.approved,'studio.task':task}};
  beads[bead.id] = bead;
  if(!phase) continue;
  const launchToken = crypto.randomUUID();
  runtime.saveAttempt(executionSchema.parse({id,project:authority.projectId,bead,revision:bead.revision,profile:'personal',
    phase,launchToken, launchSettled:task.key==='restore', message:'',
    operatorDecisions:task.key==='restore'?[{id:crypto.randomUUID(),at:new Date().toISOString(),question,
      binding:{project:authority.projectId,bead:bead.id,revision:bead.revision,launchToken,contract:'a'.repeat(64)}}]:undefined}));
}
session.appendMessage({role:'user',content:'Keep the lead usable while workers implement graph navigation.',timestamp:Date.now()});
session.appendMessage({role:'assistant',content:[{type:'text',text:'The approved graph has twelve beads. Three are finished, and three workers are on their current assignments.\\n\\nThe implementation graph shows their dependencies. Each worker below it is linked to the bead it owns.'}],
  api:'openai-completions',provider:'fixture',model:'tiny',stopReason:'stop',timestamp:Date.now(),
  usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
session.appendCustomEntry('studio:discovery',{id:linked.id,project});
console.log(JSON.stringify({beads,target,session:session.getSessionFile()}));
runtime.close();
discoveries.close();
"""
    result = subprocess.run(
        ["bun", "--no-env-file", "-e", source, str(project), json.dumps(authority), question, json.dumps(ready_draft)],
        cwd=root, env=env, text=True, capture_output=True, timeout=30,
    )
    if result.returncode:
        raise AssertionError(result.stderr)
    fixture = json.loads(result.stdout)
    served_beads.update(fixture["beads"])
    config = project.parent / "worker-config.json"
    config.write_text(json.dumps({
        "runtime": {"enabled": False, "projects": [fixture["target"]]},
        "keybindings": {
            "lead": {"openPicker": "ctrl+;", "openWorkers": "ctrl+,"},
            "picker": {"workers": "x", "tasks": []},
        },
    }))
    console = terminal_type(project, {**env, "STUDIO_CONFIG": str(config)}, output, fixture["session"])
    try:
        def roster():
            return console.rail_text().partition("Workers")[2]

        console.wait(lambda: all(label in roster() for label in ("Needs input", "Implementing", "Reviewing")),
                     "Current workers and reviewer did not appear below the graph")
        rail_lines = console.rail_text().splitlines()
        start = next(i for i, line in enumerate(rail_lines) if line.startswith("Beads  "))
        cells = [rail_lines[start].removeprefix("Beads").strip(), rail_lines[start + 1].strip()]
        assert [len(row) for row in cells] == [10, 2], cells
        assert sorted("".join(cells)) == sorted("●" * 3 + "◐" * 3 + "○" * 6), cells
        graph = console.rail_text().partition("Implementation")[2].partition("Workers")[0]
        for title in ("Restore the selected graph node", "Keep the graph visible on resize"):
            assert any("◐" in line and line.rstrip().endswith(title) for line in graph.splitlines()), graph
        assert question in " ".join(roster().split()), roster()
        assert "2 active · 1 needs you" in roster(), roster()
        console.send(worker_prompt + "\r")
        console.wait(lambda: "while you decide." in console.text(), "The lead did not finish its reply")
        # The retired per-pane Alt shortcuts must leave the lead and its rail alone.
        for retired in ("\x1bw", "\x1bt", "\x1bs"):
            console.send(retired)
            assert console.rail_start() is not None and "Enter inspect" not in console.text(), console.text()
        console.send("\x15")
        console.send(draft)
        console.contains(draft)

        def passive_roster():
            rail = console.rail_text()
            assert "› " not in rail and "Enter inspect" not in rail and "Space fold" not in rail, rail
            return rail

        def open_picker():
            console.send("\x1b[59;5u")  # Ctrl+;
            console.contains("Studio panes")

        def open_workers():
            open_picker()
            console.send("x")
            check_worker_pane()

        def check_worker_pane():
            console.contains("Enter inspect")
            # The active selection is inside a pane laid over the middle of the lead.
            # Neither the bottom dock nor the right sidebar can satisfy these bounds.
            console.wait(lambda: any("› " in line[:console.screen.columns // 2]
                                     for line in console.screen.display[1:-1]),
                         "The worker picker did not open over the lead")
            console.framed_pane("Workers")

        def check_question_preview():
            top, bottom, left, right = console.framed_pane("Workers")
            lines = [line[left + 1:right] for line in console.screen.display[top + 1:bottom]]
            # The wide view has a list next to the preview. On narrow terminals
            # the preview starts underneath the three current assignments.
            preview = " ".join(" ".join(line.rsplit("│", 1)[-1].split()) for line in lines)
            assert question in " ".join(preview.split()), preview

        def select_first():
            for _ in range(3):
                console.send("k")
            console.contains("worker-restore")

        def dismiss_workers():
            console.send("\x1b")
            console.wait(lambda: "Enter inspect" not in console.text(),
                         "Escape did not close the worker pane")
            console.contains(draft)

        before = passive_roster()
        console.assert_styled_text("Graph navigation", fg="mdHeading", bold=True)
        console.assert_styled_text("worker-restore", fg="mdCode")
        console.assert_styled_text("Needs input", fg="status.warning", bg="surface.raised")
        console.assert_styled_text("Reviewing", fg="focus", bg="surface.raised")
        console.assert_styled_text("●", fg="status.success", bg="surface.raised")
        assert "at processTicksAndRejections" not in console.text(), console.text()
        console.capture("worker-sidebar")

        # Place the cursor before the period. Moving the pane selection and
        # dismissing the pane must preserve both the draft and its insertion point.
        console.send("\x1b[D")
        open_picker()
        top, bottom, left, right = console.framed_pane("Studio panes")
        labels = [line[left + 1:right].strip().lstrip("→› ").strip()
                  for line in console.screen.display[top + 1:bottom]]
        assert [" ".join(label.split()) for label in labels] == ["x Workers", "Tasks", "s Toggle status"], labels
        assert "Esc close" in console.screen.display[bottom], console.screen.display[bottom]
        for previous_key in ("w", "t"):
            console.send(previous_key)
            console.contains("Studio panes")
        console.capture("studio-pane-picker")
        console.send("\x1b")
        console.wait(lambda: "Studio panes" not in console.text(), "Escape did not dismiss the picker")
        console.send("?")
        console.contains(draft[:-1] + "?.")
        console.send("\x7f")
        console.send("\x1b[44;5u")  # Configured direct Workers shortcut, Ctrl+,
        check_worker_pane()
        console.contains("worker-restore")
        check_question_preview()
        console.capture("worker-float")
        console.send("\x1bw")
        console.framed_pane("Workers")
        top, bottom, left, right = console.framed_pane("Workers")
        transcript_before = console.screen.display[:top] + console.screen.display[bottom + 1:]
        console.send(f"\x1b[<64;{(left + right) // 2 + 1};{(top + bottom) // 2 + 1}M")
        assert transcript_before == console.screen.display[:top] + console.screen.display[bottom + 1:], console.text()
        console.send("j")
        console.contains("worker-resize")
        dismiss_workers()
        assert before == passive_roster(), console.rail_text()
        console.send("!")
        console.contains(draft[:-1] + "!.")
        console.send("\x7f")
        console.contains(draft)

        open_workers()
        select_first()
        console.send("j")
        console.contains("worker-resize")
        console.send("\r")
        console.contains("Brief & acceptance")
        console.inspector_contains("Keep the graph visible on resize")
        console.centered_inspector("Tasks ·")
        console.capture("worker-task")
        console.send("\x1b")
        console.wait(lambda: "Brief & acceptance" not in console.text(),
                     "Escape did not leave the task inspector")
        console.contains(draft)
        assert before == passive_roster(), console.rail_text()

        console.resize(60, 24)
        console.contains("1 needs you")
        console.contains(draft)
        assert "Enter inspect" not in console.text(), console.text()
        bead_line = next(line.strip() for line in console.screen.display if line.strip().startswith("Beads  "))
        assert bead_line.endswith(" +2"), bead_line
        console.contains(question[:42])
        console.capture("worker-dock")
        open_workers()
        select_first()
        check_question_preview()
        console.capture("worker-float")
        dismiss_workers()

        console.resize(128, 34)
        console.wait_for_rail()
        open_workers()
        select_first()
        console.send("j")
        console.contains("worker-resize")
        # Current Beads ownership may change while the operator is inspecting
        # an assignment. Enter must never target a replacement implicitly.
        served_beads["worker-resize"]["assignee"] = "pi:replacement"
        console.wait(lambda: "Assignment changed" in console.text(),
                     "The worker pane retained a stale Beads assignment", timeout=12)
        console.send("\r")
        console.send("\x1b[C")
        assert "Assignment changed" in console.text() and "Brief & acceptance" not in console.text(), console.text()
        console.send("j")
        console.wait(lambda: "Assignment changed" not in console.text() and "Enter inspect" in console.text(),
                     "An explicit move did not select a current assignment")
        dismiss_workers()
        console.wait(lambda: "Implementing" not in roster() and "1 active" in roster(),
                     "The status panel retained a stale worker count")
        passive_roster()
        console.send("\x1b[C")
        console.send(" Still here.")
        console.contains(draft + " Still here.")
        console.send("\x1b[D")

        open_workers()
        select_first()
        console.send("\r")
        console.contains("Brief & acceptance")
        console.resize(100, 32)
        for _ in range(16):
            console.send("\t")
            if "› ↗ Answer operator decision" in console.text():
                break
        console.contains("› ↗ Answer operator decision")
        console.assert_styled_text("› ↗ Answer operator decision", bg="selection.bg")
        console.assert_styled_text("Brief & acceptance", bg="surface.raised")
        console.capture("operator-question")
        console.resize(128, 34)
        console.contains("› ↗ Answer operator decision")
        console.capture("operator-question")
        console.resize(60, 32)
        console.contains("› ↗ Answer operator decision")
        console.capture("operator-question")
        console.send("\r")
        console.contains("Esc cancel")

        preserved_draft = draft + " Still here."
        first = "Use the parent when it is still visible."
        second = "Otherwise select the first remaining bead."
        console.send(first)
        console.send("\x1b[13;2u")
        console.send(second)
        for width, height in ((60, 32), (100, 32), (128, 34)):
            if console.screen.columns != width:
                console.resize(width, height)
            console.contains(second)
            top, bottom = console.answer_drawer(question, preserved_draft)
            console.assert_styled_text("Restore the selected graph node", bg="surface.raised", lines=[top])
            console.assert_styled_text("›", fg="accent", bg="surface.raised", lines=range(top, bottom))
            console.assert_styled_text(first, bg="surface.raised", lines=range(top, bottom))
            console.assert_styled_text(second, bg="surface.raised", lines=range(top, bottom))
            # Pi draws its active editor cursor as an inverse-video cell.
            reply_row = next(y for y in range(top, bottom) if second in console.screen.display[y])
            cursor_col = console.screen.display[reply_row].index(second) + len(second)
            assert console.screen.buffer[reply_row][cursor_col].reverse, console.text()
            lead_width = console.rail_start() or console.screen.columns
            assert not any(console.screen.buffer[y][x].reverse
                           for y in range(bottom + 1, console.screen.lines - 1) for x in range(lead_width)), console.text()
            console.capture("worker-answer-drawer")
        # Clicking the lead and then the reply transfers editing to the selected position.
        lead_row = next(y for y in range(bottom, console.screen.lines) if draft in console.screen.display[y])
        def click(x, y):
            console.send(f"\x1b[<0;{x + 1};{y + 1}M\x1b[<0;{x + 1};{y + 1}m")
        click(console.screen.display[lead_row].index(preserved_draft) + len(preserved_draft) - 1, lead_row)
        click(console.screen.display[reply_row].index("select"), reply_row)
        console.send("X")
        console.contains(second.replace("select", "Xselect"))
        console.send("\x1b")
        console.contains("Answer cancelled")
        console.contains("Brief & acceptance")
        console.send("\x1b")
        console.wait(lambda: "Brief & acceptance" not in console.text(), "Escape did not return to the lead")
        console.contains(preserved_draft)
        console.send("!")
        console.contains(preserved_draft[:-1] + "!.")
        console.send("\x1b[C")  # Advance past the preserved period before clearing the draft.
        console.contains("1 needs you")

        console.resize(128, 34)
        console.wait_for_rail()
        console.send("\x15")
        console.send("/socrates-status min\r")
        console.wait(lambda: console.rail_start() is None, "The status command did not hide the status column")
        console.send("/workers\r")
        console.contains("Enter inspect")
        console.framed_pane("Workers")
        console.send("\x1b")
        console.wait(lambda: "Enter inspect" not in console.text(), "Escape did not close the command-opened pane")
        console.send("Back in the lead.")
        console.contains("Back in the lead.")
        assert console.rail_start() is None, console.text()

        # Reload in the same lead. The previous globals must be released and the
        # new picker mnemonic must take effect on the first key after reload.
        updated = json.loads(config.read_text())
        updated["keybindings"]["lead"] = {"openPicker": "ctrl+.", "openWorkers": []}
        updated["keybindings"]["picker"]["workers"] = "v"
        config.write_text(json.dumps(updated))
        offset = len(console.raw)
        console.send("\x15/reload\r")
        console.wait(lambda: b"Reloaded keybindings" in console.raw[offset:], "Pi did not finish reloading", timeout=15)
        for previous_shortcut in ("\x1b[59;5u", "\x1b[44;5u"):
            console.send(previous_shortcut)
            assert "Studio panes" not in console.text() and "Enter inspect" not in console.text(), console.text()
        console.send("\x1b[46;5u")
        console.contains("Studio panes")
        console.contains("v Workers")
        console.send("x")
        console.contains("Studio panes")
        console.send("v")
        check_worker_pane()
    finally:
        console.close()
