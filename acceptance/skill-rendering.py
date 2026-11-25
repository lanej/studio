# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte", "pillow"]
# ///
"""Native builtin-read skill presentation; disposable loopback provider, no external inference."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
from http.server import ThreadingHTTPServer
from threading import Thread

from local_provider import Provider, tool_delta
from socrates_fixture import message_text

ROOT = Path(__file__).resolve().parents[1]
DOCUMENT = "# Skill heading\n\n- first item\n- **second item**\n\n[Documentation](https://example.com/skill)\n\n```ts\nconst answer = 42;\n```\n"


class SkillProvider(Provider):
    requests = []

    def respond(self, request):
        names = {tool["function"]["name"] for tool in request["tools"]}
        assert "read" in names, names
        step = len(self.requests)
        if step == 1:
            return tool_delta("skill-read", "read", {"path": "skills/demo/SKILL.md"})
        if step == 2:
            assert message_text(request["messages"][-1]) == DOCUMENT
            return {"role": "assistant", "content": "Skill result ready."}
        paths = {3: ("ordinary-read", {"path": "ordinary.md"}),
                 4: ("missing-read", {"path": "missing/SKILL.md"}),
                 5: ("range-read", {"path": "skills/demo/SKILL.md", "limit": 2}),
                 6: ("truncated-read", {"path": "large/SKILL.md"})}
        if step in paths:
            call, arguments = paths[step]
            return tool_delta(call, "read", arguments)
        assert step == 7, step
        assert "Showing lines" in message_text(request["messages"][-1])
        return {"role": "assistant", "content": "Native read checks complete."}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location("native_terminal", ROOT / "acceptance/socrates-status.py")
    terminal_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(terminal_module)
    with tempfile.TemporaryDirectory(prefix="studio-skill-ui-") as temporary:
        home = Path(temporary)
        project, agent = home / "project", home / "agent"
        project.mkdir()
        (project / "skills/demo").mkdir(parents=True)
        (project / "large").mkdir()
        (project / "skills/demo/SKILL.md").write_text(DOCUMENT)
        (project / "ordinary.md").write_text("# Ordinary read stays literal\n")
        (project / "large/SKILL.md").write_text("# Truncated raw heading\n" * 2200)
        (agent / "themes").mkdir(parents=True)
        (agent / "themes/dotfiles.json").symlink_to(ROOT / "resources/theme.json")
        (agent / "settings.json").write_text(json.dumps({
            "theme": "dotfiles", "quietStartup": True, "packages": [str(ROOT)],
            "retry": {"enabled": False, "maxRetries": 0},
        }))
        config = home / "config.json"
        config.write_text("{}")
        env = {**os.environ, "HOME": str(home), "PI_CODING_AGENT_DIR": str(agent),
               "STUDIO_CONFIG": str(config), "STUDIO_STATE_DIR": str(home / "state"),
               "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0", "TERM": "xterm-256color",
               "COLORTERM": "truecolor", "LANG": "en_US.UTF-8"}
        seed = """import {SessionManager} from %s;
const s=SessionManager.create(%s);
s.appendMessage({role:'user',content:'Open the native skill-read fixture.',timestamp:Date.now()});
s.appendMessage({role:'assistant',content:[{type:'text',text:'Native fixture ready.'}],api:'openai-completions',provider:'fixture',model:'tiny',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()});
console.log(s.getSessionFile());""" % (json.dumps(str(ROOT / "node_modules/@earendil-works/pi-coding-agent/dist/index.js")), json.dumps(str(project)))
        session = subprocess.run(["bun", "--no-env-file", "-e", seed], cwd=ROOT, env=env,
                                 capture_output=True, text=True, check=True).stdout.strip()
        with ThreadingHTTPServer(("127.0.0.1", 0), SkillProvider) as server:
            server.daemon_threads = True
            (agent / "models.json").write_text(json.dumps({"providers": {"fixture": {
                "baseUrl": f"http://127.0.0.1:{server.server_port}/v1", "api": "openai-completions",
                "apiKey": "fixture", "models": [{"id": "tiny", "contextWindow": 32768, "maxTokens": 2048}],
            }}}))
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            terminal = terminal_module.Terminal(project, env, output, session, mode="regular", columns=100, rows=32)
            try:
                terminal.contains("Native fixture ready.")
                terminal.send("Read the representative skill.\r")
                terminal.contains("Skill result ready.")
                terminal.contains("[skill] demo")
                assert "# Skill heading" not in terminal.text()
                terminal.capture("skill-collapsed")
                terminal.send("\x0f")
                terminal.contains("const answer = 42;")
                assert "# Skill heading" not in terminal.text()
                assert "**second item**" not in terminal.text()
                terminal.capture("skill-expanded")
                terminal.resize(60, 32)
                terminal.contains("Documentation")
                terminal.contains("const answer = 42;")
                terminal.capture("skill-expanded")
                terminal.send("\x0f")
                terminal.wait(lambda: "Skill heading" not in terminal.text(), "Collapse retains the native compact read")
                terminal.contains("[skill] demo")
                terminal.capture("skill-collapsed")
                terminal.resize(100, 32)
                terminal.send("Read the fallback fixtures.\r")
                terminal.contains("Native read checks complete.")
                terminal.send("\x0f")
                terminal.contains("[Truncated:")
                terminal.capture("private-fallbacks")
                entries = [json.loads(line) for line in Path(session).read_text().splitlines()]
                results = {entry["message"]["toolCallId"]: entry["message"] for entry in entries
                           if entry.get("message", {}).get("role") == "toolResult"}
                assert results["skill-read"]["toolName"] == "read"
                assert results["skill-read"]["content"] == [{"type": "text", "text": DOCUMENT}]
                assert results["ordinary-read"]["content"] == [{"type": "text", "text": "# Ordinary read stays literal\n"}]
                assert results["missing-read"]["isError"] is True
                assert "more lines in file" in results["range-read"]["content"][0]["text"]
                assert results["truncated-read"]["details"]["truncation"]["truncated"] is True
                assert len(SkillProvider.requests) == 7
                (output / "private-transcript.jsonl").write_text(Path(session).read_text())
                (output / "private-provider-requests.json").write_text(json.dumps(SkillProvider.requests, indent=2))
                (output / "proof.json").write_text(json.dumps({
                    "nativePi": True, "producer": "builtin read of SKILL.md with native [skill] header",
                    "providerRequests": 7, "modelAndPersistedSkillBytesUnchanged": True,
                    "collapsedExpandedResize": [100, 60], "ordinaryReadErrorRangeTruncationRetained": True,
                    "captureMethod": "reconstruction of actual Pi PTY frames using existing native terminal renderer",
                    "externalInference": False,
                }, indent=2))
                print("Native builtin skill read, Markdown expansion, collapse/resize, unchanged result bytes and fallback receipts passed.")
            finally:
                pid = terminal.process.pid
                terminal.close()
                (output / "cleanup.json").write_text(json.dumps({"ownedPid": pid, "exited": terminal.process.poll() is not None}))
                server.shutdown()
                thread.join(timeout=5)


if __name__ == "__main__":
    main()
