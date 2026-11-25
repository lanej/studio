# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte", "pillow"]
# ///
"""Native Pi fork, foreground loop, and uncertain restoration against a loopback provider."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import import_module
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tempfile
from threading import Event, Thread
import time

ui = import_module("socrates-status")
root = Path(__file__).resolve().parents[1]
requests = []
held = Event()
release = Event()
slow = False


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        requests.append(request)
        if slow:
            held.set()
            release.wait(15)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        chunk = {"id": "session-loop", "object": "chat.completion.chunk", "created": 1, "model": "tiny", "choices": [{"index": 0, "delta": {"role": "assistant", "content": f"Fixture response {len(requests)} settled."}, "finish_reason": "stop"}]}
        try:
            self.wfile.write(("data: " + json.dumps(chunk) + "\n\ndata: [DONE]\n\n").encode())
        except (BrokenPipeError, ConnectionResetError):
            pass


def run(output):
    global slow
    temp_parent = "/private/tmp" if sys.platform == "darwin" else None
    with tempfile.TemporaryDirectory(prefix="st-loop-", dir=temp_parent) as directory, ThreadingHTTPServer(("127.0.0.1", 0), Provider) as provider:
        home = Path(directory).resolve()
        agent = home / ".pi/agent"
        agent.mkdir(parents=True)
        project = home / "project"
        project.mkdir()
        subprocess.run(["git", "init", "--initial-branch=main", str(project)], check=True, capture_output=True, timeout=30)
        (home / "config.json").write_text("{}")
        (agent / "models.json").write_text(json.dumps({"providers": {"fixture": {"baseUrl": f"http://127.0.0.1:{provider.server_port}/v1", "api": "openai-completions", "apiKey": "fixture", "models": [{"id": "tiny"}]}}}))
        env = {**os.environ, "HOME": str(home), "PI_CODING_AGENT_DIR": str(agent), "STUDIO_CONFIG": str(home / "config.json"), "STUDIO_STATE_DIR": str(home / "state"), "TERM": "xterm-256color", "COLORTERM": "truecolor", "PI_TELEMETRY": "0", "PI_SKIP_VERSION_CHECK": "1"}
        subprocess.run([sys.executable, str(root / "scripts/configure.py"), str(root), str(agent)], env=env, check=True, stdout=subprocess.DEVNULL, timeout=30)
        fixture = home / "fixture.ts"
        probe_file = home / "editor-probe.json"
        fixture.write_text("""import { writeFileSync } from "node:fs";
export default function(pi) {
  let settled = 0;
  let timer;
  pi.on("session_start", (_event, ctx) => {
    let previous;
    timer = setInterval(() => {
      const snapshot = JSON.stringify({ session: ctx.sessionManager.getSessionId(), text: ctx.ui.getEditorText(), idle: ctx.isIdle() });
      if (snapshot !== previous) { writeFileSync(PROBE_FILE, snapshot); previous = snapshot; }
    }, 10);
    timer.unref();
  });
  pi.on("session_shutdown", () => { clearInterval(timer); });
  pi.on("agent_settled", (_event, ctx) => { pi.appendEntry("fixture:settled", {session: ctx.sessionManager.getSessionId(), sequence: ++settled}); });
  pi.registerCommand("fixture-dialog", {handler: async (_arg, ctx) => { await ctx.ui.input("Loop admission dialog", "Leave open to verify admission"); }});
}
""".replace("PROBE_FILE", json.dumps(str(probe_file))))
        settings = json.loads((agent / "settings.json").read_text())
        settings.setdefault("extensions", []).append(str(fixture))
        (agent / "settings.json").write_text(json.dumps(settings))
        source = """
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {Discoveries} from './discovery/store.ts';
const session=SessionManager.create(PROJECT);
const user=text=>session.appendMessage({role:'user',content:text,timestamp:Date.now()});
const assistant=text=>session.appendMessage({role:'assistant',content:[{type:'text',text}],api:'openai-completions',provider:'fixture',model:'tiny',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()});
user('Original start'); assistant('Original response retained.');
session.appendSessionInfo('Original conversation');
const db=new Discoveries(); const discovery=db.create(PROJECT,session.getSessionId(),'Parent approved discovery');db.change(discovery.id,row=>{row.approved='fixture-approved';});db.close();
const point=session.appendCustomEntry('studio:discovery',{id:discovery.id,project:PROJECT,session:session.getSessionId()});
user('Original later continuation'); assistant('Original later answer retained.');
console.log(JSON.stringify({session:session.getSessionFile(),point,discovery:discovery.id}));
""".replace("PROJECT", json.dumps(str(project)))
        seed = json.loads(subprocess.run(["bun", "--no-env-file", "-e", source], env=env, cwd=root, text=True, capture_output=True, check=True, timeout=30).stdout)
        session = seed["session"]
        original = Path(session).read_text()
        Thread(target=provider.serve_forever, daemon=True).start()
        terminal = ui.Terminal(project, env, output, session, columns=120, rows=42)

        def editor():
            try:
                return json.loads(probe_file.read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                return {}

        def wait_for_editor(text, session_id=None):
            terminal.wait(lambda: editor().get("text") == text and (session_id is None or editor().get("session") == session_id), f"Public editor state did not become {text!r} in session {session_id!r}; observed {editor()!r}")

        def command(text):
            if text.startswith("/"):
                # Clear through the native editor: forks can restore selected
                # text after their session-start widgets have already rendered.
                terminal.send("\x15")
                wait_for_editor("")
            terminal.send(text)
            wait_for_editor(text)
            terminal.send("\r")
            wait_for_editor("")

        def start():
            if record()["needsInspection"]:
                command("/loop status")
                command("/loop resume inspected")
            else:
                command("/loop start")

        def entries(path):
            return [json.loads(line) for line in path.read_text().splitlines()]

        def wait_for_settled(path, sequence):
            terminal.wait(lambda: any(entry.get("customType") == "fixture:settled" and entry["data"]["session"] == entries(path)[0]["id"] and entry["data"]["sequence"] >= sequence for entry in entries(path)), f"Run {sequence} did not durably settle in {path.name}")

        def discoveries():
            with sqlite3.connect(home / "state/discoveries.sqlite") as db:
                return [json.loads(row[0]) for row in db.execute("SELECT record FROM discoveries")]

        def record():
            with sqlite3.connect(home / "state/prompt-loops.sqlite") as db:
                rows = db.execute("SELECT record FROM loops").fetchall()
            assert len(rows) == 1, rows
            return json.loads(rows[0][0])

        try:
            terminal.contains("Original later answer retained.")
            original = Path(session).read_text()
            command("/fork")
            terminal.contains("Original later continuation")
            terminal.send("\r")
            terminal.contains("Fork parent:")
            # session_start widgets precede Pi's selected-message restoration.
            # Observe that restoration in the child's public editor before typing.
            children = []
            def child_created():
                nonlocal children
                children = [path for path in Path(session).parent.glob("*.jsonl") if path != Path(session) and json.loads(path.read_text().splitlines()[0]).get("parentSession") == session]
                return len(children) == 1
            terminal.wait(child_created, "Fork did not create exactly one child session")
            child_id = entries(children[0])[0]["id"]
            wait_for_editor("Original later continuation", child_id)
            terminal.send("\x15Child independent continuation\r")
            terminal.contains("Fixture response 1 settled.")
            children = [path for path in Path(session).parent.glob("*.jsonl") if path != Path(session) and json.loads(path.read_text().splitlines()[0]).get("parentSession") == session]
            assert len(children) == 1, children
            child_entries = [json.loads(line) for line in children[0].read_text().splitlines()]
            relation = [entry for entry in child_entries if entry.get("customType") == "studio:session-fork"][-1]
            assert relation["data"]["branchPoint"] == seed["point"], relation
            selection = [entry for entry in child_entries if entry.get("customType") == "studio:discovery"][-1]
            assert selection["data"]["id"] is None, selection
            assert "Child independent continuation" in children[0].read_text()
            assert "Original later answer retained." not in children[0].read_text()
            assert Path(session).read_text() == original
            # Rendered response text can precede final agent settlement. Starting
            # a command earlier can send it as queued conversational input.
            wait_for_settled(children[0], 1)
            # Recreate a late selected-message prefill through native typing.
            # Command admission must clear it rather than append a slash command.
            terminal.send("Original later continuation")
            wait_for_editor("Original later continuation", child_id)
            command("/plan-draft Child fork discovery")
            try:
                terminal.wait(lambda: len(discoveries()) == 2 and any(row["id"] != seed["discovery"] and row["conversation"] == child_entries[0]["id"] and "approved" not in row for row in discoveries()), "Child /plan-draft did not create exactly one isolated durable discovery")
                terminal.contains("Fixture response 2 settled.")
                wait_for_settled(children[0], 2)
            except AssertionError as error:
                diagnostic = {"records": discoveries(), "childEntries": entries(children[0])[-12:], "providerMessages": requests[-1].get("messages", [])[-3:] if requests else []}
                raise AssertionError(f"{error}\nChild discovery diagnostic: {json.dumps(diagnostic)}") from error
            records = discoveries()
            assert len(records) == 2, records
            expected_plan_prompt = "Draft a bounded work breakdown for operator review. Do not create tasks before /plan-approve. Child fork discovery"
            def user_text(message):
                content = message["content"]
                return content if isinstance(content, str) else "".join(item.get("text", "") for item in content)
            assert user_text(requests[0]["messages"][-1]) == "Child independent continuation"
            assert user_text(requests[1]["messages"][-1]) == expected_plan_prompt, requests[1]["messages"][-1]
            child_users = [user_text(entry["message"]) for entry in entries(children[0]) if entry.get("type") == "message" and entry["message"]["role"] == "user"]
            assert child_users == ["Original start", "Child independent continuation", expected_plan_prompt], child_users
            child_record = next(row for row in records if row["id"] != seed["discovery"])
            assert child_record["conversation"] == child_entries[0]["id"]
            assert "approved" not in child_record
            terminal.capture("session-fork-child")
            command("/resume")
            terminal.send("Original conversation")
            terminal.pump(.3)
            terminal.send("\x1b[B\r")
            terminal.contains("Original later answer retained.")
            command("/loop configure 0.25 Repeat fixture progress")
            terminal.contains("Loop paused")
            start()
            terminal.wait(lambda: len(requests) >= 4, "Loop did not execute twice")
            terminal.wait(lambda: record()["count"] >= 2, "Loop did not durably settle twice")
            command("/loop stop")
            terminal.contains("Loop stopped")
            stopped = len(requests)
            terminal.pump(.8)
            assert len(requests) == stopped
            terminal.capture("session-loop-stopped")
            # An unsent native editor draft must be preserved across every due timer.
            start()
            terminal.send("Unsent operator draft")
            before = len(requests)
            terminal.pump(.8)
            assert len(requests) == before
            assert "Unsent operator draft" in terminal.text()
            terminal.send("\x15/loop stop\r")
            # Any native selector input pauses future dispatch before its editor opens.
            start()
            command("/settings")
            terminal.pump(.5)
            assert record()["state"] == "paused"
            before = len(requests)
            terminal.pump(.8)
            assert len(requests) == before
            terminal.send("\x1b")
            command("/loop stop")
            terminal.resize(60, 30)
            terminal.contains("Loop stopped")
            terminal.contains("Repeat fixture progress")
            terminal.capture("session-loop-narrow")
            terminal.resize(120, 42)
            # A real extension input dialog blocks admission.
            start()
            command("/fixture-dialog")
            terminal.contains("Loop admission dialog")
            before = len(requests)
            terminal.pump(.8)
            assert len(requests) == before
            terminal.send("\x1b")
            command("/loop stop")
            # A busy native turn plus queued operator input cannot admit a loop prompt.
            slow = True
            held.clear()
            release.clear()
            command("Manual busy turn")
            terminal.wait(held.is_set, "Manual provider turn did not start")
            before = len(requests)
            start()
            terminal.send("Queued operator input\r")
            terminal.pump(.8)
            assert len(requests) == before
            assert record()["intent"] is None
            command("/loop stop")
            release.set()
            terminal.wait(lambda: len(requests) > before, "Queued native input was lost")
            terminal.pump(.5)
            assert record()["intent"] is None
            # Stop while the provider is active allows this request to settle only.
            slow = True
            held.clear()
            release.clear()
            start()
            terminal.wait(held.is_set, "Provider did not start held iteration")
            before = len(requests)
            command("/loop stop")
            assert record()["state"] == "stopped"
            assert record()["intent"] is not None
            release.set()
            terminal.wait(lambda: record()["intent"] is None, "Stopped active iteration did not settle")
            terminal.pump(.8)
            assert len(requests) == before
            # A killed host leaves an identified uncertain intent, never replayed on restore.
            held.clear()
            release.clear()
            start()
            terminal.wait(held.is_set, "Interrupted provider iteration did not start")
            pending = record()["intent"]
            assert pending is not None
            os.killpg(terminal.process.pid, signal.SIGKILL)
            terminal.process.wait(timeout=5)
            os.close(terminal.master)
            terminal = None
            release.set()
            slow = False
            before = len(requests)
            terminal = ui.Terminal(project, env, output, session, columns=120, rows=42)
            terminal.contains("Loop paused")
            terminal.contains("Uncertain/pending")
            terminal.pump(1)
            assert len(requests) == before
            assert record()["intent"] == pending
            settled_before_manual = record()["count"]
            command("Manual recovery inspection")
            terminal.wait(lambda: len(requests) == before + 1, "Manual recovery inspection did not reach provider")
            terminal.contains(f"Fixture response {before + 1} settled.")
            assert record()["intent"] == pending
            assert record()["count"] == settled_before_manual
            before = len(requests)
            command("/loop status")
            terminal.contains("inspection does not prove provider completion")
            terminal.capture("session-loop-recovery")
            command("/loop resume inspected")
            terminal.wait(lambda: len(requests) > before, "Explicit inspected resume did not dispatch a new iteration")
            command("/loop stop")
            assert record()["intent"] is None or record()["intent"]["id"] != pending["id"]
            with sqlite3.connect(home / "state/discoveries.sqlite") as db:
                parent = json.loads(db.execute("SELECT record FROM discoveries WHERE id=?", (seed["discovery"],)).fetchone()[0])
            assert parent["approved"] == "fixture-approved"
            with sqlite3.connect(home / "state/prompt-loops.sqlite") as db:
                journal = [json.loads(row[0]) for row in db.execute("SELECT record FROM iterations")]
            uncertain = [row for row in journal if row["id"] == pending["id"]]
            assert len(uncertain) == 1 and uncertain[0]["state"] == "uncertain" and "acknowledgedAt" in uncertain[0], uncertain
            print(json.dumps({"providerRequests": len(requests), "settledLoopIterations": record()["count"], "iterationJournalEntries": len(journal), "forkPointVerified": True, "parentUnchangedAtFork": True, "childDiscoveryIsolated": True, "nativeSelectorPaused": True, "draftPreserved": True, "queuedInputRetained": True, "stoppedActiveTurnSettled": True, "uncertainIntentPreservedAndAcknowledged": True, "automaticReplayRequests": 0}), flush=True)
        finally:
            release.set()
            if terminal is not None:
                terminal.close()
            provider.shutdown()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path)
    run(parser.parse_args().output)
    print("Native session fork/return, visible repeated loop, draft/dialog guards, stop during turn, and uncertain restore passed.")
