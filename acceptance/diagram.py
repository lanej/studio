# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte", "pillow"]
# ///
"""Exercise the diagram tool, user selection, and transcript replay in a native lead."""
import argparse
from contextlib import ExitStack
from http.server import ThreadingHTTPServer
from importlib import import_module
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from threading import Thread

from local_provider import Provider, tool_delta
from socrates_fixture import message_text

ui = import_module("socrates-status")
root = Path(__file__).resolve().parents[1]
flow = {
    "title": "Delivery scan review",
    "nodes": [
        {"id": "scan", "label": "Receive scan", "detail": "Read the scan time and location."},
        {"id": "check", "label": "Check history", "detail": "Compare the scan with the last known handoff."},
        {"id": "release", "label": "Release payout", "detail": "The prior scans support the delivery."},
        {"id": "hold", "label": "Hold for review", "detail": "Conflicting scans need a second look."},
    ],
    "edges": [
        {"from": "scan", "to": "check"},
        {"from": "check", "to": "release", "label": "plausible"},
        {"from": "check", "to": "hold", "label": "conflict"},
    ],
}
question = "Which step should we discuss?"
overview = "Show me how a delivery scan could affect a payout."


class DiagramProvider(Provider):
    requests = []

    def respond(self, request):
        last = request["messages"][-1]
        if last["role"] == "user":
            assert "show_diagram" in {tool["function"]["name"] for tool in request["tools"]}
            prompt = message_text(last)
            if prompt == overview:
                return tool_delta("overview", "show_diagram", flow)
            call = {"Let me choose a step.": "choose", "Ask me again.": "dismiss"}[prompt]
            return tool_delta(call, "show_diagram", {**flow, "question": question})

        assert last["role"] == "tool", last
        call = last["tool_call_id"]
        result = message_text(last)
        if call == "choose":
            assert "check" in result.lower(), result
        reply = {
            "overview": "A conflicting scan sends the payout to review.",
            "choose": "Let's look at the scan history.",
            "dismiss": "We can leave that decision open.",
        }[call]
        return {"role": "assistant", "content": reply}


def wait_for_turn(terminal, text):
    terminal.wait(lambda: text in " ".join(terminal.text().split()), f"Missing {text!r}", timeout=30)


def run(output):
    with (
        tempfile.TemporaryDirectory(prefix="studio-diagram-") as temporary,
        ThreadingHTTPServer(("127.0.0.1", 0), DiagramProvider) as provider,
        ExitStack() as cleanup,
    ):
        home = Path(temporary).resolve()
        project = home / "project"
        project.mkdir()
        agent = home / ".pi/agent"
        agent.mkdir(parents=True)
        config = home / "config.json"
        config.write_text("{}")
        (agent / "models.json").write_text(json.dumps({"providers": {"fixture": {
            "baseUrl": f"http://127.0.0.1:{provider.server_port}/v1",
            "api": "openai-completions", "apiKey": "fixture", "models": [{"id": "tiny"}],
        }}}))
        env = {**os.environ, "HOME": str(home), "PI_CODING_AGENT_DIR": str(agent),
               "STUDIO_CONFIG": str(config), "STUDIO_STATE_DIR": str(home / "state"),
               "TERM": "xterm-256color", "COLORTERM": "truecolor", "PI_SKIP_VERSION_CHECK": "1",
               "PI_TELEMETRY": "0"}
        subprocess.run([sys.executable, str(root / "scripts/configure.py"), str(root)], env=env,
                       check=True, stdout=subprocess.DEVNULL, timeout=30)
        session = home / "conversation.jsonl"
        thread = Thread(target=provider.serve_forever, daemon=True)
        thread.start()
        cleanup.callback(thread.join, 5)
        cleanup.callback(provider.shutdown)
        terminal = ui.Terminal(project, env, output, session, columns=80, rows=26)
        try:
            terminal.wait(
                lambda: any("~/project" in line and "tiny" in line for line in terminal.screen.display),
                "Studio lead did not initialize", timeout=30,
            )
            terminal.send(overview + "\r")
            wait_for_turn(terminal, "A conflicting scan sends the payout to review.")
            for label in ("Delivery scan review", "Receive scan", "Hold for review"):
                terminal.contains(label)
            terminal.resize(60, 22)
            terminal.contains("Hold for review")
            terminal.capture("diagram")
            terminal.resize(80, 24)
            terminal.send("Let me choose a step.\r")
            wait_for_turn(terminal, question)
            terminal.contains("Enter choose")
            terminal.send("\x1b[B")
            terminal.contains("Compare the scan")
            terminal.capture("diagram-picker")
            terminal.send("l")
            terminal.contains("Compare the scan with the last known handoff.")
            terminal.send("\r")
            wait_for_turn(terminal, "Let's look at the scan history.")
            terminal.send("Ask me again.\r")
            wait_for_turn(terminal, question)
            terminal.contains("Enter choose")
            terminal.send("\x1b")
            wait_for_turn(terminal, "We can leave that decision open.")
        finally:
            terminal.close()

        entries = [json.loads(line).get("message", {}) for line in session.read_text().splitlines()]
        receipts = {m["toolCallId"]: m["details"] for m in entries if m.get("role") == "toolResult"}
        assert receipts["overview"]["status"] == "displayed", receipts
        assert receipts["choose"]["status"] == "selected" and receipts["choose"]["nodeId"] == "check", receipts
        assert receipts["dismiss"]["status"] == "dismissed" and "nodeId" not in receipts["dismiss"], receipts
        # Restoring the branch and reopening a diagram is read-only; neither operation asks the provider again.
        restored = ui.Terminal(project, env, output, session, columns=60, rows=30)
        try:
            wait_for_turn(restored, "We can leave that decision open.")
            restored.send("/diagram\r")
            restored.contains("Enter details")
            restored.contains("Check history")
            restored.send("\x1b")
            restored.wait(lambda: "Enter details" not in restored.text(), "Inspector did not close")
            wait_for_turn(restored, "We can leave that decision open.")
            restored.send("\x0f")
            restored.contains("Conflicting scans need a second look.")
            assert len(DiagramProvider.requests) == 6
        finally:
            restored.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path)
    run(parser.parse_args().output)
    print("Native diagram rendering, expansion, selection, dismissal, and replay passed.")
