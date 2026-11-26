import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

await test("owned PTY crash closes its master before wait, keeps FD ownership per instance, and retains uncertain cleanup without masking failure", async () => {
  const script = String.raw`
import errno, importlib.util, json, os, shutil, signal, subprocess, sys, types
from unittest.mock import patch
sys.modules["socrates-status"] = types.ModuleType("socrates-status")
spec = importlib.util.spec_from_file_location("studio_session_loop", sys.argv[1])
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
events = []
def closed(fd):
    try: os.fstat(fd)
    except OSError as error:
        assert error.errno == errno.EBADF
        return True
    return False
class Process:
    pid = 987654321
    returncode = None
    def __init__(self, master): self.master = master
    def wait(self, timeout):
        events.append(("wait", timeout, closed(self.master)))
        if not closed(self.master): raise subprocess.TimeoutExpired("blocked PTY drain", timeout)
        self.returncode = -signal.SIGKILL
        return self.returncode
    def poll(self): return self.returncode
quiet = subprocess.CompletedProcess([], 0, stdout="", stderr="")
with patch.object(fixture.os, "killpg", side_effect=lambda pid, sig: events.append(("signal", pid, sig))), patch.object(fixture.os, "getpgid", return_value=Process.pid), patch.object(fixture.subprocess, "run", return_value=quiet):
    master, slave = os.openpty(); os.close(slave)
    before = Process(master)
    fixture.os.killpg(before.pid, signal.SIGKILL)
    try: before.wait(timeout=5)
    except subprocess.TimeoutExpired: pass
    else: raise AssertionError("Old wait-before-close did not expose drain ordering")
    os.close(master)
    master, slave = os.openpty(); os.close(slave)
    current = Process(master)
    owned = fixture.OwnedPty(current, master)
    events.clear()
    receipt = owned.crash()
    assert events == [("signal", current.pid, signal.SIGKILL), ("wait", 5, True)], events
    assert receipt["exitCode"] == -signal.SIGKILL
    reused = os.open(os.devnull, os.O_RDONLY)
    assert reused == master, (reused, master)
    owned.close()
    assert not closed(reused), "Old terminal closed a restored terminal's reused FD"
    restored = Process(reused); restored.returncode = 0
    fixture.OwnedPty(restored, reused).close()
    assert closed(reused)
    assert len(events) == 2, "Idempotent cleanup re-signaled an exited process"
# A failed signal or invalid leader must still close its owned descriptor once,
# without retrying a signal or later closing a restored terminal's reused FD.
for mode in ("exited", "wrong-group", "signal-denied"):
    master, slave = os.openpty(); os.close(slave)
    process = Process(master)
    if mode == "exited": process.returncode = 0
    owner = fixture.OwnedPty(process, master)
    expected_group = process.pid + 1 if mode == "wrong-group" else process.pid
    denied = PermissionError(errno.EPERM, "synthetic denied signal") if mode == "signal-denied" else None
    with patch.object(fixture.os, "killpg", side_effect=denied) as send, patch.object(fixture.os, "getpgid", return_value=expected_group):
        try: owner.crash()
        except (RuntimeError, PermissionError) as failure:
            assert failure is owner.failure
            if denied is not None: assert failure is denied
        else: raise AssertionError("Unsafe crash signal was accepted")
        assert closed(master) and owner.master_attempted and owner.master_closed
        assert send.call_count == (1 if denied is not None else 0)
        reused = os.open(os.devnull, os.O_RDONLY)
        assert reused == master
        try: owner.close()
        except RuntimeError: pass
        else: raise AssertionError("Uncertain cleanup was silently retried")
        assert not closed(reused)
        assert send.call_count == (1 if denied is not None else 0)
        os.close(reused)
# Closing a descriptor may itself be uncertain. Never repeat that numeric close.
master, slave = os.openpty(); os.close(slave)
owner = fixture.OwnedPty(Process(master), master)
with patch.object(fixture.os, "killpg"), patch.object(fixture.os, "getpgid", return_value=Process.pid), patch.object(fixture.os, "close", side_effect=OSError(errno.EINTR, "uncertain close")) as close_fd:
    try: owner.crash()
    except OSError: pass
    else: raise AssertionError("Descriptor failure was hidden")
    try: owner.close()
    except RuntimeError: pass
    else: raise AssertionError("Uncertain descriptor was silently retried")
    assert close_fd.call_count == 1
os.close(master)  # The injected syscall above never closed this test descriptor.
master, slave = os.openpty(); os.close(slave)
uncertain_process = Process(master); uncertain_process.returncode = 0
uncertain = fixture.OwnedPty(uncertain_process, master)
retention = {"cleanup_failed": False}
primary = AssertionError("original acceptance failure")
live_group = subprocess.CompletedProcess([], 0, stdout=f"{uncertain_process.pid} S\n", stderr="")
with patch.object(fixture.os, "killpg") as signal_group, patch.object(fixture.subprocess, "run", return_value=live_group):
    with fixture.fixture_directory(retention, None) as home:
        cleanup_error = fixture.cleanup_pty(uncertain, home, retention)
        assert cleanup_error is not None
        fixture.report_cleanup_errors(primary, [cleanup_error])
        assert str(primary) == "original acceptance failure"
        assert primary.__notes__
        assert retention["cleanup_failed"]
        receipt = json.loads((home / "session-loop-cleanup.json").read_text())
        assert receipt["pid"] == uncertain_process.pid and receipt["masterClosed"]
        assert "unverified live members" in receipt["failure"]
        try: uncertain.close()
        except RuntimeError: pass
        else: raise AssertionError("Uncertain cleanup was silently retried")
        signal_group.assert_not_called()
    assert home.is_dir(), "Uncertain process evidence was deleted"
    shutil.rmtree(home)  # Synthetic process only; no native process owns this test home.
provider_error = RuntimeError("provider shutdown failed")
fixture.report_cleanup_errors(primary, [cleanup_error, provider_error])
assert any("provider shutdown failed" in note for note in primary.__notes__)
try: fixture.report_cleanup_errors(None, [cleanup_error, provider_error])
except RuntimeError as error:
    assert error is cleanup_error
    assert any("provider shutdown failed" in note for note in error.__notes__)
else: raise AssertionError("Cleanup failure with no primary was hidden")
print("Causal drain ordering, SIGKILL-before-hangup, per-terminal FD reuse, original failure and uncertain workspace retention passed.")
`;
  const result = await promisify(execFile)(
    "python3",
    ["-c", script, fileURLToPath(new URL("../acceptance/session-loop.py", import.meta.url))],
    { timeout: 15_000 },
  );
  assert.match(result.stdout, /Causal drain ordering.*retention passed/u);
});
