# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte", "pillow"]
# ///
"""Exercise direct coding and a private work plan in the same native Studio session."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from local_provider import tool_delta
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from threading import Thread

from importlib import import_module

ui = import_module("socrates-status")
root = Path(__file__).resolve().parents[1]
coding_request = "Write the word ready to greeting.txt in this checkout and run a shell check on the result."
request_text = "Please prepare a work plan for the requested change. Save the draft for my review; do not execute it."
proposal = {"summary": "Prepare the requested change", "tasks": [{
    "key": "change", "title": "Implement the requested change",
    "description": "Make the bounded change after operator approval.",
    "acceptance": "The native acceptance check passes.",
    "assignment": {"capability": "standard", "reasoning": "off"},
}]}
requests = []
errors = []


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        errors.append(f"Unexpected integration request: {self.path}")
        self.send_error(404)

    def do_POST(self):
        requests.append(self.path)
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path != "/v1/chat/completions":
            errors.append(f"Unexpected mutation request: {self.path}")
            self.send_error(400)
            return
        last = request["messages"][-1]
        names = {tool["function"]["name"] for tool in request.get("tools", [])}
        user = next(message for message in reversed(request["messages"]) if message["role"] == "user")
        if coding_request in str(user["content"]):
            assert {"read", "write", "edit", "bash"} <= names, names
            if last["role"] == "user":
                delta = tool_delta("native-write", "write", {"path": "greeting.txt", "content": "ready\n"})
            elif last.get("tool_call_id") == "native-write":
                delta = tool_delta("native-check", "bash", {"command": "grep -x ready greeting.txt"})
            else:
                assert last.get("tool_call_id") == "native-check" and "ready" in str(last["content"]), last
                delta = {"role": "assistant", "content": "Verified greeting.txt in this checkout."}
        else:
            assert request_text in str(user["content"]), user
            if last["role"] == "user":
                assert "draft_implementation_plan" in names, names
                delta = tool_delta("private-draft", "draft_implementation_plan", proposal)
            else:
                assert last["role"] == "tool" and "Draft saved" in str(last["content"]), last
                assert "/plan-approve" not in str(last["content"]), last
                delta = {"role": "assistant", "content": "The work plan is saved for your review. Use /plan to inspect it."}
        finish = "tool_calls" if "tool_calls" in delta else "stop"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        chunk = {"id": "conversation-plan", "object": "chat.completion.chunk", "created": 1, "model": "tiny", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
        self.wfile.write(("data: " + json.dumps(chunk) + "\n\ndata: [DONE]\n\n").encode())


def run(output):
    temp_parent = "/private/tmp" if sys.platform == "darwin" else None
    with tempfile.TemporaryDirectory(prefix="st-plan-", dir=temp_parent) as directory, ThreadingHTTPServer(("127.0.0.1", 0), Provider) as provider:
        home = Path(directory).resolve()
        agent = home / ".pi/agent"
        agent.mkdir(parents=True)
        project = home / "project"
        project.mkdir()
        subprocess.run(["git", "init", "--initial-branch=main", str(project)], check=True, capture_output=True, timeout=30)
        (home / "config.json").write_text(json.dumps({"beadsService": {
            "url": f"http://127.0.0.1:{provider.server_port}",
            "projectId": "a937016c-0f84-46a8-b579-333cbf926866",
        }}))
        (agent / "models.json").write_text(json.dumps({"providers": {"fixture": {"baseUrl": f"http://127.0.0.1:{provider.server_port}/v1", "api": "openai-completions", "apiKey": "fixture", "models": [{"id": "tiny"}]}}}))
        env = {**os.environ, "HOME": str(home), "PI_CODING_AGENT_DIR": str(agent), "STUDIO_CONFIG": str(home / "config.json"), "STUDIO_STATE_DIR": str(home / "state"), "TERM": "xterm-256color", "COLORTERM": "truecolor", "PI_TELEMETRY": "0", "PI_SKIP_VERSION_CHECK": "1"}
        subprocess.run([sys.executable, str(root / "scripts/configure.py"), str(root), str(agent)], env=env, check=True, stdout=subprocess.DEVNULL, timeout=30)
        source = f"import {{SessionManager}} from '@earendil-works/pi-coding-agent'; const session=SessionManager.create({json.dumps(str(project))}); session.appendMessage({{role:'user',content:'Fresh conversation',timestamp:Date.now()}}); console.log(session.getSessionFile());"
        session = subprocess.run(["bun", "--no-env-file", "-e", source], env=env, cwd=root, text=True, capture_output=True, check=True, timeout=30).stdout.strip()
        Thread(target=provider.serve_forever, daemon=True).start()
        terminal = ui.Terminal(project, env, output, session)
        try:
            terminal.wait(lambda: any("▸ ~/project" in line and "tiny" in line for line in terminal.screen.display), "Native lead did not initialize")
            terminal.contains("Fresh conversation")
            terminal.send(coding_request + "\r")
            terminal.contains("Verified greeting.txt in this checkout.")
            assert (project / "greeting.txt").read_text() == "ready\n"
            if output is not None:
                terminal.resize(100, 26)
                terminal.capture("direct-coding")
                terminal.resize(ui.wide_columns, ui.wide_rows)
            database = home / "state/discoveries.sqlite"
            if database.exists():
                with sqlite3.connect(database) as db:
                    assert db.execute("SELECT count(*) FROM discoveries").fetchone()[0] == 0
            terminal.send(request_text + "\r")
            terminal.contains("The work plan is saved for your review")
            assert not errors, errors
            with sqlite3.connect(database) as db:
                records = [json.loads(row[0]) for row in db.execute("SELECT record FROM discoveries")]
            assert len(records) == 1, records
            record = records[0]
            assert record["project"] == str(project), record
            assert record["leadPlan"]["draft"]["summary"] == proposal["summary"], record
            assert not any(field in record for field in ("approved", "graph", "handoff")), record
            entries = [json.loads(line) for line in Path(session).read_text().splitlines()]
            marker = [entry for entry in entries if entry.get("customType") == "studio:discovery"]
            assert len(marker) == 1 and marker[0]["data"]["id"] == record["id"], marker
            assert record["conversation"] == entries[0]["id"], record
            terminal.send("/plan-approve\r")
            terminal.contains("Start /socrates and freeze")
            terminal.send("/tasks\r")
            terminal.contains("Approve a Socrates plan")
            terminal.send("/plan\r")
            terminal.contains("Enter details")
            terminal.contains("Implement the requested change")
            terminal.capture("conversation-plan-inspect")
            terminal.send("\r")
            terminal.contains("The native acceptance check passes.")
            terminal.capture("conversation-plan-task")
            runtime = home / "state/runtime.sqlite"
            if runtime.exists():
                with sqlite3.connect(runtime) as db:
                    assert db.execute("SELECT count(*) FROM records").fetchone()[0] == 0
            assert requests == ["/v1/chat/completions"] * 5, requests
            assert not errors, errors
        finally:
            terminal.close()
            provider.shutdown()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path)
    run(parser.parse_args().output)
    print("Native Studio wrote and checked a file, then saved and inspected a private plan without contacting Beads or starting workers.")
