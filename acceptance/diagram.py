# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte", "pillow"]
# ///
"""Exercise C4 context, container inspection, selection, and replay in a native lead."""
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
architecture = {
    "title": "Parcel tracking",
    "systemId": "visibility",
    "nodes": [
        {"id": "merchant", "kind": "person", "label": "Merchant", "detail": "Checks shipment status."},
        {"id": "visibility", "kind": "system", "label": "Parcel visibility", "detail": "Tracks a parcel across carriers."},
        {"id": "carrier", "kind": "system", "label": "Carrier network", "detail": "Publishes parcel scans."},
        {"id": "api", "kind": "container", "label": "Tracking API", "technology": "Go",
         "detail": "Serves tracking history."},
        {"id": "processor", "kind": "container", "label": "Event processor", "technology": "Rust",
         "detail": "Normalizes carrier scans."},
        {"id": "store", "kind": "container", "label": "Scan store", "technology": "PostgreSQL",
         "detail": "Stores each parcel's scan history."},
    ],
    "edges": [
        {"from": "merchant", "to": "visibility", "label": "Looks up shipments", "technology": "HTTPS"},
        {"from": "visibility", "to": "carrier", "label": "Fetches scans", "technology": "HTTPS"},
        {"from": "merchant", "to": "api", "label": "Looks up shipments", "technology": "HTTPS"},
        {"from": "processor", "to": "carrier", "label": "Fetches scans", "technology": "HTTPS"},
        {"from": "api", "to": "store", "label": "Reads history", "technology": "SQL"},
        {"from": "processor", "to": "store", "label": "Appends scans", "technology": "SQL"},
    ],
}
overview = "Show me the architecture of a parcel tracking system."
question = "Which element should we inspect?"


class DiagramProvider(Provider):
    requests = []

    def respond(self, request):
        last = request["messages"][-1]
        if last["role"] == "user":
            assert "show_diagram" in {tool["function"]["name"] for tool in request["tools"]}
            prompt = message_text(last)
            if prompt == overview:
                return tool_delta("overview", "show_diagram", architecture)
            call = {"Let me choose an element.": "choose", "Ask me again.": "dismiss"}[prompt]
            view = "container" if call == "dismiss" else "context"
            return tool_delta(call, "show_diagram", {**architecture, "view": view, "question": question})

        assert last["role"] == "tool", last
        call = last["tool_call_id"]
        result = message_text(last)
        if call == "choose":
            assert "Event processor" in result and "node ID: processor" in result, result
        reply = {
            "overview": "The merchant can follow one parcel across carriers.",
            "choose": "The event processor normalizes carrier scans.",
            "dismiss": "We can leave that decision open.",
        }[call]
        return {"role": "assistant", "content": reply}


def wait_for_turn(terminal, text):
    terminal.wait(lambda: text in " ".join(terminal.text().split()), f"Missing {text!r}", timeout=30)


def submit_prompt(terminal, text):
    terminal.send(text)
    terminal.contains(text)
    terminal.send("\r")


def focus_processor(terminal):
    # Select the element in the canvas's reading order, which changes with viewport and layout.
    terminal.send("\x1b[H")
    for _ in architecture["nodes"]:
        terminal.send("l")
        terminal.contains("↑↓ scroll")
        details = " ".join(terminal.text().split())
        if "Event processor Container · Rust" in details:
            terminal.contains("Normalizes carrier scans.")
            return
        terminal.send("\x1b")
        terminal.contains("↑↓ browse")
        terminal.send("j")
    raise AssertionError(f"Could not focus the event processor\n{terminal.text()}")


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
        terminal = ui.Terminal(project, env, output, session, columns=96, rows=20)
        try:
            terminal.wait(
                lambda: any("~/project" in line and "tiny" in line for line in terminal.screen.display),
                "Studio lead did not initialize", timeout=30,
            )
            submit_prompt(terminal, overview)
            wait_for_turn(terminal, "The merchant can follow one parcel across carriers.")
            for text in ("System context", "Merchant", "Parcel visibility", "Carrier network", "Looks up shipments", "Fetches scans"):
                terminal.contains(text)
            assert "PostgreSQL" not in terminal.text() and "HTTPS" not in terminal.text()
            terminal.capture("diagram-context")

            terminal.resize(110, 34)
            terminal.send("/diagram\r")
            terminal.contains("Enter details")
            terminal.contains("▸ System context")
            terminal.send("\t")
            terminal.contains("▸ Containers")
            focus_processor(terminal)
            for text in ("→ Carrier network · Fetches scans · HTTPS", "→ Scan store · Appends scans · SQL"):
                terminal.contains(text)
            terminal.send("\x1b")
            terminal.contains("↑↓ browse")
            terminal.send("\t")
            terminal.contains("▸ System context")
            terminal.send("\x1b")
            terminal.wait(lambda: "Tab zoom" not in terminal.text(), "Inspector did not close")
            assert len(DiagramProvider.requests) == 2

            submit_prompt(terminal, "Let me choose an element.")
            wait_for_turn(terminal, question)
            terminal.contains("Enter choose")
            terminal.send("\t")
            terminal.contains("▸ Containers")
            focus_processor(terminal)
            terminal.contains("Appends scans")
            terminal.send("\x1b")
            terminal.contains("↑↓ browse")
            terminal.capture("diagram-containers")
            terminal.send("l")
            terminal.contains("↑↓ scroll")
            terminal.send("\r")
            wait_for_turn(terminal, "The event processor normalizes carrier scans.")
            submit_prompt(terminal, "Ask me again.")
            wait_for_turn(terminal, question)
            terminal.contains("Enter choose")
            terminal.contains("▸ Containers")
            terminal.send("\x1b")
            wait_for_turn(terminal, "We can leave that decision open.")
        finally:
            terminal.close()

        entries = [json.loads(line).get("message", {}) for line in session.read_text().splitlines()]
        receipts = {m["toolCallId"]: m["details"] for m in entries if m.get("role") == "toolResult"}
        assert receipts["overview"]["status"] == "displayed", receipts
        assert receipts["choose"]["status"] == "selected" and receipts["choose"]["nodeId"] == "processor", receipts
        assert receipts["dismiss"]["status"] == "dismissed" and "nodeId" not in receipts["dismiss"], receipts
        # Restoring the branch and reopening a diagram is read-only; neither operation asks the provider again.
        restored = ui.Terminal(project, env, output, session, columns=60, rows=30)
        try:
            wait_for_turn(restored, "We can leave that decision open.")
            restored.send("/diagram\r")
            restored.contains("Enter details")
            restored.contains("Tracking API")
            restored.contains("Scan store")
            restored.send("\t")
            restored.contains("▸ System context")
            restored.send("\t")
            restored.contains("▸ Containers")
            restored.send("\x1b")
            restored.wait(lambda: "Tab zoom" not in restored.text(), "Inspector did not close")
            wait_for_turn(restored, "We can leave that decision open.")
            assert len(DiagramProvider.requests) == 6
        finally:
            restored.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path)
    run(parser.parse_args().output)
    print("Native C4 context and container views, local zoom, selection, dismissal, and replay passed.")
