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
from local_provider import tool_delta
from worker_sidebar import check_worker_sidebar, worker_prompt, worker_reply
from PIL import Image, ImageDraw, ImageFont
from socrates_fixture import message_text


root = Path(__file__).resolve().parents[1]
palette = json.loads((root / "resources/colors.json").read_text())
data_change_planning = (root / "resources/socrates/references/data-change-planning.md").read_text()
request_started = Event()
release_response = Event()
guidance_received = Event()
release_reassessment = Event()
provider_errors = []
received_requests = []
beads_project = str(uuid.uuid4())
linked_beads = {}
bead_reads = []
initial_prompt = "Let me inspect this proposal while keeping our conversation open."
# A native Markdown paragraph that fits the full terminal, but wraps in the lead column.
resume_sentence = "The same property evidence feeds both the sidebar and its revision history before the two results are compared."
review_sentence = "Changing one requirement should mark its old assessment stale while keeping the original evidence available in the inspector."
linked_sentence = "The handoff check can start once the lead sidebar is complete and its linked dependency has closed."
wide_columns, wide_rows = 128, 34
resolve_prompt = "Check that revising R1 marks its evidence stale. Keep all four beads local."
review_ready = "The specification is ready to freeze. Review the four beads and their dependencies before handoff."
scope_gap = "The lead and its dock share a draft. Decide whether another session sees those changes."
risk_gap = "Results are tagged by project. Verify a delayed poll cannot update a different session."
verification_gap = "Question and resume are covered. A stale assessment still needs a native check."
harmony_gap = "The dock and inspector read the same draft. Confirm they flag the same property after a revision."
ownership_prompt = "Let's settle who owns assessment freshness when an operator edits a requirement."
ownership_question = "Which component owns assessment freshness after a requirement changes?"
ownership_answer = "The discovery store"
ownership_criterion = "After a requirement changes, reopening the sidebar shows the stale assessment recorded by the discovery store."
release_diagram = Event()


def ownership_turn(request, draft):
    """Model a decision-driven C4 turn against the native discovery tools."""
    last = request["messages"][-1]
    call = last.get("tool_call_id")
    if last["role"] == "user" or call == "ask-owner":
        resolved = call == "ask-owner"
        if resolved:
            assert message_text(last) == f"Operator answer for D1: {ownership_answer}", last
        else:
            system = "\n".join(message_text(m) for m in request["messages"] if m["role"] == "system")
            host = system.split("# Pi host adapter", 1)[1]
            assert all(term in host for term in ("C4", "ownership", "Mermaid", "sequence diagram", "ask_user_question")), host
        decision = {**draft["decisions"][0], "decision": "Choose the owner of assessment freshness",
                    "disposition": "resolved" if resolved else "open", "basis": "decided" if resolved else "observed",
                    "evidence": ownership_answer if resolved else "The operator asked to settle ownership.",
                    "uncertainty": "None" if resolved else ownership_question}
        scope = {"propertyId": "scope", "status": "satisfied" if resolved else "open",
                 "reason": ownership_answer if resolved else ownership_question}
        coverage = {**draft["coverage"], "focus": "verification" if resolved else "scope", "assessments": [
            scope if item["propertyId"] == "scope" else item for item in draft["coverage"]["assessments"]
        ]}
        return tool_delta("record-owner" if resolved else "draft-ownership", "draft_socrates_specification", {
            **draft, "decisions": [decision], "blockingQuestions": [] if resolved else [ownership_question],
            "requirements": [{"id": "R1", "outcome": "Keep assessment freshness consistent",
                              "acceptance": ownership_criterion if resolved else "Reopen the sidebar after a requirement changes."}],
            "coverage": coverage,
        })
    if call == "draft-ownership":
        assert "Draft saved" in message_text(last), last
        return tool_delta("ownership-diagram", "show_diagram", {
            "title": "Assessment ownership", "systemId": "studio", "view": "container",
            "nodes": [
                {"id": "studio", "kind": "system", "label": "Studio", "detail": "Develops a specification with the operator."},
                {"id": "lead", "kind": "container", "label": "Lead console", "detail": "Captures requirement edits."},
                {"id": "store", "kind": "container", "label": "Discovery store", "detail": "Persists the current draft."},
                {"id": "sidebar", "kind": "container", "label": "Status sidebar", "detail": "Displays the current assessments."},
            ],
            "edges": [{"from": "lead", "to": "store", "label": "Saves revisions"},
                      {"from": "sidebar", "to": "store", "label": "Reads assessments"}],
        })
    if call == "ownership-diagram":
        assert message_text(last) == "Diagram shown.", last
        assert release_diagram.wait(20), "Native diagram was not visible"
        return tool_delta("ask-owner", "ask_user_question", {
            "decisionId": "D1", "question": ownership_question,
            "options": [{"label": ownership_answer, "description": "Persist freshness once for every view."},
                        {"label": "Each view", "description": "Determine freshness every time a view opens."}],
        })
    assert call == "record-owner" and "Draft saved" in message_text(last), last
    return {"role": "assistant", "content": "The ownership decision is recorded."}


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
        elif self.path.partition('?')[0] == '/v0/beads/issues':
            value = {'items': list(linked_beads.values()), 'has_more': False}
        elif self.path.partition('?')[0] == '/v0/beads/dependencies':
            value = {'items': [], 'missing': []}
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
        if resumed_answer:
            if "Harmony" not in system:
                provider_errors.append("Native lead did not load Socrates guidance")
            if data_change_planning not in system:
                provider_errors.append("Native lead did not deliver the bundled data and interface guidance")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        if resumed_answer:
            request_started.set()
            if not release_response.wait(20):
                provider_errors.append("Native response was not released")
        linked_review = any('progress of the linked work' in message for message in user_messages[-1:])
        resuming = any("Resume Socrates discovery" in message for message in user_messages[-1:])
        reply = ("The answer is recorded. The draft is unchanged." if resumed_answer
                 else f"""The remaining blocker is handoff verification.

The evidence for R1 is recorded. Work on the lead sidebar is underway.

{linked_sentence}

The blocked bead can run after the sidebar produces its accepted result.""" if linked_review
                 else f"""The proposal preserves the evidence used to assess each specification revision.

{resume_sentence}

One decision remains: how should we verify that an assessment is marked stale when its requirement changes?""" if resuming
                 else f"""Verification is partial. We can save a question and resume it. We still need to exercise a change to the underlying requirement.

{review_sentence}

Harmony depends on the same check. After the revision, the sidebar and inspector should flag the same property.

Should the native test change R1 and check both views?""")
        delta = {"role": "assistant", "content": reply}
        if user_messages and worker_prompt in user_messages[-1]:
            delta = {"role": "assistant", "content": worker_reply}
        last = request["messages"][-1]
        if user_messages and ownership_prompt in user_messages[-1]:
            delta = ownership_turn(request, self.server.in_progress_draft)
        elif user_messages and "Explain which properties remain open" in user_messages[-1]:
            if last["role"] == "user":
                guidance_received.set()
                if not release_reassessment.wait(20):
                    provider_errors.append("The property reassessment was not released")
                delta = tool_delta("review-open-properties", "draft_socrates_specification", self.server.in_progress_draft)
            elif last.get("tool_call_id") == "review-open-properties" and "Draft saved" not in str(last["content"]):
                provider_errors.append(str(last["content"]))
        elif user_messages and resolve_prompt in user_messages[-1]:
            if last["role"] == "user":
                delta = tool_delta("close-properties", "draft_socrates_specification", self.server.ready_draft)
            elif last.get("tool_call_id") == "close-properties":
                if "Properties satisfied" not in str(last["content"]):
                    provider_errors.append(str(last["content"]))
                delta = tool_delta("confirm-graph", "draft_implementation_plan", self.server.graph_draft)
            elif last.get("tool_call_id") == "confirm-graph":
                if "Assess every applicable property" not in str(last["content"]):
                    provider_errors.append(str(last["content"]))
                delta = tool_delta("assess-final-graph", "draft_socrates_specification", self.server.ready_draft)
            elif last.get("tool_call_id") == "assess-final-graph":
                if "Properties satisfied" not in str(last["content"]):
                    provider_errors.append(str(last["content"]))
                delta = {"role": "assistant", "content": review_ready}
        result = {
            "id": "socrates-status-fixture",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "tiny",
            "choices": [{
                "index": 0,
                "delta": delta,
                "finish_reason": "tool_calls" if "tool_calls" in delta else "stop",
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

    def centered_lines(self):
        """Read the overlay's viewport without the lead or sidebar alongside it."""
        width = min(100, self.screen.columns - 4)
        left = (self.screen.columns - width) // 2
        return [line[left:left + width] for line in self.screen.display]

    def framed_pane(self, title=None):
        """Find the actual frame and check its insets against the live terminal."""
        lines = self.screen.display
        top, header = next((y, line) for y, line in enumerate(lines)
                           if "╭" in line and "╮" in line and (title is None or title in line))
        left, right = header.index("╭"), header.rindex("╮")
        bottom = next(y for y, line in enumerate(lines[top + 1:], top + 1)
                      if line[left] == "╰" and line[right] == "╯")
        assert 0 < left < right < self.screen.columns - 1 and 0 < top < bottom < self.screen.lines - 1, self.text()
        assert abs(left - (self.screen.columns - right - 1)) <= 1, self.text()
        assert abs(top - (self.screen.lines - bottom - 1)) <= 1, self.text()
        return top, bottom, left, right

    def inspector_contains(self, text):
        self.wait(lambda: text in " ".join(" ".join(self.centered_lines()).split()), f"Missing {text!r} in the inspector")

    def centered_inspector(self, title, footer=None):
        lines = self.centered_lines()
        top = next((y for y, line in enumerate(lines) if line.startswith(" " + title)), None)
        footers = (footer,) if footer else ("Esc close", "? keys")
        bottom = next((y for y, line in enumerate(lines) if any(hint in line for hint in footers)
                       and top is not None and y > top), None)
        assert top is not None and bottom is not None and 0 < top < bottom < self.screen.lines - 1, self.text()
        assert abs(top - (self.screen.lines - bottom - 1)) <= 1, self.text()
        return lines[top:bottom + 1]

    def board_rows(self):
        rows = []
        for line in self.centered_lines():
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
        self.wait(lambda: any(line.strip() == "? keys" for line in self.centered_lines()),
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

    def rail_text(self):
        start = self.rail_start()
        if start is None:
            return ""
        return "\n".join(line[start:] for line in self.screen.display)

    def wait_for_rail(self):
        self.wait(lambda: self.rail_start() is not None, "The native console did not show a right status column")

    def check_property_focus(self):
        """Read the wrapped rationales in the rail itself, with the editor still present."""
        self.wait_for_rail()
        def property_text():
            return " ".join(self.rail_text().partition("Implementation")[0].split())
        self.wait(lambda: verification_gap in property_text() and "Harmony" in property_text(),
                  "The rail omitted the verification gap before the plan was ready")
        if self.screen.columns == wide_columns:
            self.wait(lambda: all(gap in property_text() for gap in (scope_gap, risk_gap, harmony_gap)),
                      "The wide rail did not render each property rationale")
            start = self.rail_start()
            self.assert_rail_mark("Scope", "○", "status.error")
            self.assert_rail_mark("Verification", "◐", "status.warning")
            self.assert_foreground("Satisfied 9", "status.success", start)
            self.assert_foreground("Question and resume are covered.", "text.muted", start)
        rail = self.rail_text()
        spec, _, plan = rail.partition("Implementation")
        assert spec.count("\n") > len([line for line in plan.splitlines() if line.strip()]), rail
        assert "Proposed beads" not in plan, rail
        assert "Draft" in plan.splitlines()[0], rail
        if self.screen.columns == wide_columns:
            self.check_dependency_graph()
            assert "/plan" not in plan, rail
        else:
            # One row can remain if the next task and its connector need two.
            assert any(line.strip().endswith("/plan") for line in plan.splitlines()[-2:]), rail
            assert "Review changes in the dock" not in plan, rail
        self.assert_background("Specification", "surface.raised", start=self.rail_start())
        self.assert_background("Verification", "surface.raised", start=self.rail_start())

    def assert_background(self, text, role, start=0):
        for y, line in enumerate(self.screen.display):
            x = line.find(text, start)
            if x >= 0 and self.screen.buffer[y][x].bg.upper() == palette["roles"][role].lstrip("#").upper():
                return
        raise AssertionError(f"Missing {role} behind {text!r}\n{self.text()}")

    def assert_foreground(self, text, role, start=0):
        expected = palette["roles"][role].lstrip("#").upper()
        for y, line in enumerate(self.screen.display):
            x = line.find(text, start)
            if x >= 0 and all(self.screen.buffer[y][x+i].fg.upper() == expected
                              for i, char in enumerate(text) if not char.isspace()):
                return
        raise AssertionError(f"Missing {role} on {text!r}\n{self.text()}")

    def check_dependency_graph(self):
        path = ("Record property evidence", "├─╮", "Keep the lead available",
                "Keep assessment history", "├─╯", "Review changes in the dock")
        self.wait(lambda: all(part in self.rail_text() for part in path),
                  "The Implementation sidebar did not draw the complete fork and join")
        rail = self.rail_text().partition("Implementation")[2]
        cursor = 0
        for part in path:
            found = rail.find(part, cursor)
            assert found >= 0, rail
            cursor = found + len(part)
        assert "Wave 1" not in rail and "Wave 2" not in rail, rail

    def wait_for_session(self):
        # Wait until both the restored transcript and its status widget are visible.
        self.contains(initial_prompt)
        self.wait_for_rail()

    def check_lead_wrap(self, sentence):
        """Prove every word remains visible and that the lead itself received a smaller width."""
        def wrapped_frame():
            # A PTY read can end between the two section headers during a repaint.
            x = self.rail_start()
            if x is None:
                return False
            lead = " ".join(line[:x].rstrip(" │┃") for line in self.screen.display)
            return sentence in " ".join(lead.split())

        self.wait(wrapped_frame,
                  f"The lead clipped or covered part of {sentence!r}")
        x = self.rail_start()
        assert not any(sentence in line[:x] for line in self.screen.display), f"Lead did not wrap at the rail\n{self.text()}"

    def assert_rail_mark(self, title, mark, tone):
        """The full title and its colored glyph occupy the row; an active property may also carry ◆."""
        start = self.rail_start()
        assert start is not None, self.text()
        for y, line in enumerate(self.screen.display):
            rail = line[start:]
            if title not in rail:
                continue
            before, _, after = rail.partition(title)
            x = before.find(mark)
            if x >= 0 and after.strip() in ("", "◆"):
                assert self.screen.buffer[y][start + x].fg.upper() == palette["roles"][tone].lstrip("#"), rail
                return
        raise AssertionError(f"Missing colored {mark} and full title {title!r} in the passive rail\n{self.rail_text()}")

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

    def capture(self, name, *, rail_image=False):
        if self.output is None:
            return
        self.output.mkdir(parents=True, exist_ok=True)
        fonts = [
            ("/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/Menlo.ttc", 1),
            ("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf", 0),
            ("/usr/share/fonts/truetype/liberation2/LiberationMono-Regular.ttf", "/usr/share/fonts/truetype/liberation2/LiberationMono-Bold.ttf", 0),
        ]
        font = bold = ImageFont.load_default()
        for regular_path, bold_path, bold_index in fonts:
            if Path(regular_path).is_file():
                font = ImageFont.truetype(regular_path, 16)
                bold = ImageFont.truetype(bold_path, 16, index=bold_index) if Path(bold_path).is_file() else font
                break
        braille_path = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
        braille = ImageFont.truetype(str(braille_path), 16) if braille_path.is_file() else font
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
                glyph_font = bold if cell.bold else font
                if len(cell.data) == 1 and "\u2800" <= cell.data <= "\u28ff":
                    glyph_font = braille
                draw.text((x * cell_width, top), cell.data, font=glyph_font, fill=fg)
        image.save(self.output / f"{name}-{self.screen.columns}.png")
        if rail_image:
            start = self.rail_start()
            assert start is not None, self.text()
            divider = self.screen.display[0].rfind("│", 0, start)
            assert divider >= 0, self.text()
            image.crop((divider * cell_width, 0, image.width, image.height)).save(self.output / "socrates-property-sidebar.png")
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
import {{ coverageToken, specificationToken }} from {json.dumps(str(root / 'socrates/assessment.ts'))};
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
    {{propertyId:'verification',status:'partial',reason:{json.dumps(verification_gap)}}},
    {{propertyId:'harmony',status:'open',reason:{json.dumps(harmony_gap)}}}
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
const readyDraft={{...draft,
  decisions:[
    {{...draft.decisions[0],disposition:'resolved',basis:'decided',evidence:'The operator chose a native check after revising R1.',uncertainty:'None'}},
    {{id:'D2',decision:'Integrate the reviewed beads locally.',disposition:'resolved',basis:'decided',evidence:'The operator requested local integration for the plan.',uncertainty:'None'}}
  ],
  deliveryPolicy:{{decisionId:'D2',pullRequests:'none'}},
  coverage:{{domains:[], assessments:Object.entries({{
    'problem-first':'The operator needs to see unresolved properties during discovery.',
    interpretation:'The sidebar and inspector present the same stored assessments.',
    clarity:'Open and partial marks distinguish missing evidence from incomplete evidence.',
    scope:'R1 covers the lead sidebar, retained assessments and review in the dock.',
    context:'The lead remains usable while the sidebar shows progress.',
    parsimony:'The sidebar renders the same dependency graph as the plan inspector.',
    success:'Both surfaces identify the unresolved property after a revision.',
    verification:'D1 specifies a native check that revising R1 invalidates its assessment.',
    constraints:'Planning preserves the unsent prompt and performs no Beads operations.',
    stakeholders:'The operator reviews the assessment and approves handoff.',
    risk:'Revising a requirement invalidates its prior assessment.',
    'execution-readiness':'Each bead has a requirement, acceptance criterion and dependency list.',
    harmony:'The same assessment supplies both surfaces and the two graphs show the same dependencies.'
  }}).map(([propertyId,reason])=>({{propertyId,status:'satisfied',reason}}))}}
}};
const gaps=[...draft.coverage.assessments,
  {{propertyId:'scope',status:'open',reason:{json.dumps(scope_gap)}}},
  {{propertyId:'risk',status:'partial',reason:{json.dumps(risk_gap)}}}
];
const inProgress={{...draft,coverage:{{...draft.coverage,assessments:readyDraft.coverage.assessments.map(
  assessment=>gaps.find(gap=>gap.propertyId===assessment.propertyId)??assessment
)}}}};
const covered=create('Status inspection',inProgress);
const breakdown=draftSchema.parse({{summary:'Keep the lead available during handoff.',tasks:[
  {{key:'assess',title:'Record property evidence',description:'Persist the rationale for each assessed property.',acceptance:'Old assessments remain inspectable after a revision.',requirements:['R1'],owns:['socrates/assessment.ts']}},
  {{key:'dock',title:'Keep the lead available',description:'Keep coverage and linked work visible beside the conversation.',acceptance:'Toggling the sidebar preserves the complete unsent prompt.',requirements:['R1'],blockedBy:['assess'],owns:['socrates/presentation.ts']}}
]}});
const question=create('Question in progress',{{...inProgress,blockingQuestions:['Which verification boundary should we use?']}});
store.change(question,row=>{{row.specification.exchange={{prompt:{{decisionId:'D1',question:'Which verification boundary should we use?',options:[{{label:'Focused native check',description:'Exercise the status UI'}},{{label:'Keep investigating',description:'Leave the boundary open'}}]}}}};}});
const {{coverage,...legacyDraft}}=draft;
const legacy=create('Legacy discovery',legacyDraft);
const planOnly=store.create({json.dumps(str(project))},'status-fixture','Standalone work breakdown');
const graphDraft = draftSchema.parse({{...breakdown,tasks:[...breakdown.tasks,
  {{key:'history',title:'Keep assessment history',description:'Retain previous evidence.',acceptance:'Old versions remain readable.',requirements:['R1'],blockedBy:['assess']}},
  {{key:'review',title:'Review changes in the dock',description:'Compare the current and previous assessment.',acceptance:'Both versions can be reviewed in the dock.',requirements:['R1'],blockedBy:['dock','history']}}
]}});
store.change(covered,row=>{{row.leadPlan.draft=graphDraft;row.planSpecificationRevision=specificationToken(row.specification);}});
store.change(planOnly.id,row=>{{row.leadPlan.draft=graphDraft;}});
const approved=create('Specification and linked work', readyDraft);
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
console.log(JSON.stringify({{covered,question,legacy,approved,beads,inProgress,readyDraft,graphDraft,session:sessionFor(covered),planOnlySession:sessionFor(planOnly.id)}}));store.close();
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
        (home / "config.toml").write_text('[keybindings.lead]\ntoggleStatus = "ctrl+."\n')
        toggle_status = "\x1b[46;5u"
        (agent / "models.json").write_text(json.dumps({"providers":{"fixture":{"baseUrl":f"http://127.0.0.1:{provider.server_port}/v1","api":"openai-completions","apiKey":"fixture","models":[{"id":"tiny"}]}}}))
        env = {**os.environ, "HOME":str(home), "PI_CODING_AGENT_DIR":str(agent), "STUDIO_CONFIG":str(home / "config.toml"), "STUDIO_STATE_DIR":str(home / "state"), "TERM":"xterm-256color", "COLORTERM":"truecolor", "PI_TELEMETRY":"0", "PI_SKIP_VERSION_CHECK":"1"}
        subprocess.run([sys.executable, str(root / "scripts/configure.py"), str(root), str(agent)], env=env, check=True, stdout=subprocess.DEVNULL, timeout=30)
        settings_path = agent / "settings.json"
        settings = json.loads(settings_path.read_text())
        settings["retry"] = {"enabled": False, "maxRetries": 0}
        settings_path.write_text(json.dumps(settings))
        records = seed(project, env, f'http://127.0.0.1:{provider.server_port}')
        provider.in_progress_draft = records['inProgress']
        provider.ready_draft = records['readyDraft']
        provider.graph_draft = records['graphDraft']
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
            terminal.check_property_focus()
            terminal.send("/socrates-status min\r")
            terminal.wait(lambda: terminal.rail_start() is None, "The status command did not collapse the sidebar")
            terminal.send("/socrates\r")
            terminal.wait_for_rail()
            terminal.check_property_focus()
            terminal.check_lead_wrap(resume_sentence)
            assert not bead_reads, bead_reads
            terminal.assert_mark("Verification", "◐", "status.warning")
            draft = "Explain which properties remain open and what evidence would settle them after late specification changes."
            terminal.send(draft)
            terminal.check_lead_wrap(draft)
            terminal.send("\x1b[D")
            terminal.send("\x1b[D")
            terminal.send(toggle_status)
            terminal.wait(lambda: terminal.rail_start() is None and any(draft in line for line in terminal.screen.display),
                          "Collapsing the sidebar did not restore the full editor width")
            terminal.send(toggle_status)
            terminal.wait_for_rail()
            terminal.check_lead_wrap(draft)
            terminal.send(" request")  # Insert before 's.' to prove the mid-draft cursor survived.
            terminal.send("\r")
            terminal.wait(lambda: any(draft[:-2] + " requests." in str(m.get("content"))
                                      for request in received_requests for m in request["messages"] if m["role"] == "user"),
                          "The submitted prompt lost its contents or cursor position")
            terminal.wait(guidance_received.is_set, "Studio did not deliver the operator's guidance")
            terminal.wait(lambda: "↺" in terminal.rail_text(), "Previous evidence still appeared current after operator input")
            terminal.assert_foreground("↺", "focus", terminal.rail_start())
            release_reassessment.set()
            terminal.check_lead_wrap(review_sentence)
            terminal.check_property_focus()
            terminal.capture("socrates-sidebar-properties", rail_image=True)
            terminal.resize(104, 26)
            terminal.check_property_focus()
            terminal.capture("socrates-sidebar-properties")
            terminal.resize(wide_columns, wide_rows)
            terminal.wait_for_rail()
            terminal.send("What evidence still needs a decision?")
            terminal.resize(60, 24)
            terminal.wait(lambda: terminal.rail_start() is None and "Specification" in terminal.text() and
                          "Implementation" in terminal.text(), "The narrow console did not restore the status dock")
            terminal.contains("What evidence still needs a decision?")
            def compact_dock():
                return any("Specification" in line and "2 open" in line for line in terminal.screen.display)

            terminal.wait(compact_dock, "The compact dock did not show the specification counts")
            # Send a real SGR mouse press and release on the former disclosure.
            row = next(y for y, line in enumerate(terminal.screen.display, 1)
                       if "Specification" in line and "2 open" in line)
            terminal.send(f"\x1b[<0;3;{row}M\x1b[<0;3;{row}m")
            terminal.send("!")
            terminal.contains("What evidence still needs a decision?!")
            assert compact_dock(), terminal.text()
            terminal.send("\x7f")
            terminal.assert_foreground("2 open", "status.error")
            terminal.assert_foreground("2 partial", "status.warning")
            terminal.capture("status-narrow-dock")
            terminal.send(toggle_status)
            terminal.contains("share a draft")
            terminal.contains("What evidence still needs a decision?")
            dock = terminal.text().rpartition("Specification")[2].partition("Implementation")[0]
            assert "share a draft" in " ".join(dock.split()), dock
            terminal.assert_mark("Scope", "○", "status.error")
            terminal.capture("status-narrow-properties")
            terminal.send(toggle_status)
            terminal.wait(compact_dock, "The configured status shortcut did not collapse the dock")
            terminal.send("\x15")
            terminal.send("/socrates\r")
            terminal.contains("share a draft")
            terminal.wait(lambda: terminal.rail_start() is None, "A narrow terminal reserved a side column")
            terminal.send("What would cover the handoff?")
            terminal.resize(wide_columns, wide_rows)
            terminal.wait_for_rail()
            terminal.contains("What would cover the handoff?")
            terminal.send("\x15")
            terminal.send("/socrates-status inspect\r")
            terminal.contains("Needs attention")
            terminal.centered_inspector("Status inspection")
            terminal.contains("▸ Satisfied 9")
            terminal.contains("Wave 2")
            terminal.wait(lambda: any("Specification" in line and "Implementation" in line for line in terminal.screen.display), "Wide inspector did not show parallel columns")
            assert "Problem First" not in terminal.text(), terminal.text()
            terminal.assert_foreground("2 open", "status.error")
            terminal.assert_foreground("2 partial", "status.warning")
            terminal.assert_foreground("9 satisfied", "status.success")
            terminal.select_row("Satisfied 9")
            terminal.send("\r")
            terminal.contains("Problem First")
            terminal.assert_mark("Problem First", "●", "status.success")
            terminal.send("\r")
            terminal.contains("▸ Satisfied 9")
            terminal.select_row("Verification")
            terminal.assert_mark("Verification", "◐", "status.warning")
            terminal.assert_mark("Harmony", "○", "status.error")
            terminal.send("\r")
            terminal.inspector_contains("Question and resume are covered.")
            terminal.assert_foreground("◐ Partial", "status.warning")
            terminal.close_detail()
            terminal.send("\t")
            terminal.select_row("Keep the lead available")
            terminal.assert_background("Keep the lead available", "selection.bg")
            terminal.capture("status-board-wide")
            terminal.resize(60, 24)
            terminal.contains("Implementation")
            terminal.contains("Specification")
            terminal.send("\r")
            terminal.inspector_contains("Toggling the sidebar preserves the complete unsent prompt.")
            terminal.contains("Requirements · R1")
            terminal.contains("Depends on · assess")
            terminal.capture("status-board-task-detail")
            terminal.close_detail()
            terminal.send("\t")
            terminal.wait_for_selection("Verification")
            terminal.send("\r")
            terminal.inspector_contains("Question and resume are covered.")
            terminal.capture("status-board-property-detail")
            terminal.close_detail()
            terminal.resize(wide_columns, wide_rows)
            terminal.send("?")
            terminal.contains("Enter")
            terminal.send("?")
            terminal.send("\x1b")

            terminal.wait_for_rail()
            terminal.send(resolve_prompt + "\r")
            terminal.check_lead_wrap(review_ready)
            terminal.check_dependency_graph()
            assert "Proposed beads" not in terminal.rail_text(), terminal.rail_text()
            assert "Verification" not in terminal.rail_text(), terminal.rail_text()
            assert not bead_reads, bead_reads
            terminal.capture("socrates-sidebar-graph")

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
            terminal.contains("13 recheck")
            terminal.assert_foreground("13 recheck", "focus")
            terminal.select_row("Problem First")
            terminal.send("\r")
            terminal.inspector_contains("Previous assessment: Satisfied")
            terminal.assert_foreground("↺ Recheck", "focus")
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
            resume_discovery("Legacy discovery", 2)
            terminal.wait(lambda: any("Resume Socrates discovery" in str(request["messages"][-1]["content"])
                                      for request in received_requests[before_resume:]),
                          "Legacy open properties did not resume discovery")
            terminal.contains("Problem First")
            terminal.send("/socrates-status inspect\r")
            terminal.contains("13 open")
            terminal.select_row("Problem First")
            terminal.assert_mark("Problem First", "○", "status.error")
            terminal.capture("status-board-legacy-open")
            terminal.send("\x1b")
            resume_discovery("Specification and linked work", 0)
            terminal.wait_for_rail()
            terminal.wait(lambda: any("×" in line and "Verify the handoff" in line
                                      for line in terminal.rail_text().splitlines()),
                          "The linked Beads statuses did not load")
            terminal.send('Explain the progress of the linked work.\r')
            terminal.wait_for_rail()
            terminal.check_lead_wrap(linked_sentence)
            terminal.assert_rail_mark('Verify the handoff', '×', 'status.error')
            terminal.assert_rail_mark('Keep the lead available', '◐', 'accent')
            terminal.assert_rail_mark('Record property evidence', '●', 'status.success')
            terminal.send('What would unblock verification?')
            terminal.capture('status-sidebar-linked')
            terminal.send(toggle_status)
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
            for title, state in (("Record property evidence", "Closed"), ("Keep the lead available", "In progress"),
                                 ("Verify the handoff", "Blocked")):
                assert any(title in line and line.rstrip().endswith(state) for line in terminal.centered_lines()), terminal.text()
            terminal.capture('status-board-linked')
            terminal.send('\x1b')
            terminal.wait(lambda: not any(line.strip() == "? keys" for line in terminal.centered_lines()),
                          "The evidence board did not close before opening the plan")
            terminal.send('/plan\r')
            terminal.contains('Enter details')
            def selected_task(title):
                terminal.wait(lambda: any(line.lstrip().startswith('› ') and
                                          (line.rstrip().endswith('  ' + title) or '  ' + title + ' · ' in line)
                                          for line in terminal.centered_lines()),
                              f"The plan graph did not select {title!r}")
            selected_task('Record property evidence')
            for title in ('Keep the lead available', 'Verify the handoff'):
                terminal.send('j')
                selected_task(title)
            terminal.assert_mark('Verify the handoff', '×', 'status.error')
            linked_beads['bd-verify']['status'] = 'open'
            terminal.wait(lambda: any("1 open" in line for line in terminal.centered_lines()),
                          "The open count in the plan inspector did not refresh", timeout=15)
            terminal.send('\r')
            terminal.inspector_contains('The selected bead matches the reviewed work.')
            assert set(bead_reads) == {'/v0/beads/context', *(f'/v0/beads/issues/{key}' for key in linked_beads)}, bead_reads
            assert not provider_errors, provider_errors
        finally:
            release_response.set()
            terminal.close()
        check_worker_sidebar(Terminal, project, env, output,
                             {'url': f'http://127.0.0.1:{provider.server_port}', 'projectId': beads_project, 'reviewOnly': True},
                             linked_beads, records['readyDraft'])
        terminal = Terminal(project, env, output, records['planOnlySession'], mode='regular')
        try:
            terminal.wait_for_rail()
            terminal.contains("Local plan")
            terminal.check_dependency_graph()
            # The retained tool call draws its graph in the transcript as well.
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
            terminal.send(toggle_status)
            terminal.wait(lambda: terminal.rail_start() is None and any(regular_draft in line for line in terminal.screen.display),
                          "Regular mode did not restore the full editor width")
            terminal.send(toggle_status)
            terminal.wait_for_rail()
            terminal.send("\x15")
            terminal.send("/plan\r")
            terminal.contains("Enter details")
            terminal.contains("Record property evidence")
            plan_view = "\n".join(terminal.centered_inspector("Standalone work breakdown", "Enter details"))
            assert 'No Socrates specification' not in plan_view and 'Wave 1' not in plan_view, plan_view
            terminal.resize(60, 24)
            terminal.contains("Review changes in the dock")
            terminal.capture("status-board-plan-only")
            terminal.send("\r")
            terminal.inspector_contains("Old assessments remain inspectable after a revision.")
            terminal.send("\x1b")
            terminal.contains("Enter details")
            terminal.send("\x1b")
            terminal.resize(wide_columns, wide_rows)
            terminal.wait_for_rail()
            terminal.send("/socrates-status min\r")
            terminal.wait(lambda: terminal.rail_start() is None, "The old plan's sidebar did not close")
            terminal.send("/socrates Fresh discovery\r")
            terminal.wait_for_rail()
            terminal.contains("Not planned")
            terminal.contains("Problem First")
            terminal.assert_mark("Problem First", "○", "status.error")
            assert "Review changes in the dock" not in terminal.rail_text(), terminal.rail_text()
            terminal.send(ownership_prompt + "\r")
            terminal.contains("Assessment ownership")
            terminal.contains("Discovery store")
            terminal.wait_for_rail()
            terminal.capture("socrates-draft-diagram")
            release_diagram.set()
            terminal.contains(ownership_question)
            terminal.contains(ownership_answer)
            with sqlite3.connect(home / "state/discoveries.sqlite") as db:
                query = "SELECT record FROM discoveries WHERE json_extract(record, '$.title') = 'Fresh discovery'"
                pending = json.loads(db.execute(query).fetchone()[0])["specification"]
                assert pending["exchange"]["prompt"]["question"] == ownership_question and "answer" not in pending["exchange"]
                assert pending["draft"]["blockingQuestions"] == [ownership_question]
                terminal.send("\r")
                terminal.contains("The ownership decision is recorded.")
                saved = json.loads(db.execute(query).fetchone()[0])["specification"]
            assert "exchange" not in saved and saved["draft"]["blockingQuestions"] == [], saved
            assert saved["draft"]["decisions"][0]["evidence"] == ownership_answer, saved
            assert saved["draft"]["requirements"][0]["acceptance"] == ownership_criterion, saved
            assert any(item["propertyId"] == "scope" and item["status"] == "satisfied"
                       for item in saved["draft"]["coverage"]["assessments"]), saved
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
    print("Native property-first planning, design diagrams and decisions, reviewed graph expansion, palette surfaces, and fullscreen, regular and narrow terminal interactions passed.")
