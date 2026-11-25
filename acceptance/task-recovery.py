# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte", "pillow"]
# ///
"""Inspect real disposable failed-check receipts without invoking recovery actions."""
import argparse
import importlib.util
import json
from pathlib import Path
import tempfile
import sys
from task_panel_session import task_panel_session

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True, type=Path)
parser.add_argument("--output", required=True, type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("studio_terminal", root / "acceptance/socrates-status.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
fixture = json.loads(args.input.read_text())

def select(terminal, label):
    def selected():
        return any(f"› ↗ {label}" in line or f"› ▸ {label}" in line or f"› ▾ {label}" in line
                   for line in terminal.screen.display)
    for _ in range(16):
        terminal.send("\t")
        terminal.pump(.1)
        if selected():
            return
    terminal.capture("action-selection-failure")
    raise AssertionError(f"Could not select {label!r}\n{terminal.text()}")

def reveal(terminal, text):
    for _ in range(80):
        terminal.pump(.05)
        if text in " ".join(terminal.text().split()):
            return
        terminal.send("j")
    terminal.contains(text)

with tempfile.TemporaryDirectory(prefix="st-rec-ui-", dir="/private/tmp" if sys.platform == "darwin" else None) as directory:
    temporary = Path(directory)
    config = json.loads(Path(fixture["env"]["STUDIO_CONFIG"]).read_text())
    unavailable = {**config, "runtime": {**config["runtime"], "enabled": False, "projects": []}}
    unavailable_config = temporary / "unavailable.json"
    unavailable_config.write_text(json.dumps(unavailable))
    for mode in ("retained", "unavailable", "missing"):
        env = fixture["env"].copy()
        if mode != "retained":
            env["STUDIO_CONFIG"] = str(unavailable_config)
        if mode == "missing":
            env["STUDIO_STATE_DIR"] = str(temporary / "missing-state")
        session = task_panel_session(Path(fixture["project"]), env, config["beadsService"], fixture["task"], "recovery-fixture-ready")
        for width in (100, 60):
            terminal = module.Terminal(Path(fixture["project"]), env, args.output,
                                       session, columns=width, rows=34)
            try:
                terminal.contains("recovery-fixture-ready")
                terminal.send(f"/tasks {fixture['task']}\r")
                terminal.contains("Deliberate verifier rejection")
                if mode == "retained":
                    terminal.contains("Verification failed")
                    terminal.capture("failed-check")
                    select(terminal, "Open retained diff")
                    terminal.send("\r")
                    reveal(terminal, "+verified prerequisite")
                    terminal.capture("retained-diff")
                    select(terminal, "Retry attempt")
                    terminal.capture("guarded-retry")
                    # Inspection never activates Retry; the native caller invokes the real guarded command.
                elif mode == "unavailable":
                    for _ in range(40):
                        if "Retry unavailable" in terminal.text():
                            break
                        terminal.send("j")
                    terminal.contains("Retry unavailable")
                    terminal.capture("recovery-unavailable")
                select(terminal, "Execution evidence")
                terminal.send("\r")
                if mode == "missing":
                    for _ in range(10):
                        terminal.send("j")
                    terminal.contains("No local execution receipts")
                else:
                    reveal(terminal, "EXPECTED_REJECTION")
                terminal.capture(f"{mode}-execution-evidence")
            finally:
                terminal.close()
print("Native wide/narrow failed-check, retained diff/output, guarded retry notice, unavailable recovery and missing evidence passed.")
