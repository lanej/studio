# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte", "pillow"]
# ///
"""Native Studio/Zellij/Neovim journey with a deterministic local model.

Run with ``uv run --script acceptance/documents.py --output docs/assets``.
All state, sockets and sessions belong to this invocation. Captured PNGs are
RGB reconstructions of the real ANSI terminal, not desktop screenshots.
"""
from __future__ import annotations

import argparse
import fcntl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import sqlite3
import struct
import subprocess
import sys
import tempfile
import termios
from threading import Thread
import uuid

import pyte
from PIL import Image, ImageDraw, ImageFont

from socrates_fixture import READ_TOOL, document_read_result, document_revision
from zellij_pty import Terminal as Pty
from zellij_terminal import Terminal


ROOT = Path(__file__).resolve().parents[1]
SEED = """
import { Discoveries } from './discovery/store.ts';
import { SpecStatus } from './socrates/spec.ts';
import { coveragePropertyCatalog } from './socrates/assessment.ts';
import { SessionManager } from '@earendil-works/pi-coding-agent';
const project = process.argv[1];
const session = SessionManager.create(project);
const store = new Discoveries();
const record = store.create(project, session.getSessionId(), 'Native document workspace');
store.change(record.id, row => {
  row.specification = {
    status: SpecStatus.Interrogating, version: 1, acceptedRevision: row.revision,
    draft: {
      objective: 'Inspect the complete proposal in Neovim.',
      scope: ['Specification and plan editing', 'Selection feedback with outcomes'],
      requirements: [{id: 'R1', outcome: 'Keep the full document beside Studio chat.',
        acceptance: 'Saving updates the draft without approving it.'}],
      decisions: [{id: 'D1', decision: 'Keep approval in Studio.', basis: 'decided',
        evidence: 'Explicit operator instruction', disposition: 'resolved', uncertainty: 'None'},
        {id: 'D2', decision: 'Choose who may merge the proposed pull request.', basis: 'observed',
         evidence: 'The operator is reviewing merge authority.', disposition: 'open',
         uncertainty: 'Awaiting the operator merge decision.'}],
      deliveryPolicy: {decisionId: 'D2', pullRequests: 'per-bead', merge: 'project-policy'},
      blockingQuestions: [],
      coverage: {domains: ['engineering'], assessments: coveragePropertyCatalog
        .filter(({domain}) => domain === 'universal' || domain === 'engineering')
        .map(({id, label}) => ({propertyId: id, status: 'satisfied',
          reason: 'The native document fixture exercises ' + label + '.'}))}
    }
  };
  row.leadPlan.draft = {summary: 'Deliver the document editing loop.', pullRequestMerge: 'project-policy', tasks: [
    {key: 'bridge', title: 'Connect the editor', description: 'Bind editable documents to their Studio conversation.',
     acceptance: 'The full plan survives a save.', requirements: ['R1'], owns: ['documents'],
     blockedBy: [], delivery: 'pull-request'} ]};
});
session.appendMessage({role:'user',content:'Inspect this proposal with me.',timestamp:Date.now()});
session.appendCustomEntry('studio:discovery', {id:record.id,project,session:session.getSessionId()});
console.log(JSON.stringify({id:record.id,session:session.getSessionFile()}));
store.close();
"""


def read_records(path: Path, table: str) -> list[dict]:
    if not path.exists():
        return []
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as connection:
        return [json.loads(row[0]) for row in connection.execute(f"SELECT record FROM {table} ORDER BY rowid")]


def content_text(message: dict) -> str:
    content = message.get("content", "")
    return content if isinstance(content, str) else "\n".join(part.get("text", "") for part in content)


class Provider(BaseHTTPRequestHandler):
    state: Path
    requests: list[dict] = []
    errors: list[str] = []

    def log_message(self, *_args):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.requests.append(request)
        messages = request["messages"]
        latest = max((i for i, message in enumerate(messages) if message["role"] == "user"), default=-1)
        prompt = content_text(messages[latest])
        match = re.search(r"Studio document feedback ([^\s]+)", prompt)
        if match is None and not prompt.startswith('Reassess the edited document properties'):
            if "Check the closed editor lifecycle" in prompt:
                reply = "The editor remains closed until you explicitly open documents."
            elif "The operator froze the Socrates specification" in prompt:
                reply = "The specification is frozen. The existing implementation plan remains ready for review."
            else:
                self.errors.append("The native agent did not receive selection feedback")
                reply = "Missing bound feedback."
            delta, finish = {"role": "assistant", "content": reply}, "stop"
        else:
            request_id = match.group(1) if match else None
            calls = [call["function"]["name"] for message in messages[latest + 1:]
                     for call in message.get("tool_calls", [])]
            explanation_only = "explanation only" in prompt
            if not explanation_only and "draft_socrates_specification" not in calls:
                reading = document_read_result(messages)
                if reading is None:
                    assert READ_TOOL in {tool['function']['name'] for tool in request['tools']}
                    name, arguments = READ_TOOL, {}
                else:
                    draft = read_records(self.state / "discoveries.sqlite", "discoveries")[0]["specification"]["draft"]
                    if request_id:
                        draft["requirements"][0]["acceptance"] = (
                            "Preserve local unsaved edits while incoming changes await reconciliation."
                            if "conflict check" in prompt else
                            "Saving updates Studio; explicit Studio review alone freezes the specification."
                        )
                    draft["expectedRevision"] = document_revision(reading, "specification")
                    name, arguments = "draft_socrates_specification", draft
            elif request_id and "document_feedback_outcome" not in calls:
                name, arguments = "document_feedback_outcome", {
                    "requestId": request_id, "summary": "Kept approval in Studio." if explanation_only else "Clarified the acceptance check."
                }
            else:
                name, arguments = None, None
            if name:
                delta = {"role": "assistant", "tool_calls": [{"index": 0,
                         "id": f"fixture-{uuid.uuid4()}", "type": "function",
                         "function": {"name": name, "arguments": json.dumps(arguments)}}]}
                finish = "tool_calls"
            else:
                reply = ("Property assessments now cover the edited specification and plan; freeze remains an explicit Studio action."
                         if request_id is None else
                         "Approval stays in Studio so saving a draft cannot authorize execution. No document edits were needed."
                         if explanation_only else "I clarified the acceptance check. The full explanation stays here in Studio chat.")
                delta = {"role": "assistant", "content": reply}
                finish = "stop"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        chunk = {"id": "documents-fixture", "object": "chat.completion.chunk", "created": 1,
                 "model": "tiny", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
        self.wfile.write(("data: " + json.dumps(chunk) + "\n\ndata: [DONE]\n\n").encode())


class Capture:
    def __init__(self, pty: Pty, terminal: Terminal, output: Path | None):
        self.pty, self.terminal, self.output = pty, terminal, output
        self.screen = pyte.Screen(144, 32)

    def pump(self):
        self.pty.drain(0.15)

    def resize(self, columns: int):
        self.pump()
        self.screen.resize(lines=32, columns=columns)
        fcntl.ioctl(self.pty.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 32, columns, 0, 0))
        os.kill(self.pty.pid, signal.SIGWINCH)
        self.pty.drain(0.4)

    def save(self, name: str):
        self.pump()
        if self.output is None:
            return
        self.output.mkdir(parents=True, exist_ok=True)
        prefix = self.output / f"documents-{name}"
        prefix.with_suffix(".ansi").write_bytes(self.pty.output)
        # Pane dumps avoid unsupported terminal-negotiation DCS sequences in
        # pyte. Place actual pane cells at the geometry reported by Zellij.
        self.screen = pyte.Screen(self.screen.columns, 32)
        panes = self.terminal.terminals()
        for index, pane in enumerate(panes):
            raw = self.terminal.capture_pane(pane["id"], ansi=True)
            (self.output / f"documents-{name}-pane-{index}.ansi").write_text(raw)
            view = pyte.Screen(pane["pane_content_columns"], pane["pane_content_rows"])
            pyte.Stream(view).feed(raw.replace("\n", "\r\n"))
            for y in range(view.lines):
                for x in range(view.columns):
                    self.screen.buffer[y + pane["pane_content_y"]][x + pane["pane_content_x"]] = view.buffer[y][x]
        (self.output / f"documents-{name}-geometry.json").write_text(json.dumps(panes, indent=2) + "\n")
        prefix.with_suffix(".txt").write_text("\n".join(self.screen.display) + "\n")
        palette = json.loads((ROOT / "resources/colors.json").read_text())
        ansi = ["black", "red", "green", "brown", "blue", "magenta", "cyan", "white"]

        def color(value, fallback):
            if value == "default":
                return palette["roles"][fallback]
            if value in ansi:
                return palette["ansi"][ansi.index(value)]
            return "#" + value if len(value) == 6 else palette["roles"][fallback]

        fonts = ["/System/Library/Fonts/Menlo.ttc", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"]
        font = next((ImageFont.truetype(path, 15) for path in fonts if Path(path).is_file()), ImageFont.load_default())
        image = Image.new("RGB", (self.screen.columns * 10, self.screen.lines * 21))
        draw = ImageDraw.Draw(image)
        for y in range(self.screen.lines):
            for x in range(self.screen.columns):
                cell = self.screen.buffer[y][x]
                fg, bg = color(cell.fg, "text"), color(cell.bg, "surface")
                if cell.reverse:
                    fg, bg = bg, fg
                draw.rectangle((x * 10, y * 21, (x + 1) * 10, (y + 1) * 21), fill=bg)
                draw.text((x * 10, y * 21), cell.data, font=font, fill=fg)
        image.save(prefix.with_suffix(".png"))


def run(output: Path | None):
    binary, nvim = shutil.which("zellij"), shutil.which("nvim")
    assert binary and nvim, "Install Zellij and Neovim before running native acceptance"
    parent = "/private/tmp" if sys.platform == "darwin" else None
    with tempfile.TemporaryDirectory(prefix="st-doc-", dir=parent) as directory:
        home = Path(directory).resolve()
        for name in ("agent", "project", "tmp", "run", ".config/zellij", ".config/nvim"):
            (home / name).mkdir(parents=True, mode=0o700)
        env = {"PATH": os.environ["PATH"], "HOME": str(home), "SHELL": "/bin/sh",
               "LANG": "en_US.UTF-8", "TERM": "xterm-256color", "COLORTERM": "truecolor",
               "PS1": "documents-ready> ", "TMPDIR": str(home / "tmp"),
               "XDG_CONFIG_HOME": str(home / ".config"), "XDG_DATA_HOME": str(home / ".local/share"),
               "XDG_CACHE_HOME": str(home / ".cache"), "XDG_STATE_HOME": str(home / ".local/state"),
               "XDG_RUNTIME_DIR": str(home / "run"), "ZELLIJ_SOCKET_DIR": str(home / "run"),
               "PI_CODING_AGENT_DIR": str(home / "agent"), "STUDIO_CONFIG": str(home / "config.json"),
               "STUDIO_STATE_DIR": str(home / "state"), "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0",
               # This display-only PTY does not answer OSC color queries.
                "NVIM_NOTTYFAST": "1", "PYTHONDONTWRITEBYTECODE": "1"}
        (home / ".config/zellij/config.kdl").write_text(
            'default_shell "/bin/sh"\nshow_startup_tips false\non_force_close "quit"\n'
            'default_layout "compact"\n')
        (home / ".config/nvim/init.lua").write_text("""
vim.g.documents_fixture_init = 'configuration preserved'
vim.opt.swapfile = false
vim.opt.shadafile = 'NONE'
vim.opt.termguicolors = true
vim.opt.laststatus = 2
vim.opt.number = true
vim.opt.showmode = false
vim.opt.shortmess:append('I')
vim.cmd('colorscheme habamax')
vim.fn.serverstart(vim.env.HOME .. '/nvim.sock')
vim.fn.writefile({vim.json.encode({socket=vim.env.HOME .. '/nvim.sock',pid=vim.fn.getpid()})}, vim.env.HOME .. '/nvim.json')
""")
        (home / "config.json").write_text(json.dumps({"integrations": {
            "zellij": {"enabled": True, "executable": binary}, "neovim": {"enabled": True, "executable": nvim}}}))
        subprocess.run(["git", "init", "--initial-branch=main", str(home / "project")], check=True, capture_output=True)
        subprocess.run([sys.executable, str(ROOT / "scripts/configure.py"), str(ROOT), str(home / "agent")],
                       env=env, check=True, capture_output=True, timeout=30)
        settings_path = home / "agent/settings.json"
        settings = json.loads(settings_path.read_text())
        settings["retry"] = {"enabled": False, "maxRetries": 0}
        settings_path.write_text(json.dumps(settings))
        seeded = subprocess.run(["bun", "--no-env-file", "-e", SEED, str(home / "project")],
                                env=env, cwd=ROOT, check=True, capture_output=True, text=True, timeout=30)
        record = json.loads(seeded.stdout)
        Provider.state, Provider.requests, Provider.errors = home / "state", [], []
        with ThreadingHTTPServer(("127.0.0.1", 0), Provider) as provider:
            (home / "agent/models.json").write_text(json.dumps({"providers": {"fixture": {
                "baseUrl": f"http://127.0.0.1:{provider.server_port}/v1", "api": "openai-completions",
                "apiKey": "fixture", "models": [{"id": "tiny"}]}}}))
            Thread(target=provider.serve_forever, daemon=True).start()
            name = "documents-" + uuid.uuid4().hex[:10]
            pty = Pty(binary, env, name, install_navigation=False, columns=144)
            terminal = Terminal(pty, ROOT, env, name)
            capture = Capture(pty, terminal, output)
            try:
                terminal.until("isolated Zellij shell", lambda: terminal.terminals())
                terminal.until("isolated shell or first-run welcome", lambda:
                               b"Welcome to Zellij" in pty.output or b"documents-ready>" in pty.output)
                pty.drain(0.5)
                if b"Welcome to Zellij" in pty.output:
                    # Dismiss this private HOME's desktop installation offer.
                    pty.send(b"\x03")
                studio = terminal.terminals()[0]["id"]
                command = shlex.join([str(ROOT / "scripts/studio"), "lead", "--", "--offline", "--no-mcp",
                                      "--model", "fixture/tiny", "--tui-mode", "fullscreen", "--session", record["session"]])
                terminal.send_to_pane(studio, "cd " + shlex.quote(str(home / "project")) + " && exec " + command)
                terminal.write_to_pane(studio, 13)
                terminal.until("automatically opened Neovim", lambda: (home / "nvim.json").exists())
                terminal.until("exactly two terminal panes", lambda: len(terminal.terminals()) == 2)
                editor = next(pane["id"] for pane in terminal.terminals() if pane["id"] != studio)
                assert next(pane for pane in terminal.terminals() if pane["id"] == studio)["is_focused"], "Auto-open stole Studio focus"

                def nvim_expr(expression):
                    pty.drain()
                    result = subprocess.run([nvim, "--server", str(home / "nvim.sock"), "--remote-expr", expression],
                                            env=env, capture_output=True, text=True, check=True, timeout=5)
                    return result.stdout.strip()

                def lua(expression):
                    return json.loads(nvim_expr("luaeval(" + json.dumps("vim.json.encode(" + expression + ")") + ")"))

                def lines():
                    return lua("vim.api.nvim_buf_get_lines(0,0,-1,false)")

                def marks():
                    return lua("vim.api.nvim_buf_get_extmarks(0,vim.api.nvim_get_namespaces().StudioDocuments,0,-1,{details=true})")

                def keys(pane, value):
                    terminal.write_to_pane(pane, *value.encode())

                def ex(command):
                    keys(editor, "\x1b:" + command + "\r")

                def saved():
                    return read_records(home / "state/discoveries.sqlite", "discoveries")[0]

                def feedback():
                    return read_records(home / "state/documents.sqlite", "document_feedback")

                terminal.until("full specification buffer", lambda: "## Objective" in lines())
                assert lua("vim.g.documents_fixture_init") == "configuration preserved"
                assert "Explicit operator instruction" in lines(), "Full specification was truncated to the sidebar summary"
                buffers = lua("vim.tbl_map(function(b) return vim.api.nvim_buf_get_name(b) end,vim.api.nvim_list_bufs())")
                assert any(path.endswith("plan.md") for path in buffers), "Full plan buffer missing"
                terminal.until("rendered Studio draft summary", lambda: "Specification" in terminal.capture_pane(studio))
                terminal.until("rendered full specification", lambda: "Objective" in terminal.capture_pane(editor))
                capture.save("normal")
                print("PASS automatic pane, Studio focus, complete documents, configured Neovim init", flush=True)

                terminal.focus_pane(editor)
                ex(r"%s/Inspect the complete proposal in Neovim\./Review the complete proposal in Neovim./")
                ex('%s/basis = "observed"/basis = "decided"/')
                ex('%s/disposition = "open"/disposition = "resolved"/')
                ex('%s/merge = "project-policy"/merge = "manual"/')
                ex(r"%s/Choose who may merge the proposed pull request\./Open one PR per bead and reserve merge for the operator./")
                ex(r"%s/The operator is reviewing merge authority\./The operator chose manual merge for each proposed PR./")
                ex(r"%s/Awaiting the operator merge decision\./None/")
                ex(r"%s/The native document fixture exercises Verification\./The native journey checks saved state and visible editor outcomes./")
                ex("write")
                terminal.until("save accepted by Studio", lambda: saved()["specification"]["draft"]["objective"].startswith("Review"))
                edited_spec = saved()["specification"]["draft"]
                assert edited_spec["deliveryPolicy"] == {"decisionId": "D2", "pullRequests": "per-bead", "merge": "manual"}
                assert edited_spec["decisions"][1]["disposition"] == "resolved"
                assert edited_spec["coverage"]["domains"] == ["engineering"]
                assert len(edited_spec["coverage"]["assessments"]) == 19
                assert next(item["reason"] for item in edited_spec["coverage"]["assessments"] if item["propertyId"] == "verification") == (
                    "The native journey checks saved state and visible editor outcomes.")
                assert saved()["specification"]["status"] == "interrogating"
                assert "approvalAt" not in saved()["specification"] and "approved" not in saved()
                terminal.until("clean saved buffer", lambda: not lua("vim.bo.modified"))
                print("PASS :write edits complete coverage and delivery policy without freeze or plan approval", flush=True)

                objective_line = lines().index("Review the complete proposal in Neovim.") + 1
                keys(editor, f"{objective_line}GV:StudioComment\r")
                terminal.until("selection comment prompt", lambda: "Studio comment:" in terminal.capture_pane(editor))
                keys(editor, "Is this something we really want? Clarify the acceptance check.\r")
                terminal.until("explicit outcome for selection", lambda: len(feedback()) == 1 and feedback()[0]["state"] == "answered")
                first = feedback()[0]
                assert first["selectedText"] == "Review the complete proposal in Neovim."
                assert first["range"] == {"startLine": objective_line, "endLine": objective_line}
                assert first["responseId"] and first["changes"] and first["summary"] == "Clarified the acceptance check."
                terminal.until("direct document update and concise marker", lambda:
                               "explicit Studio review alone" in "\n".join(lines()) and "Answered" in json.dumps(marks()))
                capture.save("response")
                ex("StudioChanges")
                terminal.until("response selector", lambda: "Studio comments" in terminal.capture_pane(editor))
                keys(editor, "1\r")
                terminal.until("changed location selector", lambda: "Changed document locations" in terminal.capture_pane(editor))
                keys(editor, "1\r")
                terminal.until("jump to changed document location", lambda:
                               lua("vim.api.nvim_win_get_cursor(0)[1]") == first["changes"][0]["range"]["startLine"])
                capture.save("answered")
                assert len(terminal.terminals()) == 2, "Updates created a duplicate editor pane"
                print("PASS selected text, request-bound outcome, direct update, marker and changed-location jump", flush=True)

                ex(r"%s/Review the complete proposal in Neovim\./Local unsaved proposal survives./")
                dirty_line = lines().index("Local unsaved proposal survives.") + 1
                keys(editor, f"{dirty_line}GV:StudioComment\r")
                terminal.until("dirty selection comment prompt", lambda: "Studio comment:" in terminal.capture_pane(editor))
                keys(editor, "Perform the conflict check and clarify acceptance.\r")
                terminal.until("second request answered", lambda: len(feedback()) == 2 and feedback()[1]["state"] == "answered")
                terminal.until("visible dirty conflict status", lambda: "conflict" in lua("vim.wo.winbar"))
                assert "Local unsaved proposal survives." in lines() and lua("vim.bo.modified")
                ex("write")
                assert saved()["specification"]["draft"]["objective"] == "Review the complete proposal in Neovim."
                capture.save("conflict")
                capture.resize(88)
                ex("normal! gg")
                capture.save("narrow")
                print("PASS dirty edits retained; incoming update held; stale save rejected; narrow rendering captured", flush=True)

                ex("StudioReload!")
                terminal.until("explicit reload resolved conflict", lambda: not lua("vim.bo.modified") and "conflict" not in lua("vim.wo.winbar"))
                before_explanation = saved()
                objective_line = lines().index("Review the complete proposal in Neovim.") + 1
                keys(editor, f"{objective_line}GV:StudioComment\r")
                terminal.until("explanation-only selection prompt", lambda: "Studio comment:" in terminal.capture_pane(editor))
                keys(editor, "Give an explanation only: why keep approval in Studio?\r")
                terminal.until("explanation-only outcome", lambda: len(feedback()) == 3 and feedback()[2]["state"] == "answered")
                explanation = feedback()[2]
                assert explanation["changes"] == [] and explanation["responseId"]
                after_explanation = saved()
                assert "coverageRevision" not in after_explanation["specification"], "Operator feedback retained an old property assessment"
                # A new operator message invalidates the prior assessment even
                # when its answer leaves the documents and authority unchanged.
                for snapshot in (before_explanation, after_explanation):
                    snapshot["specification"].pop("coverageRevision", None)
                assert after_explanation == before_explanation, "Explanation-only response mutated a document or approval"
                terminal.until("explicit no-edits response marker", lambda: "no document edits" in json.dumps(marks()))
                choice = sorted(item["requestId"] for item in feedback()).index(explanation["requestId"]) + 1
                ex("StudioChanges")
                terminal.until("no-edits response selector", lambda: "Studio comments" in terminal.capture_pane(editor))
                keys(editor, f"{choice}\r")
                terminal.until("no-edits navigation result", lambda:
                               "No document edits" in terminal.capture_pane(editor))
                keys(editor, "\r")
                print("PASS explanation-only outcome preserves documents and explicitly reports no edits", flush=True)

                ex("buffer plan.md")
                terminal.until("editable plan before freeze", lambda:
                               lua("vim.api.nvim_buf_get_name(0)").endswith("plan.md") and lua("vim.bo.modifiable"))
                assert "Bind editable documents to their Studio conversation." in lines()
                ex(r"%s/Deliver the document editing loop\./Deliver the proposed document editing loop./")
                ex('%s/pullRequestMerge = "project-policy"/pullRequestMerge = "manual"/')
                ex(r"%s/The full plan survives a save\./The full plan and its manual merge rule survive a save./")
                ex("write")
                terminal.until("plan policy save accepted by Studio", lambda:
                               saved()["leadPlan"]["draft"].get("pullRequestMerge") == "manual")
                plan_draft = saved()["leadPlan"]["draft"]
                assert plan_draft["summary"] == "Deliver the proposed document editing loop."
                assert plan_draft["tasks"][0]["delivery"] == "pull-request"
                assert plan_draft["tasks"][0]["acceptance"] == "The full plan and its manual merge rule survive a save."
                assert "coverageRevision" not in saved()["specification"], "Plan save retained stale property approval"
                assert saved()["planSpecificationRevision"]
                assert saved()["specification"]["status"] == "interrogating" and "approved" not in saved()
                terminal.until("plan policy buffer save acknowledged", lambda: not lua("vim.bo.modified"))
                ex("buffer specification.md")
                terminal.focus_pane(studio)
                keys(studio, "Reassess the edited document properties against the current specification and plan.\r")
                terminal.until("native agent reassessed current documents", lambda: bool(saved()["specification"].get("coverageRevision")))
                terminal.until("reassessment completed", lambda:
                               "freeze remains an explicit Studio action" in " ".join(terminal.capture_pane(studio).split()))
                assert saved()["specification"]["status"] == "interrogating" and "approved" not in saved()
                print("PASS pre-freeze plan edits preserve merge policy and require native property reassessment", flush=True)
                keys(studio, "/spec-freeze\r")
                terminal.until("Studio freeze review", lambda: "Freeze specification" in terminal.capture_pane(studio))
                assert saved()["specification"]["status"] == "interrogating"
                for _ in range(20):
                    if "Enter freeze spec" in terminal.capture_pane(studio):
                        break
                    keys(studio, "\r")
                terminal.until("explicit freeze action", lambda: "Enter freeze spec" in terminal.capture_pane(studio))
                keys(studio, "\r")
                terminal.until("Studio explicitly froze specification", lambda: saved()["specification"]["status"] == "frozen")
                assert "approvalAt" in saved()["specification"] and "approved" not in saved()
                terminal.until("frozen document protected in Neovim", lambda: not lua("vim.bo.modifiable"))
                terminal.focus_pane(editor)
                ex("buffer plan.md")
                terminal.until("editable full plan", lambda:
                               lua("vim.api.nvim_buf_get_name(0)").endswith("plan.md") and lua("vim.bo.modifiable"))
                assert "Bind editable documents to their Studio conversation." in lines()
                ex(r"%s/Deliver the proposed document editing loop\./Deliver the reviewed document editing loop./")
                ex("write")
                terminal.until("plan save accepted by Studio", lambda:
                               saved()["leadPlan"]["draft"]["summary"] == "Deliver the reviewed document editing loop.")
                assert saved()["specification"]["status"] == "frozen" and "approved" not in saved()
                assert saved()["leadPlan"]["draft"]["pullRequestMerge"] == "manual"
                assert "coverageRevision" not in saved()["specification"], "Frozen plan edit bypassed reassessment"
                assert not Provider.errors, Provider.errors
                print("PASS explicit Studio freeze protects the specification; full plan edits save without approval", flush=True)

                terminal.until("plan buffer save acknowledged", lambda: not lua("vim.bo.modified"))
                closed_editor = editor
                previous_editor_pid = lua("vim.fn.getpid()")
                ex("qa")
                terminal.until("operator closed editor pane", lambda: len(terminal.terminals()) == 1)
                assert terminal.terminals()[0]["id"] == studio
                keys(studio, "Check the closed editor lifecycle; leave the documents unchanged.\r")
                terminal.until("routine Studio turn completed", lambda:
                               "editor remains closed" in " ".join(terminal.capture_pane(studio).split()))
                # Observe the settled-turn refresh, not just the instant after closing.
                for _ in range(5):
                    pty.drain(0.15)
                    assert len(terminal.terminals()) == 1, "Routine refresh reopened a deliberately closed editor"
                keys(studio, "/documents\r")
                terminal.until("explicit document reopen", lambda: len(terminal.terminals()) == 2)
                editor = next(pane["id"] for pane in terminal.terminals() if pane["id"] != studio)
                terminal.until("reopened Neovim registration", lambda: lua("vim.fn.getpid()") != previous_editor_pid)
                terminal.until("current documents in reopened editor", lambda: "## Objective" in lines() or "## Summary" in lines())
                assert lua("vim.g.documents_fixture_init") == "configuration preserved"
                terminal.focus_pane(editor)
                ex("buffer plan.md")
                terminal.until("latest plan in reopened pane", lambda: "Deliver the reviewed document editing loop." in lines())
                assert len(terminal.terminals()) == 2
                print("PASS closed pane stays closed through routine refresh; /documents reopens exactly one current editor", flush=True)

                ex(r"%s/Deliver the reviewed document editing loop\./Local plan survives Studio disconnect./")
                assert lua("vim.bo.modified")
                terminal.focus_pane(studio)
                keys(studio, "/quit\r")
                terminal.until("Studio closed without closing Neovim", lambda:
                               len(terminal.terminals()) == 1 and terminal.terminals()[0]["id"] == editor)
                # Neovim can ask for acknowledgement when the disconnect notice
                # wraps in the narrow pane. Its remote evaluator waits behind it.
                terminal.until("visible disconnect notice", lambda:
                               "disconnected" in terminal.capture_pane(editor) or
                               "Cannot reach the bound Studio" in terminal.capture_pane(editor))
                if "Press ENTER" in terminal.capture_pane(editor):
                    keys(editor, "\r")
                terminal.until("visible disconnected editor status", lambda: "disconnected" in lua("vim.wo.winbar"))
                assert "Local plan survives Studio disconnect." in lines() and lua("vim.bo.modified")
                assert saved()["leadPlan"]["draft"]["summary"] == "Deliver the reviewed document editing loop."
                lifecycle = {"closedPane": closed_editor, "reopenedPane": editor,
                             "routineRefreshKeptClosed": True, "explicitReopenCount": 1,
                             "studioClosedEditorSurvived": True, "disconnectPreservedDirtyText": True,
                             "finalEditorStatus": lua("vim.wo.winbar")}
                print("PASS Studio disconnect leaves Neovim available and preserves dirty text", flush=True)
                if output:
                    evidence = {"provider": "deterministic local OpenAI-compatible SSE fixture; no live model",
                                "initMarker": lua("vim.g.documents_fixture_init"), "panes": terminal.terminals(),
                                "requests": len(Provider.requests), "feedback": feedback(),
                                "finalSpecificationStatus": saved()["specification"]["status"],
                                "finalPlanSummary": saved()["leadPlan"]["draft"]["summary"],
                                "coverageAssessmentCount": len(saved()["specification"]["draft"]["coverage"]["assessments"]),
                                "deliveryPolicy": saved()["specification"]["draft"]["deliveryPolicy"],
                                "pullRequestMerge": saved()["leadPlan"]["draft"]["pullRequestMerge"],
                                "planEditInvalidatedCoverage": "coverageRevision" not in saved()["specification"],
                                "planApproved": "approved" in saved(),
                                "lifecycle": lifecycle,
                                "images": "RGB reconstructions from the actual terminal ANSI, not desktop screenshots"}
                    messages = [json.loads(line).get("message", {}) for line in Path(record["session"]).read_text().splitlines()]
                    evidence["toolResults"] = [message for message in messages if message.get("role") == "toolResult"
                                               and message.get("toolName") in (READ_TOOL, "draft_socrates_specification", "document_feedback_outcome")]
                    (output / "documents-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
            except Exception:
                capture.save("failure")
                if output:
                    (output / "documents-failure-requests.json").write_text(json.dumps(Provider.requests, indent=2))
                raise
            finally:
                subprocess.run([binary, "kill-session", name], env=env, capture_output=True, timeout=5)
                terminal.close()
                provider.shutdown()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="Retain ANSI, text, reconstructed PNGs and evidence JSON")
    try:
        run(parser.parse_args().output)
    except subprocess.CalledProcessError as error:
        print(error.stderr, file=sys.stderr)
        raise
