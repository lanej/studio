"""Exercise a source export and installed bundle with Node/npm explicitly unavailable."""
import argparse
from pathlib import Path
import json
import os
import shutil
import shlex
import subprocess
import tempfile

from export import export

parser = argparse.ArgumentParser()
parser.add_argument("--with-integrations", action="store_true", help="Also exercise native worktree-backed delegation")
parser.add_argument("--installation-only", action="store_true", help="Exercise export and installation without repeating source quality and unit checks")
args = parser.parse_args()
command_timeout = 240 if os.environ.get("GITHUB_ACTIONS") == "true" else 90
# Hosted macOS lint can exceed four minutes on the isolated source export.
lint_timeout = 600 if os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("RUNNER_OS") == "macOS" else command_timeout
bun = shutil.which("bun")
assert bun, "Install Bun satisfying package.json engines.bun before standalone acceptance"
current_version = subprocess.check_output([bun, "--version"], text=True).strip().split("+", 1)[0]
major, minor, patch = map(int, current_version.split("."))
future_minimum = f">={major}.{minor}.{patch + 1}"
with tempfile.TemporaryDirectory(prefix="studio-standalone-") as temporary:
    work = Path(temporary)
    source = work / "source"
    export(source)
    home = work / "home"
    home.mkdir()
    guard = work / "guard"
    guard.mkdir()
    calls = work / "unexpected-node"
    optional_tools = ("zellij", "nvim", "worktree", "octo-manager", "bd")
    def deny(name):
        script = guard / name
        script.write_text(f'#!/bin/sh\nprintf "%s\\n" "$0" >> "{calls}"\nexit 97\n')
        script.chmod(0o755)
    for name in ("node", "npm", "npx", *optional_tools):
        deny(name)
    env = {**os.environ, "HOME": str(home), "XDG_CONFIG_HOME": str(home / ".config"),
           "XDG_STATE_HOME": str(home / ".local/state"), "PI_CODING_AGENT_DIR": str(home / "agent"),
           "STUDIO_PREFIX": str(home / ".local"), "PI_SKIP_VERSION_CHECK": "1",
           "PATH": str(guard) + os.pathsep + os.environ["PATH"]}
    env.pop("STUDIO_CONFIG", None)
    env.pop("STUDIO_STATE_DIR", None)
    def run(args, expected=0, cwd=None, stderr_contains=None, timeout=command_timeout):
        try:
            result = subprocess.run(args, cwd=cwd or source, env=env, text=True, capture_output=True, timeout=timeout)
        except subprocess.TimeoutExpired as error:
            def tail(output, limit):
                if isinstance(output, bytes):
                    output = output.decode("utf-8", errors="replace")
                return (output or "")[-limit:]
            raise AssertionError(
                f"Standalone command exceeded {timeout}s: {shlex.join(args)}\n"
                f"Working directory: {cwd or source}\n"
                f"stdout (tail):\n{tail(error.stdout, 4000)}\n"
                f"stderr (tail):\n{tail(error.stderr, 8000)}"
            ) from error
        assert result.returncode == expected, (args, result.stdout[-4000:], result.stderr[-8000:])
        if stderr_contains is not None:
            assert stderr_contains in result.stderr, (args, result.stderr)
        return result.stdout
    run(["git", "init", "-q"])
    with (source / ".gitignore").open("a") as ignored:
        ignored.write("\nlocal.env\n")
    (source / "local.env").write_text("fixture-only-private-value\n")
    exported = work / "second-export"
    run(["python3", "scripts/export.py", str(exported)])
    assert not (exported / "local.env").exists()
    # Without Git, only the declared source manifest is copied.
    (exported / "another-private-file").write_text("fixture-only-private-value\n")
    run(["python3", str(exported / "scripts/export.py"), str(work / "manifest-export")])
    assert not (work / "manifest-export/another-private-file").exists()
    guidance_path = "resources/socrates/references/data-change-planning.md"
    data_change_guidance = (source / guidance_path).read_text()
    read_socrates_guidance = [bun, "-e", 'import { socratesGuidance } from "./socrates/guidance.ts"; process.stdout.write(await socratesGuidance());']
    assert data_change_guidance in run(read_socrates_guidance, cwd=work / "manifest-export")
    run([bun, "install", "--frozen-lockfile", "--ignore-scripts"])
    if not args.installation_only:
        run([bun, "install", "--cwd", ".typescript-quality", "--frozen-lockfile", "--ignore-scripts"])
        run([bun, "run", "typecheck"])
        run([bun, "run", "lint"], timeout=lint_timeout)
        run([bun, "run", "test"])
        run([bun, "run", "test:pi-native"])
    report = json.loads(run([str(source / "scripts/studio"), "doctor"]))
    assert all(not item["available"] for item in report["integrations"].values())
    if args.with_integrations:
        for name in optional_tools:
            (guard / name).unlink()
        for arguments in ([], ["--lost-allocation"], ["--cancel"]):
            run([bun, "run", "test:delegation-native", *arguments])
        for name in optional_tools:
            deny(name)
    run([bun, "run", "check:build"])
    assert json.loads(run([str(source / "scripts/studio"), "doctor"]))["resources"]["available"]
    source_config = run([str(source / "scripts/studio"), "config", "--example"])
    run([bun, "scripts/lifecycle.mjs", "build"])
    launcher = home / ".local/bin/studio"
    assert json.loads(run([str(launcher), "config", "--example"])) == json.loads(source_config)
    first = launcher.resolve()
    assert data_change_guidance in run(read_socrates_guidance, cwd=first.parents[1])
    installed_guidance = first.parents[1] / guidance_path
    moved_guidance = installed_guidance.rename(work / "data-change-planning.md")
    try:
        unavailable = json.loads(run([str(launcher), "doctor"], expected=1))["resources"]
        assert unavailable["available"] is False and guidance_path in unavailable["error"], unavailable
    finally:
        moved_guidance.rename(installed_guidance)
    assert not (first.parents[1] / "local.env").exists()
    assert not (first.parents[1] / "runtime").exists(), "Installations must not carry a private runtime"
    assert not (first.parents[1] / ".aot").exists(), "Installations must not embed a compiled runtime"
    hostile = work / "hostile-checkout"
    hostile.mkdir()
    preload = hostile / "preload.ts"
    bootstrap_marker = work / "unexpected-preload"
    preload.write_text('import { writeFileSync } from "node:fs"; writeFileSync(' + json.dumps(str(bootstrap_marker)) + ', "executed");')
    (hostile / "bunfig.toml").write_text("preload = [" + json.dumps(str(preload)) + "]\n")
    (hostile / ".env").write_text("STUDIO_BOOTSTRAP_UNTRUSTED=dotenv\n")
    assert "1.6.0" in run([str(first.with_name("pi")), "--version"], cwd=hostile)
    assert json.loads(run([str(launcher), "config", "--example"], cwd=hostile)) == json.loads(source_config)
    assert "1.6.0" in run([str(launcher), "lead", "--", "--version"], cwd=hostile)
    assert not bootstrap_marker.exists()
    # Both launchers must select the environment's Bun. There is no private fallback.
    bun_calls = work / "bun-calls"
    (guard / "bun").write_text(f"#!/bin/sh\nprintf '%s\\n' called >> {shlex.quote(str(bun_calls))}\nexec {shlex.quote(bun)} \"$@\"\n")
    (guard / "bun").chmod(0o755)
    run([str(launcher), "config", "--example"])
    assert "1.6.0" in run([str(first.with_name("pi")), "--version"])
    assert len(bun_calls.read_text().splitlines()) >= 4
    (guard / "bun").unlink()
    normal_path = env["PATH"]
    missing_path = work / "missing-runtime"
    missing_path.mkdir()
    (missing_path / "readlink").symlink_to(shutil.which("readlink"))
    env["PATH"] = str(missing_path)
    for command in ([str(launcher), "config", "--example"], [str(first.with_name("pi")), "--version"]):
        run(command, expected=1, stderr_contains="Studio requires Bun on PATH")
    env["PATH"] = normal_path
    # Raising the installed requirement rejects the current Bun before entry or settings mutation.
    installed_manifest = first.parents[1] / "package.json"
    original_manifest = installed_manifest.read_text()
    manifest = json.loads(original_manifest)
    manifest["engines"]["bun"] = future_minimum
    installed_manifest.write_text(json.dumps(manifest))
    for command in ([str(launcher), "config", "--example"], [str(first.with_name("pi")), "--version"]):
        run(command, expected=1, stderr_contains=f"Studio requires Bun {future_minimum}")
    normal_agent = env["PI_CODING_AGENT_DIR"]
    rejected_agent = home / "rejected-agent"
    env["PI_CODING_AGENT_DIR"] = str(rejected_agent)
    run(["python3", str(first.parents[1] / "scripts/configure.py"), str(first.parents[1])], expected=1,
        stderr_contains=f"Studio requires Bun {future_minimum}")
    assert not rejected_agent.exists()
    env["PI_CODING_AGENT_DIR"] = normal_agent
    installed_manifest.write_text(original_manifest)
    settings = json.loads((home / "agent/settings.json").read_text())
    assert settings["packages"] == [str(first.parents[1])]
    run([bun, "scripts/lifecycle.mjs", "build"])
    assert launcher.resolve() == first
    status = json.loads(run([bun, "scripts/lifecycle.mjs", "status"]))
    assert status["installed_fingerprint"] and status["running_revision"] is None
    run([bun, "scripts/lifecycle.mjs", "restart"], expected=3)
    # Installed extension dependencies participate in identity verification.
    dependency = first.parents[1] / "node_modules/pi-git-diff/package.json"
    original_dependency = dependency.read_bytes()
    dependency.write_bytes(original_dependency + b"\n")
    changed = json.loads(run([bun, "scripts/lifecycle.mjs", "status"]))
    assert changed["installed_fingerprint"] is None
    dependency.write_bytes(original_dependency)
    # A real staged source validation failure must leave the previous installation usable.
    cli = source / "cli.ts"
    original = cli.read_text()
    cli.write_text("invalid syntax {{{")
    run([bun, "scripts/lifecycle.mjs", "build"], expected=1)
    assert launcher.resolve() == first
    run([str(launcher), "config", "--example"])
    cli.write_text(original)
    # An insufficient runtime fails before staging and leaves the previous installation usable.
    source_manifest = source / "package.json"
    original_manifest = source_manifest.read_text()
    manifest = json.loads(original_manifest)
    manifest["engines"]["bun"] = future_minimum
    source_manifest.write_text(json.dumps(manifest))
    run([bun, "scripts/lifecycle.mjs", "build"], expected=1,
        stderr_contains=f"Studio requires Bun {future_minimum}")
    assert launcher.resolve() == first
    run([str(launcher), "config", "--example"])
    assert not (home / ".local/share/studio/install.lock").exists()
    # An environment newer than the declared floor is accepted by installation and both launchers.
    manifest["engines"]["bun"] = ">=1.0.0"
    source_manifest.write_text(json.dumps(manifest))
    run([bun, "scripts/lifecycle.mjs", "build"])
    run([str(launcher), "config", "--example"])
    assert "1.6.0" in run([str(launcher.resolve().with_name("pi")), "--version"])
    source_manifest.write_text(original_manifest)
    assert not calls.exists(), calls.read_text() if calls.exists() else ""
print("Standalone source and installed bundle verified with Node/npm unavailable.")
