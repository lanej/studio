# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte", "pillow"]
# ///
"""Answer an actual owned background request through /tasks; no synthetic decision state."""
import argparse
import importlib.util
import json
from pathlib import Path
from task_panel_session import task_panel_session

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True, type=Path)
parser.add_argument("--output", required=True, type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("native_terminal", root / "acceptance/socrates-status.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
fixture = json.loads(args.input.read_text())
project = Path(fixture["project"])
session = task_panel_session(project, fixture["env"], fixture["source"], fixture["task"], "operator-decision-fixture-ready")
terminal = module.Terminal(project, fixture["env"], args.output, session, columns=100, rows=36)
try:
    terminal.contains("operator-decision-fixture-ready")
    terminal.send(f"/tasks {fixture['task']}\r")
    terminal.contains("Operator decision evidence")
    terminal.send("\x1bt")
    def select_answer():
        for _ in range(32):
            terminal.send("\t")
            if any("› ↗ Answer operator decision" in row for row in terminal.screen.display):
                return
        raise AssertionError("Answer action not available\n" + terminal.text())
    select_answer()
    # The inspector shares rows with the tree; assert its wrapped fragments.
    terminal.contains("Which")
    terminal.contains("accepted marker should decision.txt contain?")
    terminal.capture("operator-question")
    terminal.resize(60, 36)
    terminal.contains("Operator decision evidence")
    terminal.capture("operator-question")
    terminal.send("\r")
    terminal.contains("Answer operator decision")
    terminal.contains(fixture["question"])
    terminal.capture("operator-answer-question")
    terminal.resize(100, 36)
    terminal.contains(fixture["question"])
    terminal.capture("operator-answer-question")
    terminal.send(fixture["answer"] + "\r")
    terminal.contains("Answer recorded")
    terminal.capture("operator-answer-recorded")
finally:
    pid = terminal.process.pid
    terminal.close()
    (args.output / "ui-cleanup.json").write_text(json.dumps({"pid": pid, "exited": terminal.process.poll() is not None}))
