# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte", "pillow"]
# ///
"""Review a complete plan in native Pi without granting runtime execution authority."""
import argparse
from importlib import import_module
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ui = import_module("socrates-status")
root = Path(__file__).resolve().parents[1]
proposal = {
    "summary": "Ship the event exporter and guide independently.",
    "pullRequestMerge": "manual",
    "tasks": [
        {"key": "event-schema", "title": "Define the event schema", "description": "Define the fields shared by the exporter and guide.", "acceptance": "The schema defines the event ID, type, and timestamp.", "requirements": ["R1"], "owns": ["schema/events.json"], "check": ["bun", "test", "schema"], "delivery": "local"},
        {"key": "operator-notes", "title": "Record exploratory notes", "description": "Keep exploratory observations in the local project.", "acceptance": "The operator can inspect the notes locally.", "requirements": ["R1"], "owns": ["notes/export.md"], "hold": True, "delivery": "local"},
        {"key": "json-export", "title": "Export events as JSON", "description": "Write the exporter against the reviewed schema.", "acceptance": "The exporter emits valid schema-compatible JSON.", "requirements": ["R1"], "owns": ["exporter"], "blockedBy": ["event-schema"], "check": ["bun", "test", "exporter"], "delivery": "pull-request"},
        {"key": "export-guide", "title": "Document the event export", "description": "Show a complete exporter example in the guide.", "acceptance": "The guide example passes the documented check.", "requirements": ["R1"], "owns": ["guide"], "blockedBy": ["event-schema"], "delivery": "pull-request"},
    ],
}


def run(output):
    temp_parent = "/private/tmp" if sys.platform == "darwin" else None
    with tempfile.TemporaryDirectory(prefix="st-review-", dir=temp_parent) as directory:
        home = Path(directory).resolve()
        agent = home / ".pi/agent"
        agent.mkdir(parents=True)
        project = home / "event-export"
        project.mkdir()
        subprocess.run(["git", "init", "--initial-branch=main", str(project)], check=True, capture_output=True, timeout=30)
        (home / "config.json").write_text("{}")
        (agent / "models.json").write_text(json.dumps({"providers": {"fixture": {"baseUrl": "http://127.0.0.1:9/v1", "api": "openai-completions", "apiKey": "fixture", "models": [{"id": "tiny"}]}}}))
        env = {**os.environ, "HOME": str(home), "PI_CODING_AGENT_DIR": str(agent), "STUDIO_CONFIG": str(home / "config.json"), "STUDIO_STATE_DIR": str(home / "state"), "TERM": "xterm-256color", "COLORTERM": "truecolor", "PI_TELEMETRY": "0", "PI_SKIP_VERSION_CHECK": "1"}
        subprocess.run([sys.executable, str(root / "scripts/configure.py"), str(root), str(agent)], env=env, check=True, stdout=subprocess.DEVNULL, timeout=30)
        receipt = home / "approval.json"
        fixture = home / "review.ts"
        # Only the production review component runs. The fixture records its
        # boolean result instead of handing the plan to Beads or the runtime.
        fixture.write_text(f'''
import {{ writeFileSync }} from 'node:fs';
import {{ reviewPlan }} from {json.dumps(str(root / 'ui.ts'))};
import {{ draftSchema }} from {json.dumps(str(root / 'lead-plan.ts'))};
export default function(pi) {{
  pi.registerCommand('review-plan', {{description:'Review isolated acceptance plan', async handler(_,ctx) {{
    const accepted = await reviewPlan(ctx, 'Approve Event export and guide', {{
      draft: draftSchema.parse({json.dumps(proposal)}),
      context: [
        {{label:'Execution',value:'background'}},
        {{label:'Project',value:{json.dumps(str(project))}}},
        {{label:'Beads',value:'a937016c-0f84-46a8-b579-333cbf926866'}},
        {{label:'Profile',value:'personal'}},
      ],
      publications: [
        {{label:'PR from json-export',value:'Includes event-schema, json-export'}},
        {{label:'PR from export-guide',value:'Includes event-schema, export-guide'}},
      ],
      specification: 'Objective · Make event export reusable\\n\\nR1 · Export events and document their use.\\nAcceptance · The examples produce schema-compatible JSON.\\n\\nDecision D1 · Publish the exporter and guide independently. Merge manually. Keep exploratory notes local.',
    }}, 'create tasks and implement');
    writeFileSync({json.dumps(str(receipt))}, JSON.stringify({{accepted}}));
    ctx.ui.notify(accepted ? 'Fixture approved; execution disabled' : 'Fixture cancelled', 'info');
  }}}});
}}
''')
        settings_path = agent / "settings.json"
        settings = json.loads(settings_path.read_text())
        settings["extensions"] = [str(fixture)]
        settings_path.write_text(json.dumps(settings))
        source = f"import {{SessionManager}} from '@earendil-works/pi-coding-agent'; const session=SessionManager.create({json.dumps(str(project))}); session.appendMessage({{role:'user',content:'Review the event exporter and guide before creating tasks.',timestamp:Date.now()}}); console.log(session.getSessionFile());"
        session = subprocess.run(["bun", "--no-env-file", "-e", source], env=env, cwd=root, text=True, capture_output=True, check=True, timeout=30).stdout.strip()
        terminal = ui.Terminal(project, env, output, session)
        try:
            terminal.contains("Review the event exporter and guide")
            terminal.send("/review-plan\r")
            terminal.contains("Approve Event export and guide")
            terminal.contains("Define the event schema")
            terminal.contains("Export events as JSON")
            terminal.capture("plan-review-graph")
            # Graph lanes must carry real terminal colors, not plain glyphs.
            colored = {cell.fg for line in terminal.screen.buffer.values() for cell in line.values() if cell.data in "│├┤┬┴┼╭╮╰╯●"}
            assert len(colored) > 1, (colored, terminal.text())
            terminal.resize(60, 24)
            terminal.contains("Approve Event export and guide")
            terminal.contains("Define the event schema")
            terminal.capture("plan-review-graph")
            terminal.send("\r")
            assert not receipt.exists(), "Enter approved before the review reached the end"
            terminal.send("\x1b")
            terminal.contains("Fixture cancelled")
            assert json.loads(receipt.read_text()) == {"accepted": False}
            receipt.unlink()
            terminal.resize(100, 32)
            terminal.send("/review-plan\r")
            terminal.contains("Approve Event export and guide")
            seen = terminal.text()
            captured_details = False
            # Scroll every review row, including the metadata and specification.
            for _ in range(800):
                if "Enter create tasks and implement" in terminal.text():
                    break
                terminal.send("j")
                seen += "\n" + terminal.text()
                if not captured_details and all(field in terminal.text() for field in ("Acceptance", "Requirements", "Owns", "Verification")):
                    terminal.capture("plan-review-details")
                    captured_details = True
            else:
                raise AssertionError("Approval action never became available\n" + terminal.text())
            for field in ("Execution", "background", "Project", "event-export", "Beads", "a937016c", "Profile", "personal", "Includes event-schema, json-export", "Acceptance", "Requirements", "Owns", "Admission", "on hold", "Delivery", "Verification", "schema/events.json", "Blocked by", "R1", "Merge manually"):
                assert field in seen, f"Review lost {field!r}"
            assert not receipt.exists(), "Scrolling submitted the plan"
            terminal.capture("plan-review-end")
            terminal.send("\r")
            terminal.contains("Fixture approved; execution disabled")
            assert json.loads(receipt.read_text()) == {"accepted": True}
            assert not (home / "state/runtime.sqlite").exists(), "Fixture started runtime execution"
        finally:
            terminal.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path)
    run(parser.parse_args().output)
    print("Native plan review preserved its colored graph, narrow layout, complete approval context, cancellation and scroll-before-approval gate.")
