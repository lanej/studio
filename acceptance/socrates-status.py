# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte", "pillow"]
# ///
"""Verify Socrates status and evidence through the native Pi terminal."""
import argparse
import codecs
import faulthandler
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
initial_prompt = "Let me inspect this proposal while keeping our conversation open."
# A native Markdown paragraph that fits the full terminal, but wraps in the lead column.
review_sentence = "The live handoff check still needs a linked bead and a fresh assessment before the review can finish."
linked_sentence = "The handoff check can start once the lead sidebar is complete and its linked dependency has closed."
wide_columns, wide_rows = 128, 34


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
        reply = ("The answer is recorded. The draft is unchanged." if resumed_answer
                 else f"""The remaining blocker is handoff verification.

The evidence for R1 is recorded. Work on the lead sidebar is underway.

{linked_sentence}

The open Harmony decision concerns how to incorporate the recorded answer. The verification property already has coverage for question and resume.""" if linked_review
                 else f"""There are two proposed tasks. The first preserves the evidence for R1. The second keeps that evidence visible while the lead conversation continues.

{review_sentence}

Verification already covers question and resume. A native check of stale assessments would close the remaining gap.

The plan is awaiting approval.""")
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
    def __init__(self, project, env, output, session, mode="fullscreen", columns=wide_columns, rows=wide_rows):
        print(f"Starting the {mode} lead in a {columns}×{rows} terminal", flush=True)
        self.output = output
        self.master, slave = os.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        self.process = subprocess.Popen(
            [str(root / "scripts/studio"), "lead", "--", "--offline", "--no-mcp", "--model", "fixture/tiny", "--tui-mode", mode, "--session", session],
            env=env, cwd=project, stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
        )
        os.close(slave)
        os.set_blocking(self.master, False)
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
                    if not chunk:
                        return
                    self.raw.extend(chunk)
                    self.stream.feed(self.decoder.decode(chunk))
                except BlockingIOError:
                    continue
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
        data = text.encode()
        deadline = time.monotonic() + 8
        while data:
            if time.monotonic() >= deadline:
                raise TimeoutError(f"The lead stopped reading terminal input\n{self.text()}")
            try:
                data = data[os.write(self.master, data):]
            except BlockingIOError:
                self.pump()
        self.pump()

    def keys(self, keys):
        for key in keys:
            self.send(key)

    def board_rows(self):
        rows = []
        for line in self.screen.display:
            if line.strip() == "? keys":
                return rows
            rows.append(line.split("│"))
        return []

    @staticmethod
    def row_label(cell):
        mark, _, text = cell.strip().removeprefix("› ").partition(" ")
        if len(mark) == 1 and not mark.isalnum():
            # Properties, tasks and foldable groups start with one status or disclosure glyph.
            return text.partition("  ")[0].strip().removesuffix(" ◆")
        return None

    def board_selection(self):
        rows = self.board_rows()
        for y, cells in enumerate(rows):
            for column, cell in enumerate(cells):
                if cell.lstrip().startswith("› ") and (label := self.row_label(cell)) is not None:
                    return y, column, label
        return None

    def wait_for_selection(self, label):
        self.wait(lambda: (selected := self.board_selection()) is not None and label == selected[2],
                  f"The inspector did not restore its selection to {label!r}")

    def select_row(self, label):
        """Walk to a visible row, waiting for the selection to move after each key."""
        def positions():
            selected = self.board_selection()
            if selected is not None:
                y, column, _ = selected
                for target, cells in enumerate(self.board_rows()):
                    if column < len(cells):
                        observed = self.row_label(cells[column])
                        # Task rows append their delivery label after the title.
                        if observed == label or (observed is not None and observed.startswith(label + " · ")):
                            return y, target
            return None

        self.wait(lambda: positions() is not None, f"Missing {label!r} in the active inspector column")
        for _ in range(self.screen.lines):
            y, target = positions()
            if y == target:
                return
            before = self.board_selection()
            self.send("j" if y < target else "k")
            self.wait(lambda: positions() is not None and self.board_selection() != before,
                      f"The selection did not move toward {label!r}")
        raise AssertionError(f"Could not focus {label!r}\n{self.text()}")

    def close_detail(self):
        # A standalone escape is parsed asynchronously. Wait for the board
        # before sending another key, which could otherwise become an Alt chord.
        self.contains("Esc back")
        self.send("\x1b")
        self.wait(lambda: any(line.strip() == "? keys" for line in self.screen.display),
                  "Escape did not return from the evidence detail to the board")

    def rail_start(self):
        """Find both stacked section titles on the right, ignoring chat and inspector text."""
        lines = self.screen.display
        for y, line in enumerate(lines):
            x = line.find("Specification", self.screen.columns // 2)
            if x < 0:
                continue
            if any(abs(next_line.find("Implementation", self.screen.columns // 2) - x) <= 1 for next_line in lines[y + 1:]):
                return x
        return None

    def wait_for_rail(self):
        self.wait(lambda: self.rail_start() is not None, "The native console did not show a right status column")

    def wait_for_session(self):
        # Pi mounts widgets during session_start and restores the transcript
        # after binding extension shortcuts. Only then can we exercise Alt+S.
        self.contains(initial_prompt)
        self.wait_for_rail()

    def check_lead_wrap(self, sentence):
        """Prove every word remains visible and that the lead itself received a smaller width."""
        x = self.rail_start()
        assert x is not None, self.text()
        # Leave the rail's border and padding out of the lead text.
        self.wait(lambda: sentence in " ".join(" ".join(line[:x].rstrip(" │┃") for line in self.screen.display).split()),
                  f"The lead clipped or covered part of {sentence!r}")
        assert not any(sentence in line[:x] for line in self.screen.display), f"Lead did not wrap at the rail\n{self.text()}"

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
        print("Closing the lead terminal", flush=True)
        # Darwin drains pending terminal output when the last slave closes. The
        # test has stopped reading, so hang up the master before waiting for Pi.
        os.close(self.master)
        try:
            os.killpg(self.process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=5)


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
const breakdown=draftSchema.parse({{summary:'Keep the lead available during handoff.',tasks:[
  {{key:'assess',title:'Record property evidence',description:'Persist the rationale for each assessed property.',acceptance:'Old assessments remain inspectable after a revision.',requirements:['R1'],owns:['socrates/assessment.ts']}},
  {{key:'dock',title:'Keep the lead available',description:'Keep coverage and linked work visible beside the conversation.',acceptance:'Toggling the sidebar preserves the complete unsent prompt.',requirements:['R1'],blockedBy:['assess'],owns:['socrates/presentation.ts']}}
]}});
store.change(covered,row=>{{row.leadPlan.draft=breakdown;row.planSpecificationRevision=coverageToken(row.specification);}});
const question=create('Question in progress',{{...draft,blockingQuestions:['Which verification boundary should we use?']}});
store.change(question,row=>{{row.specification.exchange={{prompt:{{decisionId:'D1',question:'Which verification boundary should we use?',options:[{{label:'Focused native check',description:'Exercise the status UI'}},{{label:'Keep investigating',description:'Leave the boundary open'}}]}}}};}});
const {{coverage,...legacyDraft}}=draft;
const unknown=create('Unassessed discovery',legacyDraft);
const planOnly=store.create({json.dumps(str(project))},'status-fixture','Standalone work breakdown');
const graphDraft = draftSchema.parse({{...breakdown,tasks:[...breakdown.tasks,
  {{key:'history',title:'Keep assessment history',description:'Retain previous evidence.',acceptance:'Old versions remain readable.',blockedBy:['assess']}},
  {{key:'review',title:'Review changes in the dock',description:'Compare the current and previous assessment.',acceptance:'Both versions can be reviewed in the dock.',blockedBy:['dock','history']}}
]}});
store.change(planOnly.id,row=>{{row.leadPlan.draft=graphDraft;}});
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
 manager.appendMessage({{role:'user',content:{json.dumps(initial_prompt)},timestamp:Date.now()}});
 manager.appendCustomEntry('studio:discovery',{{id:record,project:{json.dumps(str(project))}}});
 if (record === planOnly.id) {{
   const call={{type:'toolCall',id:'draft-1',name:'draft_implementation_plan',arguments:graphDraft}};
   const usage={{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}};
   manager.appendMessage({{role:'assistant',content:[call],api:'openai-completions',provider:'fixture',model:'tiny',usage,stopReason:'toolUse',timestamp:Date.now()}});
   manager.appendMessage({{role:'toolResult',toolCallId:call.id,toolName:call.name,content:[{{type:'text',text:'Draft saved.'}}],isError:false,timestamp:Date.now()}});
 }}
 return manager.getSessionFile();
}}
console.log(JSON.stringify({{covered,question,unknown,approved,beads,session:sessionFor(covered),planOnlySession:sessionFor(planOnly.id)}}));store.close();
"""
    result = subprocess.run(["bun", "--no-env-file", "-e", source], env=env, cwd=root, text=True, capture_output=True, check=True, timeout=30)
    return json.loads(result.stdout)


def run(output):
    print("Preparing the local Socrates and Beads fixtures", flush=True)
    # A Darwin sockaddr_un path must fit in 104 bytes, including Studio's activation socket suffix.
    temp_parent = "/private/tmp" if sys.platform == "darwin" else None
    with tempfile.TemporaryDirectory(prefix="st-ui-", dir=temp_parent) as directory, ThreadingHTTPServer(("127.0.0.1", 0), Provider) as provider:
        home = Path(directory).resolve()
        agent = home / ".pi/agent"
        agent.mkdir(parents=True)
        project = home / "project"
        project.mkdir()
        subprocess.run(["git", "init", "--initial-branch=main", str(project)], check=True, capture_output=True, timeout=30)
        (home / "config.json").write_text("{}")
        (agent / "models.json").write_text(json.dumps({"providers":{"fixture":{"baseUrl":f"http://127.0.0.1:{provider.server_port}/v1","api":"openai-completions","apiKey":"fixture","models":[{"id":"tiny"}]}}}))
        env = {**os.environ, "HOME":str(home), "PI_CODING_AGENT_DIR":str(agent), "STUDIO_CONFIG":str(home / "config.json"), "STUDIO_STATE_DIR":str(home / "state"), "TERM":"xterm-256color", "COLORTERM":"truecolor", "PI_TELEMETRY":"0", "PI_SKIP_VERSION_CHECK":"1"}
        subprocess.run([sys.executable, str(root / "scripts/configure.py"), str(root), str(agent)], env=env, check=True, stdout=subprocess.DEVNULL, timeout=30)
        settings_path = agent / "settings.json"
        settings = json.loads(settings_path.read_text())
        settings["retry"] = {"enabled": False, "maxRetries": 0}
        settings_path.write_text(json.dumps(settings))
        records = seed(project, env, f'http://127.0.0.1:{provider.server_port}')
        linked_beads.update(records['beads'])
        Thread(target=provider.serve_forever, daemon=True).start()
        terminal = Terminal(project, env, output, records['session'])

        def resume_discovery(title, offset):
            terminal.send("/discoveries\r")
            terminal.contains("Select a saved discovery")
            for _ in range(offset):
                terminal.send("\x1b[B")
            terminal.wait(
                lambda: any(line.lstrip().startswith("→ #") and title in line for line in terminal.screen.display),
                f"Picker did not highlight {title!r}",
            )
            terminal.send("\r")
            terminal.wait(lambda: "Select a saved discovery" not in terminal.text(), "Picker did not close")
            terminal.send("/socrates\r")

        try:
            terminal.wait(
                lambda: any("▸ ~/project" in line and "tiny" in line for line in terminal.screen.display),
                "Studio's native session did not finish initialization",
            )
            terminal.wait_for_session()
            terminal.contains("Proposed beads")
            terminal.contains("Record property evidence")
            terminal.assert_mark("Verification", "◐", "status.warning")
            draft = "Review the evidence for the specification and the dependency on verification before approving these changes."
            terminal.send(draft)
            terminal.check_lead_wrap(draft)
            terminal.send("\x1b[D")
            terminal.send("\x1b[D")
            terminal.send("\x1bs")
            terminal.wait(lambda: terminal.rail_start() is None and any(draft in line for line in terminal.screen.display),
                          "Collapsing the sidebar did not restore the full editor width")
            terminal.send("\x1bs")
            terminal.wait_for_rail()
            terminal.check_lead_wrap(draft)
            terminal.send(" request")  # Insert before 's.' to prove the mid-draft cursor survived.
            terminal.send("\r")
            terminal.wait(lambda: any(draft[:-2] + " requests." in str(m.get("content"))
                                      for request in received_requests for m in request["messages"] if m["role"] == "user"),
                          "The submitted prompt lost its contents or cursor position")
            terminal.check_lead_wrap(review_sentence)
            terminal.send("What evidence still needs a decision?")
            terminal.resize(60, 24)
            terminal.wait(lambda: terminal.rail_start() is None and "Specification" in terminal.text() and
                          "Implementation" in terminal.text(), "The narrow console did not restore the status dock")
            terminal.contains("What evidence still needs a decision?")
            terminal.capture("status-narrow-dock")
            terminal.send("\x1bs")
            terminal.contains("▾ Specification")
            terminal.contains("What evidence still needs a decision?")
            terminal.send("\x1bs")
            terminal.contains("▸ Specification")
            terminal.resize(wide_columns, wide_rows)
            terminal.wait_for_rail()
            terminal.contains("What evidence still needs a decision?")
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
            terminal.contains("▸ Satisfied 2")
            terminal.select_row("Verification")
            terminal.assert_mark("Verification", "◐", "status.warning")
            terminal.assert_mark("Harmony", "○", "status.warning")
            terminal.send("\r")
            terminal.contains("Question and resume are covered.")
            terminal.close_detail()
            terminal.send("\t")
            terminal.select_row("Keep the lead available")
            terminal.capture("status-board-wide")
            terminal.resize(60, 24)
            terminal.contains("Implementation")
            terminal.contains("Specification")
            terminal.send("\r")
            terminal.contains("Toggling the sidebar preserves the complete unsent prompt.")
            terminal.contains("Requirements · R1")
            terminal.contains("Depends on · assess")
            terminal.capture("status-board-task-detail")
            terminal.close_detail()
            terminal.send("\t")
            terminal.wait_for_selection("Verification")
            terminal.send("\r")
            terminal.contains("Question and resume are covered.")
            terminal.capture("status-board-property-detail")
            terminal.close_detail()
            terminal.resize(wide_columns, wide_rows)
            terminal.send("?")
            terminal.contains("Enter")
            terminal.send("?")
            terminal.send("\x1b")

            resume_discovery("Question in progress", 3)
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
            terminal.close_detail()
            terminal.send("\x1b")
            terminal.wait_for_rail()

            with sqlite3.connect(home / "state/discoveries.sqlite") as db:
                saved = json.loads(db.execute("SELECT record FROM discoveries WHERE id=?", (records["question"],)).fetchone()[0])
            assert saved["specification"]["exchange"]["answer"]["text"] == "Focused native check", saved
            assert saved["specification"]["status"] == "interrogating", saved
            assert "graph" not in saved and "approved" not in saved, saved

            before_resume = len(received_requests)
            resume_discovery("Unassessed discovery", 2)
            terminal.wait(lambda: any("Resume Socrates discovery" in str(request["messages"][-1]["content"])
                                      for request in received_requests[before_resume:]),
                          "Unassessed properties did not resume discovery")
            terminal.contains("Not assessed 13")
            terminal.send("/socrates-status inspect\r")
            terminal.contains("Not assessed")
            terminal.select_row("Not assessed 13")
            terminal.send("\r")
            terminal.contains("Problem First")
            terminal.assert_mark("Problem First", "○", "text.muted")
            terminal.capture("status-board-unassessed")
            terminal.send("\x1b")
            resume_discovery("Specification and linked work", 0)
            terminal.contains('Make specification readiness visible')
            terminal.send("\x1b")
            terminal.wait_for_rail()
            def linked_status_loaded():
                start = terminal.rail_start()
                if start is None:
                    return False
                cells = [line[start:].strip(" │") for line in terminal.screen.display]
                # Delivery can wrap the status onto the next line in the narrow rail.
                return any('Verify the handoff' in cell and
                           ('Blocked' in cell or (row + 1 < len(cells) and cells[row + 1].startswith('Blocked ·')))
                           for row, cell in enumerate(cells))
            terminal.wait(linked_status_loaded, "The linked Beads statuses did not load")
            terminal.send('/socrates-status max\r')
            terminal.send('Explain the progress of the linked work.\r')
            terminal.wait_for_rail()
            terminal.check_lead_wrap(linked_sentence)
            terminal.assert_mark('Verify the handoff', '×', 'status.error')
            terminal.assert_mark('Keep the lead available', '◐', 'accent')
            terminal.assert_mark('Record property evidence', '●', 'status.success')
            terminal.send('What would unblock verification?')
            terminal.capture('status-sidebar-linked')
            terminal.send('\x1bs')
            terminal.wait(lambda: terminal.rail_start() is None and any(linked_sentence in line for line in terminal.screen.display),
                          'Hiding the sidebar did not restore the transcript to its full width')
            terminal.contains('What would unblock verification?')
            terminal.capture('status-sidebar-hidden')
            terminal.send('\x15')
            terminal.send('/socrates-status inspect\r')
            terminal.contains('Wave 3')
            terminal.assert_mark('Record property evidence', '●', 'status.success')
            terminal.assert_mark('Keep the lead available', '◐', 'accent')
            terminal.assert_mark('Verify the handoff', '×', 'status.error')
            terminal.capture('status-board-linked')
            terminal.send('\x1b')
            terminal.send('/plan\r')
            terminal.contains('Enter details')
            def selected_task(title):
                terminal.wait(lambda: any(line.lstrip().startswith('› ') and
                                          (line.rstrip().endswith('  ' + title) or '  ' + title + ' · ' in line)
                                          for line in terminal.screen.display),
                              f"The plan graph did not select {title!r}")
            selected_task('Record property evidence')
            for title in ('Keep the lead available', 'Verify the handoff'):
                terminal.send('j')
                selected_task(title)
            terminal.assert_mark('Verify the handoff', '×', 'status.error')
            linked_beads['bd-verify']['status'] = 'open'
            terminal.wait(lambda: '1 open' in terminal.text() or 'Open' in next((line for line in terminal.screen.display if 'Verify the handoff' in line), ''), 'Live task status did not refresh')
            terminal.send('\r')
            terminal.contains('The selected bead matches the reviewed work.')
            assert set(bead_reads) == {'/v0/beads/context', *(f'/v0/beads/issues/{key}' for key in linked_beads)}, bead_reads
            assert not provider_errors, provider_errors
        finally:
            release_response.set()
            terminal.close()
        terminal = Terminal(project, env, output, records['planOnlySession'], mode='regular')
        try:
            terminal.wait_for_rail()
            terminal.contains("Local plan")
            # The status rail groups live observations by wave. The inline plan uses a graph.
            lead_width = terminal.rail_start()
            def transcript():
                return "\n".join(line[:lead_width] for line in terminal.screen.display)
            terminal.wait(lambda: all(text in transcript() for text in
                                      ("4 tasks", "Keep assessment history", "Review changes in the dock")),
                          "The lead did not show the replayed dependency graph")
            assert 'Wave 1' not in transcript() and 'Wave 2' not in transcript(), transcript()
            terminal.send("\x0f")  # Expand a completed call after replaying its transcript.
            terminal.contains("Both versions can be reviewed in the dock.")
            terminal.send("\x0f")
            regular_draft = "Confirm that reviewing a standalone task and its requirements preserves my unsent message in regular mode."
            terminal.send(regular_draft)
            terminal.check_lead_wrap(regular_draft)
            terminal.send("\x1bs")
            terminal.wait(lambda: terminal.rail_start() is None and any(regular_draft in line for line in terminal.screen.display),
                          "Regular mode did not restore the full editor width")
            terminal.send("\x1bs")
            terminal.wait_for_rail()
            terminal.send("\x15")
            terminal.send("/plan\r")
            terminal.contains("Enter details")
            terminal.contains("Record property evidence")
            assert 'No Socrates specification' not in terminal.text() and 'Wave 1' not in terminal.text(), terminal.text()
            terminal.resize(60, 24)
            terminal.contains("Review changes in the dock")
            terminal.capture("status-board-plan-only")
            terminal.send("\r")
            terminal.contains("Old assessments remain inspectable after a revision.")
        finally:
            terminal.close()
            provider.shutdown()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, help="Keep dark terminal screenshots and matching text")
    # A stuck native call cannot reach wait()'s assertion. Give CI its Python stacks.
    faulthandler.dump_traceback_later(120, exit=bool(os.environ.get("CI")))
    try:
        run(parser.parse_args().output)
    finally:
        faulthandler.cancel_dump_traceback_later()
    print("Native fullscreen and regular sidebars, cursor and width restoration, narrow fallback, folding, evidence, question/resume, and plan-only inspection passed.")
