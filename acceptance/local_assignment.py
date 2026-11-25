"""Exercise the native Pi input policy in a disposable Zellij pane."""

import json
import shlex
import shutil
from subprocess import CalledProcessError
from threading import Event
from uuid import uuid4

from local_fixture import Fixture, Report
from local_provider import ADMITTED_MODEL, Provider, TextDelta, ToolDelta, tool_delta
from socrates_fixture import CompletionRequest, message_text
from zellij_terminal import Terminal


GUIDANCE = "Keep the change within the accepted path."
BLOCKED = "Assigned worker: enter guidance or /quit."


class AssignmentProvider(Provider):
    started = Event()
    continue_turn = Event()

    def respond(self, request: CompletionRequest) -> ToolDelta | TextDelta:
        assert {tool["function"]["name"] for tool in request["tools"]} == {"assignment_probe"}, request
        if len(self.requests) == 1:
            self.started.set()
            assert self.continue_turn.wait(45), "Fixture did not release the first turn"
            return tool_delta("assignment-tool", "assignment_probe", {})
        guidance = [message for message in request["messages"]
                    if message["role"] == "user" and message_text(message) == GUIDANCE]
        assert len(guidance) == 1, request
        assert any(message["role"] == "tool" for message in request["messages"]), request
        return {"role": "assistant", "content": "Guidance applied in the assigned turn."}


def exercise_assignment_input(fixture: Fixture, terminal: Terminal, lead: int, tab: int, report: Report) -> None:
    attempt = str(uuid4())
    sessions = fixture.options.work / "assignment-sessions"
    editor_marker = fixture.options.work / "external-editor-ran"
    shell_marker = fixture.options.work / "shell-ran"
    editor = fixture.options.work / "external-editor"
    editor.write_text(f"#!/bin/sh\ntouch {shlex.quote(str(editor_marker))}\n")
    editor.chmod(0o700)
    (fixture.paths.agent / "keybindings.json").write_text(json.dumps({
        "app.session.new": "f5", "app.session.resume": "f6",
    }))
    bun = shutil.which("bun", path=fixture.env["PATH"])
    assert bun
    pane = int(terminal.request(
        "launch", tab=tab, name="assignment fixture", cwd=str(fixture.options.repository),
        args=[
            "PI_OFFLINE=1", f"VISUAL={editor}", f"EDITOR={editor}", bun,
            str(fixture.options.root / "acceptance/assignment-input.ts"),
            attempt, str(sessions), ADMITTED_MODEL.provider, ADMITTED_MODEL.id,
        ],
    ))

    def screen() -> str:
        return terminal.capture_pane(pane, full=True)

    def type_line(text: str, *submit: int) -> None:
        terminal.send_to_pane(pane, text)
        terminal.write_to_pane(pane, *(submit or (13,)))

    terminal.until("Pi reached loopback provider", AssignmentProvider.started.is_set)
    matching = [item for item in terminal.terminals() if item["tab_id"] == tab]
    assert {item["id"] for item in matching} == {lead, pane}
    assert next(item for item in matching if item["id"] == lead)["is_focused"]
    type_line(GUIDANCE)
    terminal.until("native steer queue", lambda: "Steering:" in screen() and GUIDANCE in screen())
    command = f"touch {shlex.quote(str(shell_marker))}"
    for count, text in enumerate((f"!{command}", f"!!{command}", "/reload", "/resume", "/new", "/fork", "/tree"), 1):
        type_line(text)
        terminal.until(f"blocked command {count}", lambda: screen().count(BLOCKED) == count)
        if count == 1:
            (fixture.artifacts / "assignment-queued.ansi").write_text(
                terminal.capture_pane(pane, ansi=True)
            )
    # Use the enhanced encoding for Alt+Enter so Escape is never parsed as a separate key.
    type_line(f"!{command}", *b"\x1b[13;3u")
    terminal.until("blocked command through follow-up", lambda: screen().count(BLOCKED) == 8)
    terminal.write_to_pane(pane, 7)  # Ctrl+G invokes the external editor in ordinary Pi.
    terminal.write_to_pane(pane, *b"\x1b[15~")  # Remapped new-session shortcut.
    terminal.write_to_pane(pane, *b"\x1b[17~")  # Remapped resume shortcut.
    assert "Steering:" in screen()
    AssignmentProvider.continue_turn.set()
    terminal.until("provider consumed guidance", lambda: "Guidance applied in the assigned turn." in screen())
    terminal.write_to_pane(pane, 27)
    terminal.pty.drain(0.12)
    terminal.write_to_pane(pane, 27)  # Idle double Escape would open the tree.
    terminal.pty.drain(0.12)
    type_line("/quit")
    terminal.until("assigned pane exited", lambda: all(
        item["id"] != pane or item["exited"] for item in terminal.terminals()
    ))
    stale = "input for the exited pane"
    try:
        terminal.send_to_pane(pane, stale)
    except CalledProcessError as error:
        assert "pane" in error.stderr.lower(), error.stderr
    assert stale not in terminal.capture_pane(lead, full=True)
    assert not editor_marker.exists()
    assert not shell_marker.exists()
    assert len(AssignmentProvider.requests) == 2, AssignmentProvider.requests
    transcript, = sessions.glob("*.jsonl")
    entries = [json.loads(line) for line in transcript.read_text().splitlines()]
    assert entries[0]["id"] == attempt
    user_inputs = [entry["message"] for entry in entries
                   if entry.get("message", {}).get("role") == "user"]
    assert [message_text(message) for message in user_inputs] == ["Begin the assigned turn.", GUIDANCE]
    (fixture.artifacts / "assignment-transcript.jsonl").write_bytes(transcript.read_bytes())
    report["assignment_input"] = {"session": attempt, "tab": tab, "pane": pane, "requests": 2}
