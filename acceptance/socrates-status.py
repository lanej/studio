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

import pyte
from PIL import Image, ImageDraw, ImageFont


root = Path(__file__).resolve().parents[1]
palette = json.loads((root / "resources/colors.json").read_text())
request_started = Event()
release_response = Event()
provider_errors = []


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        system = "\n".join(
            str(message.get("content", ""))
            for message in request["messages"]
            if message["role"] == "system"
        )
        if "Harmony" not in system:
            provider_errors.append("Native lead did not load Socrates guidance")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        request_started.set()
        if not release_response.wait(20):
            provider_errors.append("Native response was not released")
        result = {
            "id": "socrates-status-fixture",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "tiny",
            "choices": [{
                "index": 0,
                "delta": {"role": "assistant", "content": "The answer is recorded; the draft is unchanged."},
                "finish_reason": "stop",
            }],
        }
        self.wfile.write(("data: " + json.dumps(result) + "\n\ndata: [DONE]\n\n").encode())


class Terminal:
    def __init__(self, project, env, output, columns=112, rows=32):
        self.output = output
        self.master, slave = os.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        self.process = subprocess.Popen(
            [str(root / "scripts/studio"), "lead", "--", "--offline", "--no-mcp", "--model", "fixture/tiny"],
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

    def resize(self, columns, rows):
        self.screen.resize(lines=rows, columns=columns)
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        os.killpg(self.process.pid, signal.SIGWINCH)
        self.pump(0.3)

    def capture(self, name, *, panel=False, widget=False):
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
        first, last = (1, self.screen.lines - 1) if panel else (0, self.screen.lines)
        if widget:
            first = next(index for index, line in enumerate(self.screen.display) if line.startswith("Socrates"))
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


def seed(project, env):
    source = f"""
import {{ Discoveries }} from {json.dumps(str(root / 'discovery/store.ts'))};
import {{ SpecStatus }} from {json.dumps(str(root / 'socrates/spec.ts'))};
import {{ coverageToken }} from {json.dumps(str(root / 'socrates/assessment.ts'))};
const store = new Discoveries();
const draft = {{
  objective: 'Make specification readiness visible', scope: ['Socrates status and evidence'],
  requirements: [{{id:'R1', outcome:'Show property assessments', acceptance:'Inspect evidence while preserving question state'}}],
  decisions: [{{id:'D1', decision:'Choose the verification boundary', basis:'observed', evidence:'Operator request', disposition:'open', uncertainty:'Need the narrowest useful check'}}],
  blockingQuestions: [],
  coverage: {{domains:[], focus:'verification', assessments:[
    {{propertyId:'problem-first',status:'satisfied',reason:'The operator cannot see which properties remain unresolved.'}},
    {{propertyId:'clarity',status:'satisfied',reason:'Assessment and activity are separate observations.'}},
    {{propertyId:'verification',status:'open',reason:'Check unknown, stale, waiting and resumed states.'}},
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
const question=create('Question in progress',{{...draft,blockingQuestions:['Which verification boundary should we use?']}});
store.change(question,row=>{{row.specification.exchange={{prompt:{{decisionId:'D1',question:'Which verification boundary should we use?',options:[{{label:'Focused native check',description:'Exercise the status UI'}},{{label:'Keep investigating',description:'Leave the boundary open'}}]}}}};}});
const {{coverage,...legacyDraft}}=draft;
const unknown=create('Unassessed discovery',legacyDraft);
console.log(JSON.stringify({{covered,question,unknown}}));store.close();
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
        records = seed(project, env)
        terminal = Terminal(project, env, output)
        try:
            terminal.wait(
                lambda: any("▸ ~/project" in line and "tiny" in line for line in terminal.screen.display),
                "Studio's native session did not finish initialization",
            )
            terminal.send(f"/socrates {records['covered']}\r")
            terminal.contains("Make specification readiness visible")
            terminal.send("\x1b")
            terminal.contains("2 satisfied")
            terminal.contains("2 open")
            terminal.capture("socrates-summary", widget=True)
            terminal.send("/socrates-status\r")
            terminal.contains("Problem First")
            terminal.contains("9 not assessed")
            terminal.contains("j/k select")
            terminal.contains("Enter inspect")
            terminal.keys("k" * 20 + "j" * 7)
            terminal.contains("Check unknown, stale, waiting and resumed states.")
            assert " ".join(terminal.text().split()).count("Check unknown, stale, waiting and resumed states.") == 1, terminal.text()
            terminal.capture("socrates-status", panel=True)
            terminal.resize(60, 24)
            terminal.send("l")
            terminal.contains("Check unknown, stale, waiting and resumed states.")
            terminal.contains("h back")
            terminal.capture("socrates-evidence", panel=True)
            terminal.send("h")
            terminal.contains("Verification")
            terminal.send("\x1b")
            terminal.resize(112, 32)

            terminal.send(f"/socrates {records['question']}\r")
            terminal.contains("Which verification boundary should we use?")
            terminal.send("\x1b")
            terminal.contains("Waiting for your answer")
            terminal.capture("socrates-waiting", widget=True)
            with sqlite3.connect(home / "state/discoveries.sqlite") as db:
                pending = json.loads(db.execute("SELECT record FROM discoveries WHERE id=?", (records["question"],)).fetchone()[0])
            assert "answer" not in pending["specification"]["exchange"], pending
            terminal.send("/socrates\r")
            terminal.contains("Focused native check")
            terminal.send("\r")
            terminal.wait(request_started.is_set, "Native lead did not resume the recorded answer")
            terminal.wait(
                lambda: any("Socrates" in line and "Working" in line for line in terminal.screen.display),
                "The Socrates widget did not show live activity",
            )
            terminal.capture("socrates-working", widget=True)
            release_response.set()
            terminal.wait(
                lambda: any("Socrates" in line and "Waiting" in line and "Answer recorded" in line for line in terminal.screen.display),
                "Recorded answer did not settle into awaiting incorporation",
            )
            terminal.contains("Awaiting incorporation")
            terminal.send("/socrates-status\r")
            terminal.contains("Socrates · Question in progress")
            terminal.contains("j/k select")
            terminal.contains("recheck")
            terminal.capture("socrates-recheck", panel=True)
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
            terminal.send("/socrates-status\r")
            terminal.contains("Not assessed")
            terminal.capture("socrates-unassessed", panel=True)
            assert not provider_errors, provider_errors
        finally:
            release_response.set()
            terminal.close()
            provider.shutdown()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, help="Keep dark terminal screenshots and matching text")
    run(parser.parse_args().output)
    print("Native Socrates status, evidence navigation, resize, question/resume and assessment freshness passed.")
