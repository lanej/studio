"""Native Zellij approval, guarded claim, Pi steering, review and pane-loss acceptance."""

import json
import shlex
import sqlite3
import subprocess
import time
from pathlib import Path
from threading import Event
from urllib.request import Request, urlopen

from local_fixture import Fixture, Report
from local_provider import Provider, TextDelta, ToolDelta, tool_delta
from socrates_fixture import CompletionRequest, message_text
from zellij_terminal import Terminal

GUIDANCE = "Use the agreed marker. Keep all changes inside your owned path."
TASKS = [
    {
        "key": "first", "title": "Write accepted marker",
        "description": "Use the operator guidance to create first.txt.",
        "acceptance": "first.txt contains the accepted marker.",
        "owns": ["first.txt"], "check": ["/usr/bin/grep", "-qx", "accepted marker", "first.txt"],
    },
    {
        "key": "second", "title": "Consume accepted marker",
        "description": "Read first.txt before writing second.txt.",
        "acceptance": "second.txt reflects the accepted marker.",
        "owns": ["second.txt"], "check": ["/usr/bin/test", "-f", "second.txt"],
        "blockedBy": ["first"],
    },
    {
        "key": "held", "title": "Hold until the target is gone",
        "description": "Create third.txt when released.",
        "acceptance": "third.txt is present.",
        "owns": ["third.txt"], "check": ["/usr/bin/test", "-f", "third.txt"],
        "hold": True,
    },
]


QUESTION = "Should the second worker consume the first worker's marker?"
WAIT = "Wait for first.txt"
COVERAGE = {
    "problem-first": "Two workers must agree which marker is authoritative.",
    "interpretation": "D1 specifies which result the second worker consumes.",
    "clarity": "Each task names its output file and expected contents.",
    "scope": "Only first.txt, second.txt and third.txt are in scope.",
    "context": "The second worker runs in its own checkout.",
    "parsimony": "One predecessor edge transfers the accepted change.",
    "success": "R1 requires verified output in the dependent checkout.",
    "verification": "Each task has an executable check on its own output.",
    "constraints": "The third worker stays on hold until explicitly released.",
    "stakeholders": "The operator approves and steers the interactive workers.",
    "risk": "The ownership check fences writes outside each named output.",
    "execution-readiness": "Each worker has a named file, check and admission rule.",
    "harmony": "The dependency in the plan matches the operator decision D1.",
    "modularity": "Each worker owns one distinct output file.",
    "policy-mechanism-separation": "D1 sets the dependency and Beads enforces readiness.",
    "robustness": "The worker must pass verification and review before satisfying the dependency.",
    "repair": "A lost worker pane must preserve the checkout and claim for inspection.",
    "least-surprise": "Operator guidance remains in the selected worker's pane.",
    "regression-protection": "The interactive fixture exercises dependency gating and pane loss.",
}


def dispatch_spec(resolved: bool) -> dict:
    return {
        "objective": "Verify the interactive marker handoff.",
        "scope": ["The three named marker files in disposable worktrees"],
        "requirements": [{"id": "R1", "outcome": "Produce the three agreed marker files.",
                          "acceptance": "Each per-task check passes and the held worker waits for release."}],
        "decisions": [{"id": "D1", "decision": "Choose the source of the second worker's marker.",
                       "basis": "decided" if resolved else "observed",
                       "evidence": WAIT if resolved else "The task brief leaves the marker source open.",
                       "disposition": "resolved" if resolved else "open",
                       "uncertainty": "None" if resolved else "The answer determines the dependency edge."}],
        "blockingQuestions": [] if resolved else [QUESTION],
        "coverage": {"domains": ["engineering"], "assessments": [
            {"propertyId": key, "status": "satisfied", "reason": reason}
            for key, reason in COVERAGE.items()
        ] if resolved else [{"propertyId": "execution-readiness", "status": "partial",
                             "reason": "D1 determines whether the second worker can start independently."}]},
    }


def dispatch_plan(ordered: bool) -> dict:
    tasks = [dict(task, requirements=["R1"]) for task in TASKS]
    if not ordered:
        tasks[1].pop("blockedBy")
        tasks[1]["description"] = "The marker source is pending decision D1."
    return {"summary": "Exercise guarded interactive delivery", "tasks": tasks}


def discovery_response(request: CompletionRequest) -> ToolDelta | TextDelta:
    last = request["messages"][-1]
    if last["role"] == "user":
        if message_text(last).startswith("Begin Socrates discovery"):
            return tool_delta("open-spec", "draft_socrates_specification", dispatch_spec(False))
        # A host that requests another plan after freeze receives the reviewed graph.
        assert "froze" in message_text(last), last
        return tool_delta("frozen-plan", "draft_implementation_plan", dispatch_plan(True))
    assert last["role"] == "tool", last
    result = message_text(last)
    call = last.get("tool_call_id")
    if call == "open-spec":
        assert "Draft saved" in result, result
        return tool_delta("provisional-plan", "draft_implementation_plan", dispatch_plan(False))
    if call == "provisional-plan":
        assert "Draft saved" in result, result
        return tool_delta("ask-dependency", "ask_user_question", {
            "decisionId": "D1", "question": QUESTION, "options": [
                {"label": WAIT, "description": "Consume the accepted result after verification."},
                {"label": "Generate independently", "description": "Start both workers immediately."},
            ],
        })
    if call == "ask-dependency":
        assert WAIT in result, result
        return tool_delta("resolved-spec", "draft_socrates_specification", dispatch_spec(True))
    if call == "resolved-spec":
        assert "Properties satisfied" in result, result
        return tool_delta("updated-plan", "draft_implementation_plan", dispatch_plan(True))
    assert call in ("updated-plan", "frozen-plan") and "Draft saved" in result, last
    reply = "The frozen plan is ready for approval." if call == "frozen-plan" else "The dependency is recorded in the plan."
    return {"role": "assistant", "content": reply}


class DispatchProvider(Provider):
    first = Event()
    release_first = Event()
    reviewer = Event()
    release_reviewer = Event()
    second = Event()
    release_second = Event()

    def do_POST(self) -> None:
        try:
            super().do_POST()
        except BrokenPipeError:
            if not self.second.is_set():
                raise

    def respond(self, request: CompletionRequest) -> ToolDelta | TextDelta:
        messages = request["messages"]
        names = {tool["function"]["name"] for tool in request["tools"]}
        user = [message_text(item) for item in messages if item["role"] == "user"]
        tools = [message_text(item) for item in messages if item["role"] == "tool"]
        if "draft_implementation_plan" in names:
            return discovery_response(request)
        assert not names.intersection({"bash", "powershell", "subagent", "task_submit_result"}), names
        if "review_context" in names:
            assert not names.intersection({"edit", "write"}), names
            if not tools:
                assert "exitCode\":0" in user[0], user
                self.reviewer.set()
                assert self.release_reviewer.wait(60)
                return tool_delta("read-revision", "read", {"path": "first.txt"})
            if len(tools) == 1:
                assert "accepted marker" in tools[0], tools
                return tool_delta("record-cold-read", "review_context", {
                    "behavior": "The first line of first.txt contains the marker.",
                    "changeSite": "Change the first line of first.txt and keep it newline-terminated.",
                })
            return {"role": "assistant", "content": '{"approved":true,"summary":"Verified marker at first.txt:1"}'}
        assert {"write", "edit", "read"} <= names, names
        if "Consume accepted marker" in user[0]:
            self.second.set()
            assert self.release_second.wait(60)
            return {"role": "assistant", "content": '{"summary":"Worker should exit before this response"}'}
        assert "Write accepted marker" in user[0], user
        if not tools:
            self.first.set()
            assert self.release_first.wait(60)
            return tool_delta("try-outside-scope", "write", {"path": "outside.txt", "content": "refused"})
        assert user.count(GUIDANCE) == 1, user
        if len(tools) == 1:
            assert "outside the accepted ownership scope" in tools[0], tools
            return tool_delta("write-accepted", "write", {"path": "first.txt", "content": "accepted marker\n"})
        return {"role": "assistant", "content": '{"summary":"Wrote the accepted marker at first.txt:1"}'}


def exercise_interactive_dispatch(fixture: Fixture, terminal: Terminal, lead: int, tab: int, report: Report) -> None:
    source = fixture.options.beads

    def get(path: str) -> dict:
        request = Request(source["url"] + "/v0/beads/" + path,
                          headers={"Bd-Project-Id": source["projectId"]})
        with urlopen(request, timeout=3) as response:
            return json.load(response)

    configuration = Path(fixture.env["STUDIO_CONFIG"])
    config = json.loads(configuration.read_text())
    config["runtime"] = {
        "enabled": True, "concurrency": 1, "pollMs": 1000,
        "projects": [{
            "root": str(fixture.options.repository.resolve()), "source": source,
            "base": "HEAD", "profile": "personal", "beadsWorkspace": str(fixture.options.repository),
            "beadsExecutable": fixture.options.bd, "beadsDatabase": get("context")["database"],
        }],
    }
    configuration.write_text(json.dumps(config))
    fixture.execute(["git", "config", "user.name", "Interactive fixture"])
    fixture.execute(["git", "config", "user.email", "fixture@example.invalid"])
    fixture.execute([fixture.options.bd, "-C", str(fixture.options.repository), "context", "--json"])

    def state() -> dict:
        return json.loads(fixture.execute([fixture.driver, "runtime", "status"]).stdout)

    def attempt(key: str) -> dict:
        return next((item for item in state()["attempts"] if item.get("bead", {}).get("id", "").endswith("." + key)), {})

    def type_line(pane: int, text: str) -> None:
        terminal.send_to_pane(pane, text)
        terminal.write_to_pane(pane, 13)

    def capture(pane: int = lead) -> str:
        return terminal.capture_pane(pane, full=True)

    def no_pane(pane: int) -> bool:
        return all(item["id"] != pane or item["exited"] for item in terminal.terminals())

    def confirm_review(action: str) -> None:
        for _ in range(20):
            if f"Enter {action}" in terminal.capture_pane(lead):
                terminal.write_to_pane(lead, 13)
                return
            terminal.write_to_pane(lead, 13)
            terminal.pty.drain(0.15)
        raise AssertionError(f"Review action {action} did not appear")

    diagnostics = fixture.artifacts / "interactive-supervisor.log"
    with diagnostics.open("w") as log, subprocess.Popen(
        ["bun", str(fixture.options.root / "acceptance/interactive-supervisor.ts")],
        cwd=fixture.options.repository, env=fixture.env, stdout=log, stderr=subprocess.STDOUT,
    ) as supervisor:
        try:
            terminal.until("fixture supervisor", lambda: state()["live"])
            terminal.pty.send(b"\x1b")  # Dismiss Zellij's first-run overlay in the owned fixture.
            terminal.pty.drain(0.2)
            type_line(lead, f"cd {shlex.quote(str(fixture.options.repository))} && exec "
                      f"{shlex.quote(fixture.driver)} lead -- --offline --no-mcp --model openai-codex/gpt-6.1-sol")
            terminal.until("native lead", lambda: "⊛ 6.1" in capture())
            type_line(lead, "/studio-profile personal")
            terminal.pty.drain(0.35)
            type_line(lead, "/socrates Interactive acceptance")
            terminal.until("operator decision opens", lambda: WAIT in capture() and "Generate independently" in capture())
            database = Path(fixture.env["STUDIO_STATE_DIR"]) / "discoveries.sqlite"

            def discovery() -> dict:
                with sqlite3.connect(database) as db:
                    [row] = db.execute("SELECT record FROM discoveries")
                return json.loads(row[0])

            provisional = discovery()
            assert provisional["specification"]["status"] == "interrogating"
            assert provisional["leadPlan"]["draft"]["tasks"][1]["blockedBy"] == []
            assert get("issues")["items"] == []
            terminal.write_to_pane(lead, 13)
            terminal.until("operator decision incorporated", lambda: "The dependency is recorded in the plan." in capture())
            assert discovery()["leadPlan"]["draft"]["tasks"][1]["blockedBy"] == ["first"]
            type_line(lead, "/spec-freeze")
            terminal.until("operator reviews specification", lambda: "Freeze specification" in capture())
            confirm_review("freeze spec")
            terminal.until("frozen plan settled", lambda: "The frozen plan is ready for approval." in capture())
            assert discovery()["specification"]["status"] == "frozen"
            type_line(lead, "/plan-approve interactive")
            terminal.until("review displays verified target", lambda:
                           f"interactive in Zellij {fixture.name}, tab {tab}" in " ".join(capture().split()))
            (fixture.artifacts / "interactive-approval.ansi").write_text(terminal.capture_pane(lead, ansi=True))
            assert get("issues")["items"] == []
            confirm_review("create tasks and implement")
            terminal.until("first native worker after lost acknowledgement", DispatchProvider.first.is_set)
            first = attempt("first")
            pane = first["pane"]
            assert first["phase"] == "running" and first["workerSessionFile"]
            assert not attempt("second"), state()
            assert any(item["id"] == lead and item["is_focused"] for item in terminal.terminals())
            assert {item["id"] for item in terminal.terminals()} == {lead, pane}
            assert "Withheld launch acknowledgement" in diagnostics.read_text()
            type_line(lead, "/tasks " + first["bead"]["id"])
            terminal.until("task inspector offers existing pane", lambda: "focus worker pane" in capture().lower())
            terminal.write_to_pane(lead, *b"\x1b[116;3u")  # Alt+T
            terminal.write_to_pane(lead, *b"\x1b[C")  # Right
            terminal.until("task inspector focuses the worker", lambda:
                           any(item["id"] == pane and item["is_focused"] for item in terminal.terminals()))
            type_line(pane, GUIDANCE)
            terminal.until("guidance queued", lambda: "Steering:" in capture(pane))
            (fixture.artifacts / "interactive-worker.ansi").write_text(terminal.capture_pane(pane, ansi=True))
            DispatchProvider.release_first.set()
            terminal.until("independent review started", DispatchProvider.reviewer.is_set)
            assert attempt("first")["verification"]["exitCode"] == 0
            assert not attempt("second")
            type_line(pane, "Guidance after the worker settled")
            DispatchProvider.release_reviewer.set()
            terminal.until("dependent worker starts after integration", DispatchProvider.second.is_set)
            first = attempt("first")
            second = attempt("second")
            assert first["phase"] == "complete" and first["review"] and first["integrationReview"], first
            assert get("issues/" + first["bead"]["id"])["status"] == "closed"
            checkout = Path(first["checkout"]["path"])
            assert (checkout / "first.txt").read_text() == "accepted marker\n"
            assert not (checkout / "outside.txt").exists()
            assert not (fixture.options.repository / "first.txt").exists()
            transcript = Path(first["workerSessionFile"]).read_text()
            assert transcript.count(GUIDANCE) == 1 and "Guidance after the worker settled" not in transcript
            assert no_pane(pane)
            (fixture.artifacts / "interactive-transcript.jsonl").write_text(transcript)
            # A completed pane cannot receive another turn or steer its independent reader.
            stale = "Stale guidance for the completed worker"
            try:
                terminal.send_to_pane(pane, stale)
            except subprocess.CalledProcessError as error:
                assert "pane" in error.stderr.lower(), error.stderr
            assert stale not in capture(lead)
            assert Path(first["workerSessionFile"]).read_text() == transcript
            reviewer_requests = [request for request in DispatchProvider.requests
                                 if any(tool["function"]["name"] == "review_context"
                                        for tool in request["tools"])]
            assert reviewer_requests
            assert all("Guidance after the worker settled" not in json.dumps(request)
                       and stale not in json.dumps(request) for request in reviewer_requests)

            def refused_replacement(key: str, retained: dict) -> dict:
                panes_before = {item["id"] for item in terminal.terminals()}
                result = fixture.execute(
                    [fixture.driver, "runtime", "retry", retained["id"]], check=False,
                )
                assert {item["id"] for item in terminal.terminals()} == panes_before
                assert result.returncode != 0, result
                assert "Interactive attempts retain their original pane binding" in result.stderr, result.stderr
                current = attempt(key)
                for field in ("id", "phase", "pane", "launchToken", "checkout", "workerSessionFile"):
                    assert current.get(field) == retained.get(field), (field, current, retained)
                matches = [item for item in state()["attempts"]
                           if item.get("bead", {}).get("id") == retained["bead"]["id"]]
                assert len(matches) == 1, matches
                return {"attempt": retained["id"], "phase": retained["phase"],
                        "exitCode": result.returncode, "reason": result.stderr.strip(),
                        "sameBinding": True, "attemptCount": len(matches)}

            completed_retry = refused_replacement("first", first)
            second_pane = second["pane"]
            fixture.execute([fixture.binary, "--session", fixture.name, "action", "close-pane",
                             "--pane-id", f"terminal_{second_pane}"])
            terminal.until("exited worker parked", lambda: attempt("second").get("phase") == "needs-review")
            parked = attempt("second")
            assert parked["id"] == second["id"] and parked["launchToken"] == second["launchToken"]
            assert parked["checkout"] == second["checkout"] and no_pane(second_pane)
            assert get("issues/" + second["bead"]["id"])["status"] == "in_progress"
            parked_retry = refused_replacement("second", parked)
            # Retain the verified result on the fixture's main ref before the manager prunes.
            fixture.execute(["git", "merge", "--ff-only", first["integration"]])
            held_id = first["bead"]["id"].rsplit(".", 1)[0] + ".held"
            assert get("issues/" + held_id)["status"] == "deferred"
            fixture.execute([fixture.binary, "kill-session", fixture.name])
            fixture.execute([fixture.options.bd, "--sandbox", "update", held_id, "--status", "open"])
            terminal.until("released task parks when the Zellij target is gone",
                           lambda: attempt("held").get("phase") == "needs-review")
            unavailable = attempt("held")
            assert "Approved Zellij target unavailable" in unavailable["message"], unavailable
            assert unavailable.get("launchToken") is None and unavailable.get("checkout") is None
            assert diagnostics.read_text().count("Withheld launch acknowledgement") == 2
            report["interactive_dispatch"] = {
                "first": first, "parked": parked, "unavailable": unavailable, "lostAcknowledgements": 2,
                "replacementRejections": [completed_retry, parked_retry],
                "sameTaskSuccessor": "unavailable: supported retry preserves the original interactive binding",
                "completedPaneInputIsolated": True, "reviewerNotSteered": True,
            }
        except Exception:
            try:
                for item in terminal.terminals():
                    (fixture.artifacts / f"pane-{item['id']}.txt").write_text(capture(item["id"]))
            except (subprocess.CalledProcessError, RuntimeError):
                pass  # The unavailable-target case intentionally shuts down the fixture server.
            (fixture.artifacts / "runtime-status.json").write_text(json.dumps(state(), indent=2))
            raise
        finally:
            supervisor.terminate()
            try:
                supervisor.wait(timeout=10)
            except subprocess.TimeoutExpired:
                supervisor.kill()
                supervisor.wait(timeout=5)
            for release in (DispatchProvider.release_first, DispatchProvider.release_reviewer, DispatchProvider.release_second):
                release.set()
