# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte", "pillow"]
# ///
"""Verify Socrates status and evidence through the native Pi terminal."""
import argparse
import codecs
import fcntl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import select
import signal
import sqlite3
import struct
import subprocess
import sys
import tempfile
import termios
from threading import Event, Thread
import time
import uuid

import pyte
from PIL import Image, ImageDraw, ImageFont


root = Path(__file__).resolve().parents[1]
palette = json.loads((root / "resources/colors.json").read_text())
request_started = Event()
release_response = Event()
provider_errors = []
received_requests = []
beads_project = str(uuid.uuid4())
linked_beads = {}
bead_reads = []


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        bead_reads.append(self.path)
        if self.headers.get('Bd-Project-Id') != beads_project:
            self.send_error(403)
            return
        if self.path == '/v0/beads/context':
            value = {'project_id': beads_project, 'backend': 'dolt', 'dolt_mode': 'server',
                     'capabilities': ['project.enforce', 'issues.get', 'issues.create', 'issues.update']}
        elif self.path.startswith('/v0/beads/issues/') and self.path.rsplit('/', 1)[1] in linked_beads:
            value = linked_beads[self.path.rsplit('/', 1)[1]]
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(value).encode())

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        received_requests.append(request)
        system = "\n".join(
            str(message.get("content", ""))
            for message in request["messages"]
            if message["role"] == "system"
        )
        user_messages = [str(m.get("content", "")) for m in request["messages"] if m["role"] == "user"]
        resumed_answer = any("recorded operator answer" in message for message in user_messages[-1:])
        if resumed_answer and "Harmony" not in system:
            provider_errors.append("Native lead did not load Socrates guidance")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        if resumed_answer:
            request_started.set()
            if not release_response.wait(20):
                provider_errors.append("Native response was not released")
        linked_review = any('progress of the linked work' in message for message in user_messages[-1:])
        reply = ("The answer is recorded; the draft is unchanged." if resumed_answer
                 else """The implementation view follows the linked Beads records.

Property evidence has been recorded. The dock work is in progress, and the next verification task is blocked.

The specification carries its own saved assessment. Closing an implementation task does not resolve a property automatically.

Open a task to inspect its requirement and dependency, or continue the conversation here.""" if linked_review
                 else """The frozen specification and the proposed breakdown describe two different things.

The specification records what needs to be true. Verification is partial: question and resume are covered, but a stale assessment still needs a native check. Harmony remains open until that decision is incorporated.

The breakdown describes two implementation tasks. First, record evidence for each property. Then build the dock so its keyboard shortcut preserves the editor draft.

Both tasks are proposed. A frozen specification does not authorize a worker to start.

You can inspect either column while the lead remains available.""")
        result = {
            "id": "socrates-status-fixture",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "tiny",
            "choices": [{
                "index": 0,
                "delta": {"role": "assistant", "content": reply},
                "finish_reason": "stop",
            }],
        }
        self.wfile.write(("data: " + json.dumps(result) + "\n\ndata: [DONE]\n\n").encode())


class Terminal:
    def __init__(self, project, env, output, session, columns=112, rows=32):
        self.output = output
        self.master, slave = os.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        self.process = subprocess.Popen(
            [str(root / "scripts/studio"), "lead", "--", "--offline", "--no-mcp", "--model", "fixture/tiny", "--session", session],
            env=env, cwd=project, stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
        )
        os.close(slave)
        self.screen = pyte.Screen(columns, rows)
        self.stream = pyte.Stream(self.screen)
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.raw = bytearray()

    def pump(self, seconds=0.05):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            if select.select([self.master], [], [], min(0.05, max(0, until - time.monotonic())))[0]:
                try:
                    chunk = os.read(self.master, 65536)
                    self.raw.extend(chunk)
                    self.stream.feed(self.decoder.decode(chunk))
                except OSError:
                    break

    def text(self):
        return "\n".join(self.screen.display)

    def wait(self, predicate, description, timeout=8):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            self.pump()
            if predicate():
                return
            if self.process.poll() is not None:
                break
        self.capture("failure")
        raise AssertionError(f"{description}\n{self.text()}")

    def contains(self, text):
        self.wait(lambda: text in " ".join(self.text().split()), f"Missing {text!r}")

    def send(self, text):
        os.write(self.master, text.encode())
        self.pump()

    def keys(self, keys):
        for key in keys:
            self.send(key)

    def select_row(self, label):
        """Move to the named entry in the focused column, including foldable headings."""
        def selected():
            return any("›" in line and label in line.split("›", 1)[1] for line in self.screen.display)
        if selected():
            return
        self.send("\x1b[H")
        for _ in range(40):
            if selected():
                return
            self.send("j")
        raise AssertionError(f"Could not focus {label!r}\n{self.text()}")

    def check_dock_height(self, maximum):
        lines = self.screen.display
        heading = next(y for y, line in enumerate(lines) if 'Specification' in line and 'Implementation' in line)
        editor = next(y for y in range(heading + 1, len(lines)) if lines[y].strip().startswith('──'))
        assert 1 <= editor - heading <= maximum, f"Dock used {editor - heading} rows instead of at most {maximum}\n{self.text()}"

    def assert_mark(self, label, mark, tone):
        for y, line in enumerate(self.screen.display):
            if label not in line:
                continue
            x = line.rfind(mark, 0, line.index(label))
            if x != -1 and self.screen.buffer[y][x].fg.upper() == palette["roles"][tone].lstrip("#"):
                return
        raise AssertionError(f"Missing {tone} {mark} before {label!r}\n{self.text()}")

    def resize(self, columns, rows):
        self.screen.resize(lines=rows, columns=columns)
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        os.killpg(self.process.pid, signal.SIGWINCH)
        self.pump(0.3)

    def capture(self, name):
        if self.output is None:
            return
        self.output.mkdir(parents=True, exist_ok=True)
        fonts = [
            "/System/Library/Fonts/Menlo.ttc",
            "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
            "/usr/share/fonts/truetype/liberation2/LiberationMono-Regular.ttf",
        ]
        font = next((ImageFont.truetype(path, 15) for path in fonts if Path(path).is_file()), ImageFont.load_default())
        braille_path = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
        braille = ImageFont.truetype(str(braille_path), 15) if braille_path.is_file() else font
        cell_width, cell_height = 10, 21
        # Retain the complete native console so both docks and explicitly opened overlays can be judged in context.
        first, last = 0, self.screen.lines
        image = Image.new("RGB", (self.screen.columns * cell_width, (last - first) * cell_height), palette["roles"]["surface"])
        draw = ImageDraw.Draw(image)
        ansi = ["black", "red", "green", "brown", "blue", "magenta", "cyan", "white"]

        def color(value, fallback):
            if value == "default":
                return palette["roles"][fallback]
            if value in ansi:
                return palette["ansi"][ansi.index(value)]
            return "#" + value if len(value) == 6 else palette["roles"][fallback]

        for y in range(first, last):
            for x in range(self.screen.columns):
                cell = self.screen.buffer[y][x]
                fg, bg = color(cell.fg, "text"), color(cell.bg, "surface")
                if cell.reverse:
                    fg, bg = bg, fg
                top = (y - first) * cell_height
                draw.rectangle((x * cell_width, top, (x + 1) * cell_width, top + cell_height), fill=bg)
                glyph_font = braille if len(cell.data) == 1 and "\u2800" <= cell.data <= "\u28ff" else font
                draw.text((x * cell_width, top), cell.data, font=glyph_font, fill=fg)
        image.save(self.output / f"{name}-{self.screen.columns}.png")
        (self.output / f"{name}-{self.screen.columns}.txt").write_text(self.text() + "\n")
        (self.output / f"{name}-{self.screen.columns}.ansi").write_bytes(self.raw)

    def close(self):
        try:
            os.killpg(self.process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait()
        os.close(self.master)


def seed(project, env, source_url):
    source = f"""
import {{ Discoveries }} from {json.dumps(str(root / 'discovery/store.ts'))};
import {{ SpecStatus }} from {json.dumps(str(root / 'socrates/spec.ts'))};
import {{ coverageToken }} from {json.dumps(str(root / 'socrates/assessment.ts'))};
import {{ draftSchema,planDigest }} from {json.dumps(str(root / 'lead-plan.ts'))};
import {{ runtimeProjectSchema }} from {json.dumps(str(root / 'config.ts'))};
import {{ SessionManager }} from '@earendil-works/pi-coding-agent';
const store = new Discoveries();
const draft = {{
  objective: 'Make specification readiness visible', scope: ['Socrates status and evidence'],
  requirements: [{{id:'R1', outcome:'Show property assessments', acceptance:'Inspect evidence while preserving question state'}}],
  decisions: [{{id:'D1', decision:'Choose the verification boundary', basis:'observed', evidence:'Operator request', disposition:'open', uncertainty:'Need the narrowest useful check'}}],
  blockingQuestions: [],
  coverage: {{domains:[], focus:'verification', assessments:[
    {{propertyId:'problem-first',status:'satisfied',reason:'The operator cannot see which properties remain unresolved.'}},
    {{propertyId:'clarity',status:'satisfied',reason:'Assessment and activity are separate observations.'}},
    {{propertyId:'verification',status:'partial',reason:'Question and resume are covered. A stale assessment still needs a native check.'}},
    {{propertyId:'harmony',status:'open',reason:'The verification decision still needs to be incorporated.'}}
  ]}}
}};
function create(title, next) {{
  const record=store.create({json.dumps(str(project))}, 'status-fixture', title);
  store.change(record.id,row=>{{
    const specification={{status:SpecStatus.Interrogating,version:1,acceptedRevision:row.revision,draft:next}};
    row.specification={{...specification,coverageRevision:coverageToken(specification)}};
  }});
  return record.id;
}}
const covered=create('Status inspection',draft);
const breakdown=draftSchema.parse({{summary:'Make progress visible without taking over the lead console.',tasks:[
  {{key:'assess',title:'Record property evidence',description:'Persist the rationale for each assessed property.',acceptance:'Old assessments remain inspectable after a revision.',requirements:['R1'],owns:['socrates/assessment.ts']}},
  {{key:'dock',title:'Keep the lead available',description:'Compose the two status columns above the editor.',acceptance:'Toggling the dock preserves the complete unsent prompt.',requirements:['R1'],blockedBy:['assess'],owns:['socrates/presentation.ts']}}
]}});
store.change(covered,row=>{{row.specification.status=SpecStatus.Frozen;row.specification.approvalAt='2026-11-24T00:00:00Z';row.leadPlan.draft=breakdown;}});
const question=create('Question in progress',{{...draft,blockingQuestions:['Which verification boundary should we use?']}});
store.change(question,row=>{{row.specification.exchange={{prompt:{{decisionId:'D1',question:'Which verification boundary should we use?',options:[{{label:'Focused native check',description:'Exercise the status UI'}},{{label:'Keep investigating',description:'Leave the boundary open'}}]}}}};}});
const {{coverage,...legacyDraft}}=draft;
const unknown=create('Unassessed discovery',legacyDraft);
const planOnly=store.create({json.dumps(str(project))},'status-fixture','Standalone work breakdown');
store.change(planOnly.id,row=>{{row.leadPlan.draft=breakdown;}});
const approved=create('Specification and linked work', draft);
const activeBreakdown=draftSchema.parse({{...breakdown,tasks:[...breakdown.tasks,{{key:'verify',title:'Verify the handoff',description:'Confirm the evidence at the live boundary.',acceptance:'The selected bead matches the reviewed work.',requirements:['R1'],blockedBy:['dock']}}]}});
const linked=store.change(approved,row=>{{
  row.specification.status=SpecStatus.Frozen; row.specification.approvalAt='2026-11-24T00:00:00Z';
  row.leadPlan.draft=activeBreakdown; row.approved=planDigest(activeBreakdown);
  row.graph=Object.fromEntries(activeBreakdown.tasks.map(task=>[task.key,'bd-'+task.key])); row.graph.root='bd-root';
  const target=runtimeProjectSchema.parse({{root:row.project,source:{{url:{json.dumps(source_url)},projectId:{json.dumps(beads_project)},reviewOnly:true}},profile:'personal',base:'main',beadsWorkspace:row.project,beadsDatabase:'fixture'}});
  row.handoff={{operation:crypto.randomUUID(),revision:row.revision,digest:row.approved,phase:'complete',target:{{...target,id:{json.dumps(beads_project)}}}}};
}});
const statuses={{assess:'closed',dock:'in_progress',verify:'blocked'}};
const beads=Object.fromEntries(activeBreakdown.tasks.map(task=>[linked.graph[task.key],{{id:linked.graph[task.key],title:task.title,status:statuses[task.key],revision:'read-only-fixture',metadata:{{'studio.graph':linked.revision,'studio.approval':linked.approved,'studio.task':task}}}}]));
function sessionFor(record) {{
 const manager=SessionManager.create({json.dumps(str(project))});
 manager.appendMessage({{role:'user',content:'Let me inspect this proposal while keeping our conversation open.',timestamp:Date.now()}});
 manager.appendCustomEntry('studio:discovery',{{id:record,project:{json.dumps(str(project))}}});
 return manager.getSessionFile();
}}
console.log(JSON.stringify({{covered,question,unknown,approved,beads,session:sessionFor(covered),planOnlySession:sessionFor(planOnly.id)}}));store.close();
"""
    result = subprocess.run(["bun", "--no-env-file", "-e", source], env=env, cwd=root, text=True, capture_output=True, check=True)
    return json.loads(result.stdout)


def run(output):
    with tempfile.TemporaryDirectory(prefix="studio-socrates-ui-") as directory, ThreadingHTTPServer(("127.0.0.1", 0), Provider) as provider:
        Thread(target=provider.serve_forever, daemon=True).start()
        home = Path(directory).resolve()
        agent = home / ".pi/agent"
        agent.mkdir(parents=True)
        project = home / "project"
        project.mkdir()
        subprocess.run(["git", "init", "--initial-branch=main", str(project)], check=True, capture_output=True)
        (home / "config.json").write_text("{}")
        (agent / "models.json").write_text(json.dumps({"providers":{"fixture":{"baseUrl":f"http://127.0.0.1:{provider.server_port}/v1","api":"openai-completions","apiKey":"fixture","models":[{"id":"tiny"}]}}}))
        env = {**os.environ, "HOME":str(home), "PI_CODING_AGENT_DIR":str(agent), "STUDIO_CONFIG":str(home / "config.json"), "STUDIO_STATE_DIR":str(home / "state"), "TERM":"xterm-256color", "COLORTERM":"truecolor", "PI_TELEMETRY":"0", "PI_SKIP_VERSION_CHECK":"1"}
        subprocess.run([sys.executable, str(root / "scripts/configure.py"), str(root), str(agent)], env=env, check=True, stdout=subprocess.DEVNULL)
        settings_path = agent / "settings.json"
        settings = json.loads(settings_path.read_text())
        settings["retry"] = {"enabled": False, "maxRetries": 0}
        settings_path.write_text(json.dumps(settings))
        records = seed(project, env, f'http://127.0.0.1:{provider.server_port}')
        linked_beads.update(records['beads'])
        terminal = Terminal(project, env, output, records['session'])
        try:
            terminal.wait(
                lambda: any("▸ ~/project" in line and "tiny" in line for line in terminal.screen.display),
                "Studio's native session did not finish initialization",
            )
            terminal.contains("Awaiting approval")
            terminal.contains("2 satisfied")
            terminal.contains("2 proposed")
            terminal.contains("1 partial")
            terminal.send("Review the plans.")
            terminal.send("\x1b[D")
            terminal.send("\x1b[D")
            terminal.check_dock_height(3)
            terminal.send("\x1bs")
            terminal.contains("Verification")
            terminal.contains("Record property evidence")
            terminal.contains("Review the plans.")
            terminal.assert_mark("Verification", "◐", "status.warning")
            terminal.check_dock_height(8)
            terminal.send("\x1bs")
            terminal.wait(lambda: "Record property evidence" not in terminal.text(), "Dock did not minimize")
            terminal.send("\x1bs")
            terminal.contains("Record property evidence")
            terminal.send(" and test")  # Inserts before 's.' only when the original cursor survives both toggles.
            terminal.send("\r")
            terminal.contains("the lead remains available.")
            messages = [m.get("content") for req in received_requests for m in req["messages"] if m["role"] == "user"]
            assert any("Review the plan and tests." in str(message) for message in messages), messages
            terminal.contains("Record property evidence")
            terminal.send("What evidence still needs a decision?")
            terminal.send("\x1bs")
            terminal.wait(lambda: not any("◐ Verification" in line for line in terminal.screen.display), "Dock did not minimize")
            terminal.capture("status-dock-minimized")
            terminal.send("\x1bs")
            terminal.contains("◐ Verification")
            terminal.contains("What evidence still needs a decision?")
            terminal.capture("status-dock-expanded")
            terminal.send("\x15")
            terminal.send("/socrates-status inspect\r")
            terminal.contains("Needs attention")
            terminal.contains("▸ Satisfied 2")
            terminal.contains("Wave 2")
            terminal.wait(lambda: any("Specification" in line and "Implementation" in line for line in terminal.screen.display), "Wide inspector did not show parallel columns")
            assert "Problem First" not in terminal.text(), terminal.text()
            terminal.select_row("Satisfied 2")
            terminal.send("\r")
            terminal.contains("Problem First")
            terminal.assert_mark("Problem First", "●", "status.success")
            terminal.send("\r")
            terminal.select_row("Verification")
            terminal.assert_mark("Verification", "◐", "status.warning")
            terminal.assert_mark("Harmony", "○", "status.warning")
            terminal.send("\r")
            terminal.contains("Question and resume are covered.")
            terminal.send("\x1b")
            terminal.send("\t")
            terminal.select_row("Keep the lead available")
            terminal.capture("status-board-wide")
            terminal.resize(60, 24)
            terminal.contains("Implementation")
            terminal.contains("Specification")
            terminal.send("\r")
            terminal.contains("Toggling the dock preserves the complete unsent prompt.")
            terminal.contains("Requirements · R1")
            terminal.contains("Depends on · assess")
            terminal.capture("status-board-task-detail")
            terminal.send("\x1b")
            terminal.send("\t")
            terminal.send("\r")
            terminal.contains("Question and resume are covered.")
            terminal.capture("status-board-property-detail")
            terminal.send("\x1b")
            terminal.resize(112, 32)
            terminal.send("?")
            terminal.contains("Enter")
            terminal.send("?")
            terminal.send("\x1b")

            terminal.send(f"/socrates {records['question']}\r")
            terminal.contains("Which verification boundary should we use?")
            terminal.send("\x1b")
            terminal.contains("Waiting for your answer")
            terminal.capture("status-dock-question")
            with sqlite3.connect(home / "state/discoveries.sqlite") as db:
                pending = json.loads(db.execute("SELECT record FROM discoveries WHERE id=?", (records["question"],)).fetchone()[0])
            assert "answer" not in pending["specification"]["exchange"], pending
            terminal.send("/socrates\r")
            terminal.contains("Focused native check")
            terminal.send("\r")
            terminal.wait(request_started.is_set, "Native lead did not resume the recorded answer")
            terminal.contains("Updating the draft")
            terminal.capture("status-dock-working")
            release_response.set()
            terminal.contains("Awaiting incorporation")
            terminal.send("/socrates-status inspect\r")
            terminal.contains("4 recheck")
            terminal.select_row("Problem First")
            terminal.send("\r")
            terminal.contains("Previous assessment: Satisfied")
            terminal.capture("status-board-recheck")
            terminal.send("\x1b")
            terminal.send("\x1b")

            with sqlite3.connect(home / "state/discoveries.sqlite") as db:
                saved = json.loads(db.execute("SELECT record FROM discoveries WHERE id=?", (records["question"],)).fetchone()[0])
            assert saved["specification"]["exchange"]["answer"]["text"] == "Focused native check", saved
            assert saved["specification"]["status"] == "interrogating", saved
            assert "graph" not in saved and "approved" not in saved, saved

            terminal.send(f"/socrates {records['unknown']}\r")
            terminal.contains("Make specification readiness visible")
            terminal.send("\x1b")
            terminal.contains("13 not assessed")
            terminal.send("/socrates-status inspect\r")
            terminal.contains("Not assessed")
            terminal.select_row("Not assessed 13")
            terminal.send("\r")
            terminal.contains("Problem First")
            terminal.assert_mark("Problem First", "○", "text.muted")
            terminal.capture("status-board-unassessed")
            terminal.send("\x1b")
            terminal.send(f"/socrates {records['approved']}\r")
            terminal.contains('Make specification readiness visible')
            terminal.send("\x1b")
            terminal.contains('1 closed')
            terminal.contains('1 in progress')
            terminal.contains('1 blocked')
            terminal.send('/socrates-status max\r')
            terminal.send('Explain the progress of the linked work.\r')
            terminal.contains('continue the conversation here.')
            terminal.contains('1 in progress')
            terminal.assert_mark('Verify the handoff', '×', 'status.error')
            terminal.assert_mark('Keep the lead available', '◐', 'accent')
            terminal.assert_mark('Record property evidence', '●', 'status.success')
            terminal.check_dock_height(8)
            terminal.send('What would unblock verification?')
            terminal.capture('status-dock-linked')
            terminal.send('\x1bs')
            terminal.wait(lambda: '× Verify the handoff' not in terminal.text(), 'Linked dock did not minimize')
            terminal.contains('1 blocked')
            terminal.contains('What would unblock verification?')
            terminal.check_dock_height(3)
            terminal.capture('status-dock-linked-minimized')
            terminal.send('\x15')
            terminal.send('/socrates-status inspect\r')
            terminal.contains('Wave 3')
            terminal.assert_mark('Record property evidence', '●', 'status.success')
            terminal.assert_mark('Keep the lead available', '◐', 'accent')
            terminal.assert_mark('Verify the handoff', '×', 'status.error')
            terminal.capture('status-board-linked')
            assert set(bead_reads) == {'/v0/beads/context', *(f'/v0/beads/issues/{key}' for key in linked_beads)}, bead_reads
            assert not provider_errors, provider_errors
        finally:
            release_response.set()
            terminal.close()
        terminal = Terminal(project, env, output, records['planOnlySession'])
        try:
            terminal.contains("Awaiting approval")
            terminal.send("/plan\r")
            terminal.contains("Not started")
            terminal.contains("No Socrates specification for this breakdown.")
            terminal.contains("Record property evidence")
            terminal.capture("status-board-plan-only")
            terminal.send("\r")
            terminal.contains("Old assessments remain inspectable after a revision.")
        finally:
            terminal.close()
            provider.shutdown()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, help="Keep dark terminal screenshots and matching text")
    run(parser.parse_args().output)
    print("Native dock/editor, two-column board, folding, evidence, narrow navigation, question/resume, freshness and plan-only inspection passed.")
