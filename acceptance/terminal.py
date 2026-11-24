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
parser.add_argument("--task-review", action="store_true", help="Capture the managed task review on wide and narrow terminals")
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
palette = json.loads((root / "resources/colors.json").read_text())
output = Path(args.output)
output.mkdir(parents=True, exist_ok=True)

review_project = "a93fe08d-5663-4c9b-bf6e-97a846663808"
repair_id = "5aa0f531-21d0-435a-9152-51dfcbb7ce3f"
review_id = "87797acd-e225-42b6-9512-9d565a029308"
review_tasks = [
    {"id": "ui-12", "title": "Diff presentation", "status": "in_progress"},
    {"id": "ui-12.1", "parent": "ui-12", "title": "Inline replacements", "status": "in_progress", "assignee": "pi:" + repair_id,
     "description": "Show short word replacements on one line when they fit.",
     "acceptance_criteria": "A resize switches to unified layout when an inline edit no longer fits."},
    {"id": "ui-12.2", "parent": "ui-12", "title": "Enclosing declarations", "status": "in_progress", "assignee": "pi:" + review_id,
     "description": "Show the nearest enclosing declaration above each hunk."},
    {"id": "ui-12.3", "parent": "ui-12", "title": "One-sided hunks", "status": "closed"},
]
for task in review_tasks:
    task["revision"] = "r1"
review_finding = "Which function owns the width cutoff? Both `chooseLayout()` and `renderDiff()` test it. Changing one can make the same hunk switch layouts twice."
review_question = "How should these diffs read?"
review_answer = (
    "Use the shape of the change to pick the layout.\n\n"
    "- **Additions or deletions** use one full-width column.\n"
    "- **Short replacements** keep the changed words inline.\n"
    "- **Narrow terminals** fall back to a unified diff."
)

class DiscoveryProvider(BaseHTTPRequestHandler):
    def log_message(self, *_args): pass
    def do_GET(self):
        path = self.path.partition("?")[0]
        pages = {
            "/v0/beads/context": {"project_id": review_project, "backend": "dolt", "dolt_mode": "server",
                                  "capabilities": ["project.enforce", "issues.get", "issues.create", "issues.update"]},
            "/v0/beads/issues": {"items": review_tasks, "has_more": False},
            "/v0/beads/dependencies": {"items": [], "missing": []},
            **{f"/v0/beads/issues/{task['id']}": task for task in review_tasks},
        }
        self.send_response(200 if path in pages else 404)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(pages.get(path, {})).encode())

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        prompt = "\n".join(str(message.get("content", "")) for message in request["messages"] if message["role"] == "system")
        if args.task_review:
            last_user = next(str(message["content"]) for message in reversed(request["messages"]) if message["role"] == "user")
            assert review_question in last_user, last_user
            answer = review_answer
        else:
            assert "Harmony" in prompt and "Keep the lead free for research" in prompt, prompt
            answer = "Discovery remains open."
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        result = {"id": "discovery-fixture", "object": "chat.completion.chunk", "created": 1, "model": "tiny", "choices": [{"index": 0, "delta": {"role": "assistant", "content": answer}, "finish_reason": "stop"}]}
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
if 'sql' in sys.argv: print(json.dumps([{'branch':'main'}]))
elif 'list' in sys.argv: print(json.dumps([
    {'id':'daily-1','title':'Studio','status':'in_progress'},
    {'id':'daily-1.1','title':'Idle compaction','status':'open','parent':'daily-1'},
    {'id':'daily-1.1.1','title':'Check idle guard','status':'closed','parent':'daily-1.1'},
    {'id':'daily-1.2','title':'Deliver through Octo','status':'open','parent':'daily-1'},
]))
elif 'show' in sys.argv: print(json.dumps([{'id':sys.argv[-1],'title':'Idle compaction','status':'open','parent':'daily-1','description':'Compact settled sessions after five minutes and 60%.','acceptance_criteria':'Preserve drafts, task identity, and pending effects.'}]))
''')
    boundary.chmod(0o755)
    if args.task_review:
        config = {"beadsService": {"projectId": review_project, "url": f"http://127.0.0.1:{provider.server_port}"}}
    else:
        config = {"beads": {"workspace": str(workspace), "database": "fixture", "branch": "main", "executable": str(boundary)}}
    (home / "config.json").write_text(json.dumps(config))
    env = {**os.environ, "HOME": str(home), "PI_CODING_AGENT_DIR": str(agent), "STUDIO_CONFIG": str(home / "config.json"), "STUDIO_STATE_DIR": str(home / "studio-state"), "TERM": "xterm-256color", "COLORTERM": "truecolor", "PI_TELEMETRY": "0", "PI_SKIP_VERSION_CHECK": "1"}
    subprocess.run([sys.executable, str(root / "scripts/configure.py"), str(root), str(agent)], env=env, check=True, stdout=subprocess.DEVNULL)
    settings_path = agent / "settings.json"
    settings = json.loads(settings_path.read_text())
    settings["retry"] = {"enabled": False, "maxRetries": 0}
    settings_path.write_text(json.dumps(settings))
    (home / "design").mkdir()
    project = home / ("src/studio" if args.task_review else "development/dotfiles")
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
    if args.task_review:
        seed_reviews = f"""
import {{ExecutionStore, executionSchema}} from {json.dumps(str(root / 'execution/store.ts'))};
const store = new ExecutionStore();
for (const bead of {json.dumps(review_tasks)}.filter(task => task.assignee)) {{
    const repairing = bead.id === "ui-12.1";
    store.saveAttempt(executionSchema.parse({{id: bead.assignee.slice(3), project: {json.dumps(review_project)}, bead,
        profile: "personal", phase: repairing ? "running" : "reviewing", message: "",
        reviewFinding: repairing ? {json.dumps(review_finding)} : undefined}}));
}}
store.close();
"""
        subprocess.run(["bun", "--no-env-file", "-e", seed_reviews], cwd=root, env=env, check=True)
    font_size = 18 if args.task_review else 14
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", font_size)
        bold = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", font_size, index=1)
    except OSError:
        font = ImageFont.truetype("DejaVuSansMono.ttf", font_size)
        bold = ImageFont.truetype("DejaVuSansMono-Bold.ttf", font_size)
    cell_width, cell_height = (11, 23) if args.task_review else (9, 18)
    viewports = [(124, 25), (60, 24)] if args.task_review else [(100, 26), (60, 20)]
    for columns, rows in viewports:
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
            if args.task_review:
                first, last = 0, rows
            image = Image.new("RGB", (columns * cell_width, (last - first) * cell_height), palette["roles"]["surface"])
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
                    top = (y - first) * cell_height
                    left = x * cell_width
                    draw.rectangle((left, top, left + cell_width - 1, top + cell_height - 1), fill=bg)
                    draw.text((left, top), cell.data, font=bold if cell.bold else font, fill=fg)
            filename = name if args.task_review and columns == viewports[0][0] else f"{name}-{columns}"
            image.save(output / f"{filename}.png")
        def wait_text(text, timeout=12):
            import time
            end = time.monotonic() + timeout
            while text not in "\n".join(screen.display) and time.monotonic() < end:
                pump(.1)
            assert text in "\n".join(screen.display), screen.display

        def restore_transcript():
            # Rebuild the native view from recorded messages with the original display setting.
            os.write(master, b"/settings\r")
            pump(.35)
            os.write(master, b"cache miss notices")
            wait_text("Cache miss notices")
            os.write(master, b"\r")
            pump(.2)
            os.write(master, b"\r")
            pump(.15)
            os.write(master, b"\x1b")
            pump(.25)

        try:
            if args.task_review:
                wait_text("tiny")
                pump(.5)
                os.write(master, (review_question + "\r").encode())
                wait_text("unified diff.")
                pump(.2)
                restore_transcript()
                os.write(master, b"/tasks\r")
                wait_text("Diff presentation")
                os.write(master, b"j")
                pump(.4)
                text = "\n".join(screen.display)
                for label in ["Inline replacements", "Changes requested", "Reviewing", "chooseLayout()", "renderDiff()", "Acceptance criteria"]:
                    assert label in text, text
                if columns == 60:
                    assert any(line.startswith("╭") and line.endswith("╮") for line in screen.display), text
                assert "activation.ts" not in text and "Extension \"" not in text, text
                capture("task-readability-review")
                os.write(master, b"\r")
                wait_text("Scope")
                assert "Inline replacements" in "\n".join(screen.display), screen.display
                os.write(master, b"\x1b")
                pump(.35)
                assert "Review finding" not in "\n".join(screen.display), screen.display
                # A direct lookup uses the same inspector with the whole finding scrollable.
                os.write(master, b"/tasks ui-12.1\r")
                wait_text("Scope")
                assert "Inline replacements" in "\n".join(screen.display), screen.display
                os.write(master, b"\x1b")
                pump(.35)
                assert "Review finding" not in "\n".join(screen.display), screen.display
                continue
            wait_text("Δ1 +2 −1 ?1")
            footer = next((line for line in screen.display if "tiny" in line and directory_label in line), "")
            assert footer and len(footer) == columns, screen.display
            assert "↱ main" in footer and "Δ1 +2 −1 ?1" in footer, screen.display
            capture("daily-driver")
            os.write(master, f"/socrates {discovery_id}\r".encode())
            pump(.5)
            if columns == 100:
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
            if columns == 100:
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
            restore_transcript()
            os.write(master, b"/tasks\r")
            pump(1)
            rendered = "\n".join(screen.display)
            for label in ["Tasks", "Studio", "Idle compaction", "Check idle guard", "Deliver through Octo"]:
                assert label in rendered, screen.display
            for tree in ["├─ Idle compaction", "│  └─ Check idle guard", "└─ Deliver through Octo"]:
                assert tree in rendered, screen.display
            progress = [(y, line.index("◐")) for y, line in enumerate(screen.display) if "◐" in line]
            opened = [(y, line.index("○")) for y, line in enumerate(screen.display) if "○" in line]
            assert progress and opened, screen.display
            for (y, x), tone in [(progress[0], "accent"), (opened[0], "text.muted")]:
                assert x >= columns // 4, screen.display
                assert screen.buffer[y][x].fg.upper() == palette["roles"][tone].lstrip("#"), screen.display
            capture("tasks")
            os.write(master, b"j\r")
            pump(.5)
            assert "Acceptance" in "\n".join(screen.display), screen.display
            assert "Read-only observation" not in "\n".join(screen.display)
            capture("task-details")
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
            restore_transcript()
            assert "remember-cobalt" in "\n".join(screen.display), screen.display
            capture("directory")
            os.write(master, b"/cd missing-directory\r")
            pump(.35)
            assert "ENOENT" in "\n".join(screen.display), screen.display
            assert any("~/design" in line and "tiny" in line for line in screen.display), screen.display
            os.write(master, b"unfinished instruction")
            wait_text("unfinished instruction")
        finally:
            process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: process.kill(); process.wait()
            os.close(master)
    provider.shutdown()
if args.task_review:
    print("Native task review, selection, direct lookup, and return to the lead passed at both terminal widths.")
else:
    print("Native Pi discovery answer/resume, breakdown review, tree selection, directory switching, and draft editing passed.")
