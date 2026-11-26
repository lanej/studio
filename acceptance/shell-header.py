# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte", "pillow"]
# ///
"""Render retained Bash tool calls in native Pi; never execute their commands."""
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
colors = json.loads((root / "resources/theme.json").read_text())["colors"]
# This command and its timeout occupy 57 of the 58 content cells in the narrow pane.
full_row_command = "printf " + "x" * 34
commands = [
    'expected=729c3fa; gh pr checks 15 --repo lanej/studio --watch --fail-fast --interval 10 > /tmp/checks.log 2>&1 && test "$expected" = "$(gh pr view 15 --json headRefOid --jq .headRefOid)"; tail -15 /tmp/checks.log',
    "gh run list --limit 15 --json databaseId --jq '.[].databaseId' | tail -15 || gh run view --log",
    full_row_command,
]


def assert_style(terminal, word, token, bold=False):
    matches = []
    expected = colors.get(token, token).lstrip("#").lower()
    for row, line in enumerate(terminal.screen.display):
        start = 0
        while (column := line.find(word, start)) >= 0:
            cells = [terminal.screen.buffer[row][x] for x in range(column, column + len(word))]
            if all(cell.fg.lower() == expected and (not bold or cell.bold) for cell in cells):
                matches.append((row, column))
            start = column + len(word)
    assert matches, f"Missing {token} styling for {word!r}\n{terminal.text()}"


def run(output):
    temp_parent = "/private/tmp" if sys.platform == "darwin" else None
    with tempfile.TemporaryDirectory(prefix="st-sh-", dir=temp_parent) as directory:
        home = Path(directory).resolve()
        agent = home / ".pi/agent"
        agent.mkdir(parents=True)
        project = home / "project"
        project.mkdir()
        subprocess.run(["git", "init", "--initial-branch=main", str(project)], check=True, capture_output=True, timeout=30)
        (home / "config.json").write_text("{}")
        (agent / "models.json").write_text(json.dumps({"providers": {"fixture": {"baseUrl": "http://127.0.0.1:9/v1", "api": "openai-completions", "apiKey": "fixture", "models": [{"id": "tiny"}]}}}))
        env = {**os.environ, "HOME": str(home), "PI_CODING_AGENT_DIR": str(agent), "STUDIO_CONFIG": str(home / "config.json"), "STUDIO_STATE_DIR": str(home / "state"), "TERM": "xterm-256color", "COLORTERM": "truecolor", "PI_TELEMETRY": "0", "PI_SKIP_VERSION_CHECK": "1"}
        subprocess.run([sys.executable, str(root / "scripts/configure.py"), str(root), str(agent)], env=env, check=True, stdout=subprocess.DEVNULL, timeout=30)
        source = f"""
import {{SessionManager}} from '@earendil-works/pi-coding-agent';
const session=SessionManager.create({json.dumps(str(project))});
session.appendMessage({{role:'user',content:'Inspect these retained tool headers. No commands run during this check.',timestamp:Date.now()}});
const usage={{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}};
for (const [index,command] of {json.dumps(commands)}.entries()) {{
 const call={{type:'toolCall',id:`shell-${{index}}`,name:'bash',arguments:{{command,timeout:30}}}};
 session.appendMessage({{role:'assistant',content:[call],api:'openai-completions',provider:'fixture',model:'tiny',usage,stopReason:'toolUse',timestamp:Date.now()}});
 session.appendMessage({{role:'toolResult',toolCallId:call.id,toolName:call.name,content:[{{type:'text',text:'Retained fixture output; command was not executed.'}}],isError:false,durationMs:index === 0 ? 249 : 1250,timestamp:Date.now()}});
}}
console.log(session.getSessionFile());
"""
        session = subprocess.run(["bun", "--no-env-file", "-e", source], env=env, cwd=root, text=True, capture_output=True, check=True, timeout=30).stdout.strip()
        for width in (128, 60):
            terminal = ui.Terminal(project, env, output, session, mode="regular", columns=width, rows=38)
            try:
                terminal.contains("Retained fixture output; command was not executed.")
                terminal.contains("timeout 30s")
                terminal.contains("1.3s")
                terminal.contains("tokens")
                assert "Took " not in terminal.text() and "0.2s" not in terminal.text(), terminal.text()
                assert_style(terminal, "≈", "#b1b1b1")
                heading = f"$ {full_row_command} (timeout 30s)"
                terminal.contains(heading)
                lines = [row.strip() for row in terminal.screen.display if row.strip()]
                row = next(i for i, line in enumerate(lines) if line.startswith(heading))
                if width == 60:
                    assert lines[row] == heading, lines[row]
                else:
                    assert lines[row].startswith(heading + "  ≈") and lines[row].endswith("1.3s"), lines[row]
                assert lines[row + 1] == "Retained fixture output; command was not executed.", lines[row:row + 3]
                # Compound command/flag colors must survive both native layouts.
                for word in ("gh", "tail"):
                    assert_style(terminal, word, "syntaxFunction", bold=True)
                for word in ("--repo", "--watch", "--fail-fast", "--interval", "--json", "--jq", "--limit", "-15", "--log"):
                    assert_style(terminal, word, "syntaxKeyword")
                terminal.capture("shell-header")
            finally:
                terminal.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path)
    run(parser.parse_args().output)
    print("Native Pi retained Bash headers preserve command/flag styles, wrapping, timeout and timing at 128 and 60 columns; no rendered commands executed.")
