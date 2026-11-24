# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte", "pillow"]
# ///
"""Exercise native Pi keyboard flows in owned PTYs and retain rendered screenshots."""
import argparse
import atexit
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
import fcntl
import gzip
import json
import os
from pathlib import Path
import select
import shutil
import sqlite3
import struct
import subprocess
import sys
import tempfile
import termios

import pyte
from PIL import Image, ImageDraw, ImageFont

parser = argparse.ArgumentParser()
parser.add_argument("--output", required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
palette = json.loads((root / "resources/colors.json").read_text())
output = Path(args.output)
output.mkdir(parents=True, exist_ok=True)

class DiscoveryProvider(BaseHTTPRequestHandler):
    def log_message(self, *_args): pass
    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        prompt = "\n".join(str(message.get("content", "")) for message in request["messages"] if message["role"] == "system")
        assert "Harmony" in prompt and "Keep the lead free for research" in prompt, prompt
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        result = {"id": "discovery-fixture", "object": "chat.completion.chunk", "created": 1, "model": "tiny", "choices": [{"index": 0, "delta": {"role": "assistant", "content": "Discovery remains open."}, "finish_reason": "stop"}]}
        self.wfile.write(("data: " + json.dumps(result) + "\n\ndata: [DONE]\n\n").encode())

with tempfile.TemporaryDirectory(prefix="studio-terminal-") as directory, ThreadingHTTPServer(("127.0.0.1", 0), DiscoveryProvider) as provider:
    Thread(target=provider.serve_forever, daemon=True).start()
    atexit.register(provider.shutdown)
    home = Path(directory).resolve()
    agent = home / ".pi/agent"
    agent.mkdir(parents=True)
    archive_file = agent / "session-archive.db"
    with sqlite3.connect(archive_file) as archive:
        archive.executescript("""
            CREATE TABLE sessions(id TEXT PRIMARY KEY, name TEXT, cwd TEXT, first_message TEXT, archived_at INTEGER);
            CREATE TABLE session_data(session_id TEXT PRIMARY KEY, jsonl_gzip BLOB);
            INSERT INTO sessions VALUES ('first', 'Archive run', '/fixture', 'Preserved dialogue', 2);
            INSERT INTO sessions VALUES ('second', 'Damaged entry', '/fixture', 'Failed to open', 1);
        """)
        body = json.dumps({"type": "message", "message": {"role": "user", "content": "Preserved dialogue"}})
        archive.executemany("INSERT INTO session_data VALUES (?, ?)", [("first", gzip.compress(body.encode())), ("second", b"corrupt")])
    archive.close()
    archive_before = archive_file.read_bytes()
    (agent / "models.json").write_text(json.dumps({"providers": {"fixture": {"baseUrl": f"http://127.0.0.1:{provider.server_port}/v1", "api": "openai-completions", "apiKey": "fixture", "models": [{"id": "tiny"}]}}}))
    workspace = home / "beads"
    workspace.mkdir()
    (workspace / ".beads").mkdir()
    (workspace / ".beads/metadata.json").write_text('{"dolt_mode":"server","dolt_database":"fixture"}')
    boundary = home / "bd"
    boundary.write_text('''#!/usr/bin/env python3
import json, sys
if '--readonly' not in sys.argv: raise SystemExit(31)
tasks = [
    {'id':'daily-1','title':'Studio','status':'in_progress'},
    {'id':'daily-1.1','title':'Idle compaction','status':'open','parent':'daily-1','description':'Compact settled sessions after five minutes and 60%.','acceptance_criteria':'Preserve drafts, task identity, and pending effects.'},
    {'id':'daily-1.1.1','title':'Check idle guard','status':'closed','parent':'daily-1.1'},
    {'id':'daily-1.2','title':'Deliver through Octo','status':'open','parent':'daily-1','dependencies':[{'id':'daily-1.1','dependency_type':'blocks'}]},
]
if 'sql' in sys.argv: print(json.dumps([{'branch':'main'}]))
elif 'list' in sys.argv: print(json.dumps(tasks))
elif 'show' in sys.argv: print(json.dumps([next(task for task in tasks if task['id']==sys.argv[-1])]))
''')
    boundary.chmod(0o755)
    (home / "config.json").write_text(json.dumps({"beads": {"workspace": str(workspace), "database": "fixture", "branch": "main", "executable": str(boundary)}}))
    env = {**os.environ, "HOME": str(home), "PI_CODING_AGENT_DIR": str(agent), "STUDIO_CONFIG": str(home / "config.json"), "STUDIO_STATE_DIR": str(home / "studio-state"), "TERM": "xterm-256color", "COLORTERM": "truecolor", "PI_TELEMETRY": "0", "PI_SKIP_VERSION_CHECK": "1"}
    subprocess.run([sys.executable, str(root / "scripts/configure.py"), str(root), str(agent)], env=env, check=True, stdout=subprocess.DEVNULL)
    settings_path = agent / "settings.json"
    settings = json.loads(settings_path.read_text())
    settings["retry"] = {"enabled": False, "maxRetries": 0}
    settings_path.write_text(json.dumps(settings))
    (home / "design").mkdir()
    project = home / "development/dotfiles"
    project.mkdir(parents=True)
    def git(*args):
        subprocess.run(["git", *args], cwd=project, env=env, check=True, capture_output=True)
    git("init", "--initial-branch=main")
    tracked = project / "tracked.txt"
    tracked.write_text("old\nkeep\n")
    git("add", "tracked.txt")
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture")
    tracked.write_text("new\nkeep\n")
    git("add", "tracked.txt")
    tracked.write_text("new\nkeep\nextra\n")
    (project / "untracked.txt").touch()
    seed = f"""
import {{ Discoveries }} from {json.dumps(str(root / 'discovery/store.ts'))};
import {{ SpecStatus }} from {json.dumps(str(root / 'socrates/spec.ts'))};
import {{ draftSchema }} from {json.dumps(str(root / 'lead-plan.ts'))};
const store=new Discoveries();
const record=store.create({json.dumps(str(project))}, 'terminal-fixture', 'Explore independently');
store.create({json.dumps(str(project))}, 'terminal-fixture', 'Separate research');
store.change(record.id, row=>{{
 row.specification={{status:SpecStatus.Interrogating,version:1,acceptedRevision:row.revision,draft:{{objective:'Keep the lead free for research',scope:['Independent discovery'],requirements:[{{id:'R1',outcome:'Review proposed work',acceptance:'No tasks before approval'}}],decisions:[{{id:'D1',decision:'Choose work timing',basis:'observed',evidence:'Operator workflow',disposition:'open',uncertainty:'Need timing'}}],blockingQuestions:['When should work begin?']}},exchange:{{prompt:{{decisionId:'D1',question:'When should work begin?',options:[{{label:'After review',description:'Keep discovery free'}},{{label:'Keep exploring',description:'Leave work unqueued'}}]}}}}}};
 row.leadPlan.draft=draftSchema.parse({{summary:'Review before creating tasks',tasks:[{{key:'first',title:'Keep lead available',description:'Use separate workers',acceptance:'Lead remains free',hold:false,delivery:'local',check:['bun','test'],owns:['src']}}]}});
}});
const ready=store.create({json.dumps(str(project))}, 'terminal-fixture', 'Ready discovery');
store.change(ready.id,row=>{{
 const source=store.get(record.id);
 row.specification={{...source.specification,acceptedRevision:row.revision,exchange:undefined,draft:{{...source.specification.draft,blockingQuestions:[],decisions:[{{id:'D1',decision:'Choose work timing',basis:'decided',evidence:'After review',disposition:'resolved',uncertainty:'None'}}]}}}};
}});
console.log(JSON.stringify({{discovery:record.id,ready:ready.id}}));store.close();
"""
    seeded = json.loads(subprocess.run(["bun", "--no-env-file", "-e", seed], env=env, cwd=root, text=True, capture_output=True, check=True).stdout)
    discovery_id = seeded["discovery"]
    ready_id = seeded["ready"]
    directory_label = "~/dev/dotfiles" if shutil.which("shortpath") else "~/development/dotfiles"
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 14)
    except OSError:
        font = ImageFont.load_default()
    for columns, rows in [(80, 24), (60, 20)]:
        master, slave = os.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        process = subprocess.Popen([str(root / "scripts/studio"), "lead", "--", "--offline", "--no-mcp", "--model", "fixture/tiny"], env=env, cwd=project, stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
        screen = pyte.Screen(columns, rows)
        stream = pyte.Stream(screen)
        def pump(seconds):
            import time
            until = time.monotonic() + seconds
            while time.monotonic() < until:
                if select.select([master], [], [], 0.05)[0]:
                    try:
                        stream.feed(os.read(master, 65536).decode("utf-8", errors="replace"))
                    except OSError:
                        break
        def capture(name):
            occupied = [y for y, line in enumerate(screen.display) if line.strip()]
            first = max(0, min(occupied) - 1)
            last = min(rows, max(occupied) + 2)
            image = Image.new("RGB", (columns * 9, (last - first) * 18), palette["roles"]["surface"])
            draw = ImageDraw.Draw(image)
            ansi_names = ["black", "red", "green", "brown", "blue", "magenta", "cyan", "white"]
            def color(value, fallback):
                if value == "default": return palette["roles"][fallback]
                if value in ansi_names: return palette["ansi"][ansi_names.index(value)]
                if len(value) == 6: return "#" + value
                return palette["roles"][fallback]
            for y in range(first, last):
                for x in range(columns):
                    cell = screen.buffer[y][x]
                    fg, bg = color(cell.fg, "text"), color(cell.bg, "surface")
                    if cell.reverse: fg, bg = bg, fg
                    top = (y - first) * 18
                    draw.rectangle((x * 9, top, (x + 1) * 9, top + 18), fill=bg)
                    draw.text((x * 9, top), cell.data, font=font, fill=fg)
            image.save(output / f"{name}-{columns}.png")
        try:
            for _ in range(20):
                pump(.25)
                if any("tiny" in line and "↱ main" in line for line in screen.display): break
            footer = next((line for line in screen.display if "tiny" in line and directory_label in line), "")
            assert footer and len(footer) == columns, screen.display
            assert "↱ main" in footer and "Δ1 +2 −1 ?1" in footer, screen.display
            capture("daily-driver")
            os.write(master, f"/socrates {discovery_id}\r".encode())
            pump(.5)
            if columns == 80:
                assert "When should work begin?" in "\n".join(screen.display), screen.display
                capture("discovery-question")
                os.write(master, b"\r")
                pump(1)
            else:
                # A fresh native lead resumes the recorded answer from the previous host.
                pump(1)
            with sqlite3.connect(home / "studio-state/discoveries.sqlite") as discoveries:
                record = json.loads(discoveries.execute("SELECT record FROM discoveries WHERE id=?", (discovery_id,)).fetchone()[0])
            assert record["specification"]["exchange"]["answer"]["text"] == "After review", record
            assert "graph" not in record and "approved" not in record, record
            os.write(master, b"/plan\r")
            pump(.5)
            assert "Review before creating tasks" in "\n".join(screen.display), screen.display
            capture("discovery-breakdown")
            os.write(master, b"\x1b")
            pump(.3)
            os.write(master, f"/socrates {ready_id}\r".encode())
            pump(.4)
            assert "Keep the lead free for research" in "\n".join(screen.display), screen.display
            os.write(master, b"\x1b")
            pump(.2)
            if columns == 80:
                os.write(master, b"/spec-freeze\r")
                pump(.3)
                assert "Freeze specification" in "\n".join(screen.display), screen.display
                for _ in range(12):
                    os.write(master, b"\r")
                    pump(.2)
                    with sqlite3.connect(home / "studio-state/discoveries.sqlite") as discoveries:
                        ready = json.loads(discoveries.execute("SELECT record FROM discoveries WHERE id=?", (ready_id,)).fetchone()[0])
                    if ready["specification"]["status"] == "frozen": break
                pump(.5)
            with sqlite3.connect(home / "studio-state/discoveries.sqlite") as discoveries:
                ready = json.loads(discoveries.execute("SELECT record FROM discoveries WHERE id=?", (ready_id,)).fetchone()[0])
            assert ready["specification"]["status"] == "frozen", ready
            assert "graph" not in ready, ready
            os.write(master, b"/tasks\r")
            pump(1)
            view = "\n".join(screen.display)
            assert "◐ Studio" in view and "Idle compaction" in view and "Deliver through Octo" in view, screen.display
            assert "daily-1" not in view and "Status:" not in view, screen.display
            for noise in ["navigation", "Pi can explain", "[Extensions]", "[Extension issues]", "Warning: Extension", "idle compact", "escape/ctrl+c"]:
                assert noise not in view, screen.display
            colors = {screen.buffer[y][x].fg.upper() for y in range(rows) for x in range(columns)}
            assert palette["roles"]["accent"].lstrip("#") in colors, colors
            assert "├─ ○ Idle compaction" in view and "│  └─ ● Check idle guard" in view, screen.display
            capture("tasks")
            os.write(master, b"j\r")
            pump(.5)
            view = "\n".join(screen.display)
            assert "Brief & acceptance" in view and "Execution evidence" in view, screen.display
            assert "Preserve drafts" not in view and "daily-1" not in view, screen.display
            capture("task-inspector")
            os.write(master, b"\t\t\t\r")
            pump(.3)
            assert "Preserve drafts" in "\n".join(screen.display), screen.display
            capture("task-brief")
            os.write(master, b"\x1b")
            pump(.2)
            assert any("›" in line and "Idle compaction" in line for line in screen.display), screen.display
            os.write(master, b"r")
            pump(.4)
            assert any("›" in line and "Idle compaction" in line for line in screen.display), screen.display
            os.write(master, b"\x1b")
            pump(.2)
            os.write(master, b"/archives\r")
            pump(.5)
            assert "Archive run" in "\n".join(screen.display), screen.display
            os.write(master, b"Archive run")
            pump(.2)
            assert "Damaged entry" not in "\n".join(screen.display), screen.display
            capture("archives")
            os.write(master, b"\r")
            pump(.5)
            assert "Preserved dialogue" in "\n".join(screen.display), screen.display
            capture("archive-preview")
            os.write(master, b"\x1b")
            pump(.35)
            os.write(master, b"\x1b")
            pump(.35)
            os.write(master, b"/archives Damaged\r")
            pump(.5)
            os.write(master, b"\r")
            pump(.5)
            assert "corrupt" in "\n".join(screen.display), screen.display
            os.write(master, b"\x1b")
            pump(.35)
            os.write(master, b"\x1b")
            pump(.35)
            assert archive_file.read_bytes() == archive_before
            os.write(master, b"!echo remember-cobalt\r")
            pump(.5)
            assert "remember-cobalt" in "\n".join(screen.display), screen.display
            os.write(master, b"/cd ../../design\r")
            pump(1)
            assert any("~/design" in line and "tiny" in line for line in screen.display), screen.display
            assert "remember-cobalt" in "\n".join(screen.display), screen.display
            capture("directory")
            os.write(master, b"/cd missing-directory\r")
            pump(.35)
            assert "ENOENT" in "\n".join(screen.display), screen.display
            assert any("~/design" in line and "tiny" in line for line in screen.display), screen.display
            os.write(master, b"unfinished instruction")
            pump(.2)
            assert "unfinished instruction" in "\n".join(screen.display)
        finally:
            os.close(master)
            process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)
    provider.shutdown()
print("Native Pi discovery answer/resume, breakdown review, tree selection, directory switching, and draft editing passed.")
