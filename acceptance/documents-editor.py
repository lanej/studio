#!/usr/bin/env python3
"""Exercise Studio's editor adapter in a real, isolated Neovim against a controlled Unix socket."""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import shutil
import socketserver
import subprocess
import tempfile
import threading


ROOT = Path(__file__).resolve().parents[1]


class Fixture:
    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.lock = threading.RLock()
        self.phase = ""
        self.ref = {
            "ownerKind": "discovery",
            "ownerId": "document-a",
            "conversationId": "conversation-a",
            "project": str(directory),
            "kind": "specification",
        }
        self.document = {
            "ref": self.ref,
            "revision": "revision-1",
            "markdown": "# Specification\n\nOriginal requirement\n",
            "writable": True,
            "path": str(directory / "specification.md"),
        }
        self.feedback: dict[str, dict] = {}
        self.saves: dict[str, dict] = {}
        self.save_requests: list[dict] = []
        self.counter = 1
        self.dropped = False

    def change_phase(self) -> None:
        phase_path = self.directory / "phase"
        phase = phase_path.read_text().strip() if phase_path.exists() else ""
        if phase == self.phase:
            return
        self.phase = phase
        if phase == "clean-update":
            self.document["revision"] = "revision-2"
            self.document["markdown"] = "# Specification\n\nUpdated requirement\n"
        elif phase == "conflicting-update":
            self.document["revision"] = "revision-conflict"
            self.document["markdown"] = "# Specification\n\nIncoming requirement\n"
        elif phase == "answered":
            self.document["revision"] = "revision-answer"
            self.document["markdown"] = "# Specification\n\nRevised from the selected comment\n"
            for feedback in self.feedback.values():
                feedback.update(
                    state="answered",
                    summary="Clarified the selected requirement",
                    responseId="native-response",
                    changes=[{
                        "ref": self.ref,
                        "beforeRevision": feedback["baseRevision"],
                        "afterRevision": "revision-answer",
                        "range": {"startLine": 3, "endLine": 3},
                    }],
                )
        elif phase == "switch-owner":
            self.document = {
                **self.document,
                "ref": {**self.ref, "ownerId": "document-b"},
                "revision": "other-revision",
                "path": str(self.directory / "other.md"),
                "markdown": "# Other discovery\n",
            }

    def handle(self, request: dict) -> dict | None:
        assert request["token"] == "fixture-token"
        assert request["generation"] == "fixture-generation"
        method, params = request["method"], request.get("params", {})
        with self.lock:
            self.change_phase()
            if method == "register":
                (self.directory / "registered").write_text(json.dumps(params))
                return {"registered": True}
            if method == "sync":
                return {"documents": [copy.deepcopy(self.document)], "feedback": list(self.feedback.values())}
            if method == "feedback":
                existing = self.feedback.get(params["requestId"])
                if existing is None:
                    existing = {**params, "state": "queued", "changes": []}
                    self.feedback[params["requestId"]] = existing
                (self.directory / "feedback.json").write_text(json.dumps(list(self.feedback.values())))
                return existing
            if method != "save":
                raise ValueError("Unknown fixture method")
            self.save_requests.append(params)
            (self.directory / "save-requests.json").write_text(json.dumps(self.save_requests))
            if params["operationId"] in self.saves:
                return self.saves[params["operationId"]]
            if params["ref"] != self.ref:
                raise ValueError("Wrong document owner")
            if params["expectedRevision"] != self.document["revision"]:
                raise ValueError("The document changed")
            if "INVALID" in params["markdown"]:
                raise ValueError("Invalid draft")
            self.counter += 1
            self.document = {
                **self.document,
                "revision": f"saved-{self.counter}",
                "markdown": params["markdown"],
            }
            result = copy.deepcopy(self.document)
            self.saves[params["operationId"]] = result
            if "Delayed candidate" in params["markdown"]:
                # Release the lock while the editor receives more input.
                self.lock.release()
                try:
                    threading.Event().wait(0.25)
                finally:
                    self.lock.acquire()
            if "Uncertain candidate" in params["markdown"] and not self.dropped:
                self.dropped = True
                return None
            return result


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


class Handler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        request = json.loads(self.rfile.readline(4 * 1024 * 1024))
        try:
            result = self.server.fixture.handle(request)  # type: ignore[attr-defined]
            if result is None:
                return
            reply = {"id": request["id"], "ok": True, "result": result}
        except ValueError as error:
            reply = {"id": request["id"], "ok": False, "error": {"code": "conflict", "message": str(error)}}
        self.wfile.write(json.dumps(reply).encode() + b"\n")


SCENARIO = r"""
local fixture = vim.env.STUDIO_EDITOR_FIXTURE
local function check(condition, message)
  if not condition then error(message) end
end
local function wait_for(callback, message)
  check(vim.wait(3000, callback, 10), message)
end
local function phase(value)
  vim.fn.writefile({ value }, fixture .. "/phase")
  require("studio_documents").sync()
end
local function read_json(name)
  return vim.json.decode(table.concat(vim.fn.readfile(fixture .. "/" .. name), "\n"))
end
local function text(buffer)
  return table.concat(vim.api.nvim_buf_get_lines(buffer, 0, -1, false), "\n")
end
local function edit(buffer, line)
  vim.api.nvim_buf_set_lines(buffer, 2, 3, false, { line })
end

check(vim.g.studio_fixture_init == "loaded", "The normal initialization file was skipped")
wait_for(function() return vim.b.studio_document_ref ~= nil end, "Initial document did not open")
local buffer = vim.api.nvim_get_current_buf()
local dashboard = vim.fn.bufnr("fixture-dashboard")
check(dashboard ~= -1 and text(dashboard) == "Startup dashboard", "Startup buffer was discarded")
check(text(buffer):find("Original requirement", 1, true), "Full document text is missing")
wait_for(function() return vim.fn.filereadable(fixture .. "/registered") == 1 end, "Editor did not register")
local registration = read_json("registered")
check(registration.pid == vim.fn.getpid(), "Registration did not carry actual editor identity")

vim.api.nvim_win_set_cursor(0, { 3, 2 })
phase("clean-update")
wait_for(function() return text(buffer):find("Updated requirement", 1, true) ~= nil end, "Clean update did not arrive")
check(vim.api.nvim_win_get_cursor(0)[1] == 3, "Clean refresh moved the cursor")
check(not vim.bo[buffer].modified, "Clean refresh was marked unsaved")

edit(buffer, "Saved from Neovim")
vim.cmd("write")
wait_for(function() return not vim.bo[buffer].modified end, "Explicit save did not complete")
check(read_json("save-requests.json")[1].markdown:find("Saved from Neovim", 1, true), "Save did not carry editor text")

edit(buffer, "Delayed candidate")
vim.cmd("write")
vim.defer_fn(function() edit(buffer, "Newer edits during save") end, 50)
wait_for(function()
  return #read_json("save-requests.json") >= 2 and text(buffer):find("Newer edits during save", 1, true) ~= nil
end, "Did not exercise an in-flight save edit")
vim.wait(350)
check(vim.bo[buffer].modified, "Acknowledgment marked newer buffer text clean")
phase("conflicting-update")
vim.wait(650)
check(text(buffer):find("Newer edits during save", 1, true), "Incoming revision overwrote dirty edits")
vim.cmd("StudioCompare")
check(#vim.api.nvim_tabpage_list_wins(0) == 2, "Conflict comparison did not open")
check(text(vim.api.nvim_win_get_buf(vim.api.nvim_tabpage_list_wins(0)[2])) ~= "", "Incoming comparison is empty")
edit(buffer, "Manually merged requirement")
vim.cmd("StudioResolve")
vim.cmd("write")
wait_for(function() return not vim.bo[buffer].modified end, "Merged draft was not accepted")

edit(buffer, "INVALID draft")
vim.cmd("write")
vim.wait(150)
check(vim.bo[buffer].modified and text(buffer):find("INVALID", 1, true), "Rejected edit was discarded or marked clean")
vim.cmd("StudioReload!")
check(not vim.bo[buffer].modified and text(buffer):find("Manually merged requirement", 1, true), "Explicit reload failed")

edit(buffer, "Uncertain candidate")
vim.cmd("write")
vim.wait(200)
edit(buffer, "Newer text after uncertain save")
vim.cmd("write")
vim.wait(200)
local saves = read_json("save-requests.json")
check(saves[#saves].operationId == saves[#saves - 1].operationId, "Uncertain save retry used a new operation")
check(vim.bo[buffer].modified and text(buffer):find("Newer text after uncertain save", 1, true), "Reconciliation lost newer edits")
vim.cmd("write")
wait_for(function() return not vim.bo[buffer].modified end, "Newer reconciled text did not save")

edit(buffer, "Unsaved selected feedback")
local save_count = #read_json("save-requests.json")
vim.ui.input = function(_, callback) callback("Is this something we really want?") end
vim.cmd("3StudioComment")
wait_for(function() return vim.fn.filereadable(fixture .. "/feedback.json") == 1 end, "Selection feedback did not arrive")
local feedback = read_json("feedback.json")
check(#feedback == 1 and feedback[1].selectedText == "Unsaved selected feedback", "Feedback omitted actual unsaved selection")
check(feedback[1].message == "Is this something we really want?", "Feedback omitted operator message")
check(feedback[1].ref.ownerId == "document-a", "Feedback went to a different owner")
check(#read_json("save-requests.json") == save_count, "Commenting implicitly saved the draft")
vim.ui.input = function(_, callback) callback(nil) end
vim.cmd("3StudioComment")
vim.wait(100)
check(#read_json("feedback.json") == 1, "Cancelled comment was submitted")
vim.cmd("write")
wait_for(function() return not vim.bo[buffer].modified end, "Selected document did not save")

phase("answered")
wait_for(function() return text(buffer):find("Revised from the selected comment", 1, true) ~= nil end, "Answered edit was not refreshed")
vim.ui.select = function(items, _, callback) callback(items[1]) end
vim.api.nvim_win_set_cursor(0, { 1, 0 })
vim.cmd("StudioChanges")
check(vim.api.nvim_win_get_cursor(0)[1] == 3, "Outcome navigation missed the changed section")
local marks = vim.api.nvim_buf_get_extmarks(buffer, vim.api.nvim_create_namespace("StudioDocuments"), 0, -1, { details = true })
local answered = false
for _, mark in ipairs(marks) do
  for _, chunk in ipairs(mark[4].virt_text or {}) do
    if chunk[1]:find("Answered", 1, true) then answered = true end
  end
end
check(answered, "Compact answered outcome is missing")

local current_window = vim.api.nvim_get_current_win()
phase("switch-owner")
vim.wait(650)
check(vim.api.nvim_get_current_buf() == buffer and vim.api.nvim_get_current_win() == current_window, "New discovery stole editor focus")
edit(buffer, "Old discovery edit")
local before = #read_json("save-requests.json")
vim.cmd("write")
vim.wait(100)
check(#read_json("save-requests.json") == before and vim.bo[buffer].modified, "Old document was silently retargeted")
require("studio_documents").stop()
vim.fn.writefile({ "passed" }, fixture .. "/result")
vim.cmd("qa!")
"""


def main() -> None:
    executable = shutil.which("nvim")
    if executable is None:
        raise SystemExit("documents-editor acceptance requires nvim")
    # Short paths avoid macOS's Unix socket path limit.
    with tempfile.TemporaryDirectory(prefix="studio-editor-", dir="/tmp") as raw:
        directory = Path(raw)
        runtime = Path(os.environ.get("STUDIO_EDITOR_RUNTIME", str(ROOT / "resources/nvim"))).resolve()
        connection = directory / "connection.json"
        connection.write_text(json.dumps({
            "socket": str(directory / "s"),
            "token": "fixture-token",
            "generation": "fixture-generation",
        }))
        (directory / "init.lua").write_text('vim.g.studio_fixture_init = "loaded"\nvim.o.swapfile = false\nvim.cmd("file fixture-dashboard")\nvim.api.nvim_buf_set_lines(0,0,-1,false,{"Startup dashboard"})\nvim.bo.modified = false\n')
        (directory / "scenario.lua").write_text(SCENARIO)
        server = Server(str(directory / "s"), Handler)
        server.fixture = Fixture(directory)  # type: ignore[attr-defined]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            environment = {
                **os.environ,
                "HOME": str(directory / "home"),
                "XDG_CONFIG_HOME": str(directory / "config"),
                "XDG_DATA_HOME": str(directory / "data"),
                "XDG_STATE_HOME": str(directory / "state"),
                "XDG_CACHE_HOME": str(directory / "cache"),
                "NVIM_LOG_FILE": str(directory / "nvim.log"),
                "STUDIO_NVIM_RUNTIME": str(runtime),
                "STUDIO_DOCUMENT_CONNECTION": str(connection),
                "STUDIO_EDITOR_FIXTURE": str(directory),
            }
            result = subprocess.run([
                executable, "--headless", "-i", "NONE", "-u", str(directory / "init.lua"),
                "-c", "lua dofile(vim.env.STUDIO_NVIM_RUNTIME .. '/bootstrap.lua')",
                "-c", "lua local ok,err=pcall(dofile,vim.env.STUDIO_EDITOR_FIXTURE .. '/scenario.lua'); if not ok then vim.api.nvim_err_writeln(err); vim.cmd('cquit 1') end",
            ], env=environment, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=20)
            if result.returncode != 0 or not (directory / "result").exists():
                raise AssertionError(f"Neovim document acceptance failed ({result.returncode}):\n{result.stdout}")
            print("Native Neovim adapter passed: initialized config, save, delayed/uncertain acknowledgments, dirty conflict, selected feedback, outcome navigation, and stale owner.")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    main()
