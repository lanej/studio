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
import sqlite3
import struct
import subprocess
import sys
import tempfile
import termios
import time

import pyte
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[1]
build_output = root / ".aot"
parser = argparse.ArgumentParser()
parser.add_argument("--output", type=Path, default=build_output / "terminal",
                    help="capture directory (default: .aot/terminal)")
mode = parser.add_mutually_exclusive_group()
mode.add_argument("--task-review", action="store_true", help="exercise empty projects and managed task reviews at both widths")
mode.add_argument("--discovery-only", action="store_true", help="exercise discovery in fresh Pi sessions")
args = parser.parse_args()
output = args.output.resolve()
palette = json.loads((root / "resources/colors.json").read_text())
theme = json.loads((root / "resources/theme.json").read_text())["colors"]
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
            "/v0/beads/dependencies": {"items": [], "missing": []},
            **{f"/v0/beads/issues/{task['id']}": task for task in review_tasks},
        }
        if path == "/v0/beads/issues":
            self.server.issue_reads += 1
            status, body = self.server.issue_listing
        else:
            status, body = (200, pages[path]) if path in pages else (404, {})
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def do_POST(self):
        self.server.responses += 1
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        prompt = "\n".join(str(message.get("content", "")) for message in request["messages"] if message["role"] == "system")
        if args.task_review:
            last_user = next(str(message["content"]) for message in reversed(request["messages"]) if message["role"] == "user")
            assert review_question in last_user, last_user
            answer = review_answer
        else:
            assert "Harmony" in prompt and "Selected discovery · " in prompt, prompt
            discovery_context = prompt.rsplit("Selected discovery · ", 1)[1]
            title = discovery_context.splitlines()[0]
            user_message = next(message for message in reversed(request["messages"]) if message["role"] == "user")
            resumed = "Resume Socrates discovery" in str(user_message.get("content"))
            if title == "Explore independently":
                assert "Keep the lead free for research" in discovery_context, prompt
                if resumed:
                    assert "Operator answer · After review" in discovery_context, prompt
            action = "Discovery resumed" if resumed else "Discovery remains open"
            answer = f"{action}: {title}."
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        result = {"id": "discovery-fixture", "object": "chat.completion.chunk", "created": 1, "model": "tiny", "choices": [{"index": 0, "delta": {"role": "assistant", "content": answer}, "finish_reason": "stop"}]}
        self.wfile.write(("data: " + json.dumps(result) + "\n\ndata: [DONE]\n\n").encode())

with tempfile.TemporaryDirectory(prefix="studio-terminal-") as directory, ThreadingHTTPServer(("127.0.0.1", 0), DiscoveryProvider) as provider:
    provider.issue_listing = (200, {"items": review_tasks, "has_more": False})
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
    if args.task_review:
        config = {"beadsService": {"projectId": review_project, "url": f"http://127.0.0.1:{provider.server_port}"}}
    else:
        config = {"beads": {"workspace": str(workspace), "database": "fixture", "branch": "main", "executable": str(boundary)}}
    (home / "config.json").write_text(json.dumps(config))
    env = {**os.environ, "HOME": str(home), "PI_CODING_AGENT_DIR": str(agent), "STUDIO_CONFIG": str(home / "config.json"), "STUDIO_STATE_DIR": str(home / "studio-state"), "TERM": "xterm-256color", "COLORTERM": "truecolor", "PI_TELEMETRY": "0", "PI_SKIP_VERSION_CHECK": "1"}
    for kind in ("CACHE", "CONFIG", "DATA", "STATE"):
        env[f"XDG_{kind}_HOME"] = str(home / f"xdg-{kind.lower()}")
    subprocess.run([sys.executable, str(root / "scripts/configure.py"), str(root), str(agent)], env=env, check=True, stdout=subprocess.DEVNULL)
    settings_path = agent / "settings.json"
    settings = json.loads(settings_path.read_text())
    settings["retry"] = {"enabled": False, "maxRetries": 0}
    settings_path.write_text(json.dumps(settings))
    design = home / "design"
    design.mkdir()
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
store.create({json.dumps(str(workspace))}, 'terminal-fixture', 'Foreign discovery');
store.change(record.id, row=>{{
 row.specification={{status:SpecStatus.Interrogating,version:1,acceptedRevision:row.revision,draft:{{objective:'Keep the lead free for research',scope:['Independent discovery'],requirements:[{{id:'R1',outcome:'Review proposed work',acceptance:'No tasks before approval'}}],decisions:[{{id:'D1',decision:'Choose work timing',basis:'observed',evidence:'Operator workflow',disposition:'open',uncertainty:'Need timing'}}],blockingQuestions:['When should work begin?']}},exchange:{{prompt:{{decisionId:'D1',question:'When should work begin?',options:[{{label:'After review',description:'Keep discovery free'}},{{label:'Keep exploring',description:'Leave work unqueued'}}]}}}}}};
 row.leadPlan.draft=draftSchema.parse({{summary:'Review before creating tasks',tasks:[
   {{key:'first',title:'Keep lead available',description:'Use separate workers',acceptance:'Lead remains free',hold:false,delivery:'local',check:['bun','test'],owns:['src']}},
   {{key:'verify',title:'Check the review flow',description:'Exercise the lead during review',acceptance:'Work starts after review',requirements:['R1'],blockedBy:['first']}}
 ]}});
}});
const ready=store.create({json.dumps(str(project))}, 'terminal-fixture', 'Explore independently');
store.change(ready.id,row=>{{
 const source=store.get(record.id);
 row.specification={{...source.specification,acceptedRevision:row.revision,exchange:undefined,draft:{{...source.specification.draft,blockingQuestions:[],decisions:[{{id:'D1',decision:'Choose work timing',basis:'decided',evidence:'After review',disposition:'resolved',uncertainty:'None'}}]}}}};
}});
console.log(JSON.stringify({{discovery:record.id,ready:ready.id}}));store.close();
"""
    seeded = json.loads(subprocess.run(["bun", "--no-env-file", "-e", seed], env=env, cwd=root, text=True, capture_output=True, check=True).stdout)
    discovery_id = seeded["discovery"]
    ready_id = seeded["ready"]
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
    provider.issue_reads = 0
    provider.responses = 0
    font_size = 18 if args.task_review else 14
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", font_size)
        bold = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", font_size, index=1)
    except OSError:
        font = ImageFont.truetype("DejaVuSansMono.ttf", font_size)
        bold = ImageFont.truetype("DejaVuSansMono-Bold.ttf", font_size)
    cell_width, cell_height = (11, 23) if args.task_review else (9, 18)
    wide_viewport = (100, 26) if args.discovery_only else (80, 24)
    viewports = [wide_viewport, (60, 20)]
    cases = [(columns, rows, project) for columns, rows in viewports]
    if not args.task_review:
        cases.insert(0, (*wide_viewport, design))
    for columns, rows, cwd in cases:
        master, slave = os.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        process = subprocess.Popen([str(root / "scripts/studio"), "lead", "--", "--offline", "--no-mcp", "--model", "fixture/tiny"], env=env, cwd=cwd, stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
        screen = pyte.Screen(columns, rows)
        stream = pyte.ByteStream(screen)
        def pump(seconds):
            until = time.monotonic() + seconds
            while time.monotonic() < until:
                if select.select([master], [], [], 0.05)[0]:
                    try:
                        data = os.read(master, 65536)
                        if not data:
                            break
                        stream.feed(data)
                    except OSError:
                        break
        def wait_until(predicate, timeout=12):
            until = time.monotonic() + timeout
            while time.monotonic() < until:
                pump(.05)
                if predicate():
                    return
                if process.poll() is not None:
                    break
            raise AssertionError("\n".join(screen.display))
        def capture(name, start_at=None):
            occupied = [y for y, line in enumerate(screen.display) if line.strip()]
            start = min(occupied) if start_at is None else next(
                y for y, line in enumerate(screen.display) if start_at in line
            )
            first = max(0, start - 1)
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
            destination = output / f"{filename}.png"
            # Replace the capture itself, never write through an existing link.
            with tempfile.TemporaryDirectory(prefix=".capture-", dir=output) as staging:
                staged = Path(staging) / destination.name
                image.save(staged)
                staged.replace(destination)
        def wait_text(text, timeout=12):
            import time
            end = time.monotonic() + timeout
            while text not in "\n".join(screen.display) and time.monotonic() < end:
                if process.poll() is not None:
                    raise AssertionError(f"Studio exited with {process.returncode} waiting for {text!r}: {screen.display}")
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
                wait_text("tiny", timeout=45)
                pump(.5)
                os.write(master, (review_question + "\r").encode())
                wait_text("unified diff.")
                pump(.2)
                restore_transcript()
                provider.issue_listing = (200, {"items": [], "has_more": False})
                os.write(master, b"/tasks\r")
                wait_text("No tasks yet")
                empty_view = "\n".join(screen.display)
                for label in ["Tasks", "/plan-draft <description>", "Alt+T inspect"]:
                    assert label in empty_view, empty_view
                assert review_project not in empty_view, empty_view
                assert "Tasks · Beads" in empty_view, empty_view
                assert "Review finding" not in empty_view and "Changes requested" not in empty_view, empty_view
                assert all(task["title"] not in empty_view for task in review_tasks), empty_view
                capture("task-empty")
                os.write(master, b"/tasks close\r")
                pump(.35)
                assert "No tasks yet" not in "\n".join(screen.display), screen.display

                provider.issue_listing = (200, {"items": review_tasks, "has_more": False})
                os.write(master, b"/tasks\r")
                wait_text("Diff presentation")
                os.write(master, b"jk background draft")
                pump(.2)
                passive = "\n".join(screen.display)
                assert any("›" in line and "Diff presentation" in line for line in screen.display), screen.display
                assert "jk background draft" in passive, passive
                capture("task-status-panel")
                completed = [dict(task, status="closed") if task["id"] == "ui-12.1" else task for task in review_tasks]
                provider.issue_listing = (200, {"items": completed, "has_more": False})
                wait_until(lambda: any("● Inline replacements" in line for line in screen.display), timeout=8)
                assert "jk background draft" in "\n".join(screen.display), screen.display
                assert "Alt+T inspect" in "\n".join(screen.display), screen.display
                capture("task-status-updated")
                # A provider response confirms the lead accepts submissions with the panel open.
                os.write(master, b"\x15")
                before_response = provider.responses
                os.write(master, (review_question + "\r").encode())
                wait_until(lambda: provider.responses > before_response)
                pump(.5)
                assert "Alt+T inspect" in "\n".join(screen.display), screen.display
                provider.issue_listing = (200, {"items": review_tasks, "has_more": False})
                os.write(master, b"\x1bt")
                wait_text("Esc lead")
                os.write(master, b"r")
                pump(.4)
                os.write(master, b"j\r")
                pump(.5)
                text = "\n".join(screen.display)
                for label in ["Inline replacements", "The reviewer found:", "chooseLayout()", "renderDiff()"]:
                    assert label in text, text
                assert "Changes requested" not in text and "Reviewing" not in text, text
                assert "activation.ts" not in text and "Extension \"" not in text, text
                capture("task-readability-review")
                os.write(master, b"\x1b")
                wait_text("Alt+T inspect")
                os.write(master, b"preserved lead draft")
                pump(.2)
                os.write(master, b"\x1bt")
                wait_text("Esc lead")
                assert "Inline replacements" in "\n".join(screen.display), screen.display
                os.write(master, b"\x1b[D")
                pump(.2)
                assert any("›" in line and "Inline replacements" in line for line in screen.display), screen.display
                os.write(master, b"q")
                pump(.3)
                assert "Alt+T inspect" not in "\n".join(screen.display), screen.display
                assert "preserved lead draft" in "\n".join(screen.display), screen.display
                os.write(master, b"\x15")
                # A direct lookup opens passively too; focus must still be explicit.
                os.write(master, b"/tasks ui-12.1\r")
                wait_text("The reviewer found:")
                assert "Alt+T inspect" in "\n".join(screen.display), screen.display
                provider.issue_listing = (503, {"code": "unavailable", "reason": "Service unavailable"})
                wait_text("Beads HTTP 503", timeout=8)
                assert "Inline replacements" in "\n".join(screen.display), screen.display
                capture("task-status-unavailable")
                provider.issue_listing = (200, {"items": review_tasks, "has_more": False})
                wait_until(lambda: "Beads HTTP 503" not in "\n".join(screen.display), timeout=8)
                os.write(master, b"/tasks close\r")
                pump(.3)
                reads = provider.issue_reads
                pump(5.3)
                assert provider.issue_reads == reads, (reads, provider.issue_reads)
                provider.issue_listing = (503, {"code": "unavailable", "reason": "Service unavailable"})
                os.write(master, b"/tasks\r")
                wait_text("Beads HTTP 503")
                assert "No tasks yet" not in "\n".join(screen.display), screen.display

                # Opening tasks never approves the existing unapproved draft.
                os.write(master, b"/discoveries\r")
                wait_text("Select a saved discovery")
                os.write(master, b"\x1b[B")
                pump(.2)
                os.write(master, b"\r")
                pump(.3)
                os.write(master, b"/socrates\r")
                wait_text("When should work begin?")
                os.write(master, b"\x1b")
                pump(.35)
                provider.issue_listing = (200, {"items": [], "has_more": False})
                os.write(master, b"/tasks\r")
                wait_text("No tasks yet")
                empty_draft = "\n".join(screen.display)
                assert "Review your draft with /plan." in empty_draft and "/plan-draft" not in empty_draft, empty_draft
                os.write(master, b"/tasks close\r")
                pump(.35)
                os.write(master, b"/plan\r")
                wait_text("Review before creating tasks")
                continue
            if cwd == design:
                wait_text("▸ ~/design")
                os.write(master, b"/discoveries\r")
                wait_text("No saved discoveries for this project.")

                def design_discoveries():
                    with sqlite3.connect(home / "studio-state/discoveries.sqlite") as discoveries:
                        return [json.loads(row[0]) for row in discoveries.execute(
                            "SELECT record FROM discoveries WHERE project=? ORDER BY rowid", (str(design),)
                        )]

                assert design_discoveries() == []
                expected_titles = []
                for title in [None, "Fix the runtime handoff", "list", "new Another topic"]:
                    command = "/socrates" if title is None else f"/socrates {title}"
                    expected_titles.append("Discovery" if title is None else title)
                    os.write(master, f"{command}\r".encode())
                    wait_text(f"Discovery remains open: {expected_titles[-1]}.")
                    records = design_discoveries()
                    assert [record["title"] for record in records] == expected_titles, records
                    assert all(record["specification"]["status"] == "interrogating" for record in records), records
                    assert all("graph" not in record and "approved" not in record for record in records), records

                # Select the oldest record from a conversation with a newer selection.
                os.write(master, b"/discoveries\r")
                wait_text("#1 Discovery")
                listing = "\n".join(screen.display)
                assert "Fix the runtime handoff" in listing, listing
                assert all(record["id"] not in listing for record in records), listing
                for _ in range(len(expected_titles) - 1):
                    os.write(master, b"\x1b[B")
                    pump(.15)
                os.write(master, b"\r")
                pump(.3)
                # Reopen and escape while the newest record is highlighted again.
                os.write(master, b"/discoveries\r")
                wait_text("#1 Discovery · interrogating · selected")
                capture("discovery-selected")
                os.write(master, b"\x1b")
                pump(.35)
                os.write(master, b"/socrates\r")
                wait_text("Discovery resumed: Discovery.")
                assert design_discoveries() == records, "Selecting and resuming must not rewrite saved records"

                # Even an argument matching an existing ID is just a title.
                os.write(master, f"/socrates {discovery_id}\r".encode())
                wait_text(f"Discovery remains open: {discovery_id}.")
                literal = design_discoveries()
                assert literal[:-1] == records and len(literal) == len(records) + 1, literal
                assert literal[-1]["title"] == discovery_id and literal[-1]["id"] != discovery_id, literal
                assert "graph" not in literal[-1] and "approved" not in literal[-1], literal
                continue

            wait_text("Δ1 +2 −1 ?1")
            footer = next((line for line in screen.display if "tiny" in line and "dotfiles" in line), "")
            assert footer and len(footer) == columns, screen.display
            assert "↱ main" in footer, screen.display
            capture("daily-driver")
            os.write(master, b"/discoveries\r")
            wait_text("Select a saved discovery")
            listing = "\n".join(screen.display)
            assert "#2 Explore independently" in listing and "#1 Explore independently" in listing, listing
            assert all(value not in listing for value in [discovery_id, ready_id, "Foreign discovery"]), listing
            os.write(master, b"\x1b[B")
            pump(.2)
            os.write(master, b"\r")
            pump(.3)
            os.write(master, b"/discoveries\r")
            wait_text("#1 Explore independently · answer saved · selected" if columns == 60 else
                          "#1 Explore independently · question open · selected")
            capture("discovery-picker", start_at="Select a saved discovery")
            os.write(master, b"\x1b")
            pump(.35)
            os.write(master, b"/socrates\r")
            if columns == wide_viewport[0]:
                wait_text("When should work begin?")
                capture("discovery-question")
                os.write(master, b"\r")
            # The narrow lead is a separate session and must reuse the saved answer.
            wait_text("Discovery resumed: Explore independently.")
            with sqlite3.connect(home / "studio-state/discoveries.sqlite") as discoveries:
                record = json.loads(discoveries.execute("SELECT record FROM discoveries WHERE id=?", (discovery_id,)).fetchone()[0])
            assert record["specification"]["exchange"]["answer"]["text"] == "After review", record
            assert "graph" not in record and "approved" not in record, record
            os.write(master, b"/plan\r")
            wait_until(lambda: all(text in "\n".join(screen.display) for text in
                                   ["Enter details", "Review before creating tasks", "Keep lead available", "Check the review flow"]))
            assert "Wave 2" not in "\n".join(screen.display), screen.display
            capture("discovery-breakdown")
            os.write(master, b"j\r")
            wait_until(lambda: all(text in "\n".join(screen.display) for text in
                                   ["Check the review flow", "Work starts after review", "Depends on · first"]))
            os.write(master, b"\x1b")
            wait_until(lambda: "Enter details" in "\n".join(screen.display))
            os.write(master, b"\x1b")
            pump(.3)
            os.write(master, b"/discoveries\r")
            wait_text("Select a saved discovery")
            os.write(master, b"\r")
            pump(.3)
            os.write(master, b"/socrates\r")
            wait_text("Keep the lead free for research")
            os.write(master, b"\x1b")
            pump(.2)
            if columns == wide_viewport[0]:
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
            if args.discovery_only:
                continue
            restore_transcript()
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
            if columns == 80:
                selected_row = next(y for y, line in enumerate(screen.display) if "›" in line and "◐ Studio" in line)
                assert screen.buffer[selected_row][columns-3].bg.upper() == theme["userMessageBg"].lstrip("#"), screen.display
            capture("tasks")
            os.write(master, b"\x1bt")
            wait_text("Esc lead")
            os.write(master, b"j\r")
            pump(.5)
            view = "\n".join(screen.display)
            assert "Brief & acceptance" in view and "Execution evidence" in view, screen.display
            assert "Preserve drafts" not in view and "daily-1" not in view, screen.display
            capture("task-inspector")
            os.write(master, b"\t\t\t\r")
            pump(.3)
            if columns == 60:
                os.write(master, b"jjj")
                pump(.2)
            assert "Preserve drafts" in "\n".join(screen.display), screen.display
            capture("task-brief")
            os.write(master, b"\x1b[D")
            pump(.2)
            assert any("›" in line and "Idle compaction" in line for line in screen.display), screen.display
            os.write(master, b"r")
            pump(.4)
            assert any("›" in line and "Idle compaction" in line for line in screen.display), screen.display
            os.write(master, b"\x1b")
            pump(.2)
            os.write(master, b"/tasks close\r")
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
            wait_text("remember-cobalt")
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
            os.close(master)
            process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)
    provider.shutdown()
if args.task_review:
    print("Native passive task updates, retained lead input, deliberate focus/return, review details, close cleanup, and service recovery passed at 80x24 and 60x20.")
else:
    print(f"Native Pi discovery title entry, project picker, cancellation, saved-answer resume, and breakdown review passed at {wide_viewport[0]} and 60 columns.")
    if not args.discovery_only:
        print("Native Pi tree selection, archive browsing, directory switching, and draft editing passed.")
