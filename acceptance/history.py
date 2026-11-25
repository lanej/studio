# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte", "pillow"]
# ///
"""Exercise Studio's real Pi history, model picker and authored binding precedence."""
import argparse
import fcntl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import select
import struct
import subprocess
import sys
import tempfile
import termios
from threading import Thread
import time

import pyte
from PIL import Image, ImageDraw, ImageFont

parser = argparse.ArgumentParser()
parser.add_argument("--output", type=Path, default=Path(".aot/history"))
options = parser.parse_args()
root = Path(__file__).resolve().parents[1]
output = options.output.resolve()
output.mkdir(parents=True, exist_ok=True)
columns, rows = 100, 28
(output / "geometry.json").write_text(json.dumps({"columns": columns, "rows": rows}))
palette = json.loads((root / "resources/colors.json").read_text())

class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        assert request["model"] in {"history-a", "history-b"}, request["model"]
        self.server.models.append(request["model"])
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        response = {"id": "history-fixture", "object": "chat.completion.chunk", "created": 1,
                    "model": request["model"], "choices": [{"index": 0, "delta": {
                        "role": "assistant", "content": "History fixture replied."}, "finish_reason": "stop"}]}
        self.wfile.write(("data: " + json.dumps(response) + "\n\ndata: [DONE]\n\n").encode())

with tempfile.TemporaryDirectory(prefix="studio-history-native-") as directory, ThreadingHTTPServer(("127.0.0.1", 0), Provider) as provider:
    provider.models = []
    Thread(target=provider.serve_forever, daemon=True).start()
    home = Path(directory)
    agent = home / ".pi/agent"
    agent.mkdir(parents=True)
    project = home / "project"
    project.mkdir()
    probe = home / "probe.json"
    config = home / "studio.json"
    config.write_text(json.dumps({"idleCompaction": {"enabled": False}}))
    env = {"PATH": os.environ["PATH"], "HOME": str(home), "LANG": "en_US.UTF-8",
           "TERM": "xterm-256color", "COLORTERM": "truecolor", "PI_CODING_AGENT_DIR": str(agent),
           "STUDIO_CONFIG": str(config), "STUDIO_STATE_DIR": str(home / "state"),
           "STUDIO_HISTORY_PROBE": str(probe), "PI_TELEMETRY": "0", "PI_SKIP_VERSION_CHECK": "1",
           "BUN_RUNTIME_TRANSPILER_CACHE_PATH": "0"}
    for key in ("BUN_INSTALL", "BUN_INSTALL_CACHE_DIR"):
        if key in os.environ:
            env[key] = os.environ[key]
    for kind in ("CACHE", "CONFIG", "DATA", "STATE"):
        env[f"XDG_{kind}_HOME"] = str(home / f"xdg-{kind.lower()}")
    models = ["history-a", "history-b"]
    (agent / "models.json").write_text(json.dumps({"providers": {"fixture": {
        "baseUrl": f"http://127.0.0.1:{provider.server_port}/v1", "api": "openai-completions",
        "apiKey": "fixture", "models": [{"id": model} for model in models]}}}))
    subprocess.run([sys.executable, str(root / "scripts/configure.py"), str(root), str(agent)],
                   env=env, check=True, stdout=subprocess.DEVNULL)
    settings_path = agent / "settings.json"
    settings = json.loads(settings_path.read_text())
    settings.update({"enabledModels": [f"fixture/{model}" for model in models],
                     "retry": {"enabled": False}, "historyFixtureSentinel": "preserved"})
    settings_path.write_text(json.dumps(settings))
    keybindings = agent / "keybindings.json"
    master, slave = os.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
    process = subprocess.Popen([str(root / "scripts/studio"), "lead", "--", "--offline", "--no-mcp",
                                "--model", "fixture/history-a", "--extension", str(root / "acceptance/history-observer.ts")],
                               env=env, cwd=project, stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    screen = pyte.Screen(columns, rows)
    stream = pyte.ByteStream(screen)
    recorded = bytearray()

    def pump(seconds=.05):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if select.select([master], [], [], .02)[0]:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    return
                if not data:
                    return
                recorded.extend(data)
                stream.feed(data)
                if b"\x1b[0c" in data:
                    os.write(master, b"\x1b[?1;2c")
                if b"\x1b[?u" in data:
                    os.write(master, b"\x1b[?0u")
                if b"\x1b]11;?" in data:
                    os.write(master, b"\x1b]11;rgb:0000/0000/0000\x1b\\")

    def state():
        try:
            return json.loads(probe.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def wait(predicate, description, timeout=15):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            pump()
            if predicate():
                return state()
            if process.poll() is not None:
                break
        raise AssertionError(f"{description}: {state()}\n" + "\n".join(screen.display))

    def send(data):
        before = state().get("inputs", 0)
        generation = state().get("generation")
        os.write(master, data)
        return wait(lambda: state().get("inputs", 0) > before or state().get("generation") != generation, f"input {data!r}")

    def capture(name):
        pump(.15)
        (output / f"{name}.ansi").write_bytes(recorded)
        (output / f"{name}.txt").write_text("\n".join(screen.display))
        (output / f"{name}.json").write_text(json.dumps(state(), indent=2))
        try:
            font = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 16)
        except OSError:
            font = ImageFont.truetype("DejaVuSansMono.ttf", 16)
        width, height = 10, 21
        image = Image.new("RGB", (columns * width, rows * height), palette["roles"]["surface"])
        draw = ImageDraw.Draw(image)
        ansi = ["black", "red", "green", "brown", "blue", "magenta", "cyan", "white"]
        def color(value, fallback):
            if value == "default":
                return palette["roles"][fallback]
            if value in ansi:
                return palette["ansi"][ansi.index(value)]
            return "#" + value if len(value) == 6 else palette["roles"][fallback]
        for y in range(rows):
            for x in range(columns):
                cell = screen.buffer[y][x]
                foreground, background = color(cell.fg, "text"), color(cell.bg, "surface")
                if cell.reverse:
                    foreground, background = background, foreground
                draw.rectangle((x * width, y * height, (x + 1) * width - 1, (y + 1) * height - 1), fill=background)
                draw.text((x * width, y * height), cell.data, font=font, fill=foreground)
        image.save(output / f"{name}.png")

    def submit(prompt):
        settled = state().get("settled", 0)
        send(prompt.encode() + b"\r")
        wait(lambda: state().get("settled", 0) > settled, f"settled {prompt}")
        assert state()["text"] == "", state()

    def recall(key, expected, selected):
        before = state()["cycles"]
        send(key)
        wait(lambda: state().get("text") == expected, f"history {expected!r}")
        assert state()["selected"] == selected and state()["cycles"] == before, state()

    def reload(authored):
        if authored is None:
            keybindings.unlink(missing_ok=True)
        else:
            keybindings.write_text(json.dumps(authored))
        before = keybindings.read_bytes() if keybindings.exists() else None
        generation = state()["generation"]
        offset = len(recorded)
        send(b"\x01\x0b/reload\r")
        wait(lambda: state().get("generation") != generation and state().get("reason") == "reload", "reload generation")
        # Let Pi finish its own post-session_start keybinding reload. The next
        # Ctrl-P must itself restore defaults before native editor dispatch.
        wait(lambda: b"Reloaded keybindings" in recorded[offset:], "fresh reload completion")
        return before

    def unchanged(before):
        assert (keybindings.read_bytes() if keybindings.exists() else None) == before
        assert json.loads(settings_path.read_text())["historyFixtureSentinel"] == "preserved"

    try:
        initial = wait(lambda: state().get("selected") == "history-a", "native Pi startup")
        assert sorted(initial["available"]) == models and sorted(initial["scoped"]) == models, initial
        submit("History older prompt")
        submit("History newer prompt")
        for key, expected in [(b"\x10", "History newer prompt"), (b"\x10", "History older prompt"),
                              (b"\x0e", "History newer prompt"), (b"\x0e", "")]:
            recall(key, expected, "history-a")
            if expected == "History older prompt":
                capture("history-defaults")
        send(b"\x0c")
        wait(lambda: all(model in "\n".join(screen.display) for model in models), "normal two-model picker")
        capture("model-picker")
        send(b"\x1b[B\r")
        wait(lambda: state().get("selected") == "history-b", "picker selected the other available model")
        submit("Model B selected through the picker")
        assert {"history-a", "history-b"}.issubset(provider.models), provider.models
        before = reload(None)
        recall(b"\x10", "Model B selected through the picker", "history-b")
        capture("history-after-reload")
        unchanged(before)
        send(b"\x01\x0b")
        empty = {"tui.editor.historyPrevious": [], "tui.editor.historyNext": [], "app.tools.expand": "alt+o"}
        before = reload(empty)
        send(b"\x10")
        wait(lambda: state().get("selected") == "history-a", "explicit empty history permits normal Pi model cycling")
        assert state()["text"] == "" and state()["bindings"] == empty, state()
        unchanged(before)
        conflicts = {"app.model.cycleForward": "ctrl+p", "app.tools.expand": "ctrl+n", "app.session.new": "f5"}
        before = reload(conflicts)
        send(b"\x10")
        wait(lambda: state().get("selected") == "history-b", "authored Ctrl-P model claim")
        send(b"\x0e")
        assert state()["text"] == "" and state()["bindings"] == conflicts, state()
        unchanged(before)
        explicit = {"tui.editor.historyPrevious": ["ctrl+p"], "tui.editor.historyNext": [],
                    "app.model.cycleForward": ["ctrl+p"], "app.tools.expand": "alt+o"}
        for _ in range(2):
            before = reload(explicit)
            recall(b"\x10", "Model B selected through the picker", "history-b")
            assert state()["bindings"] == explicit, state()
            unchanged(before)
            capture("history-authored-precedence")
            send(b"\x01\x0b")
        before = reload(None)
        recall(b"\x10", "Model B selected through the picker", "history-b")
        assert state()["bindings"] == {"tui.editor.historyPrevious": "ctrl+p", "tui.editor.historyNext": "ctrl+n"}, state()
        unchanged(before)
        capture("history-restored-defaults")
        (output / "result.json").write_text(json.dumps({"passed": True, "modelsRequested": provider.models,
                                                        "available": initial["available"], "reloads": 6}, indent=2))
        print("Native Pi history/model picker: two available models, history sequence, first key after reload, empty/conflicting/explicit overrides and repeated reload passed")
    finally:
        (output / "transcript.ansi").write_bytes(recorded)
        if process.poll() is None:
            os.write(master, b"\x01\x0b/quit\r")
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        os.close(master)
        provider.shutdown()
