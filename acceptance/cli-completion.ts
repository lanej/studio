import { spawnSync, type SpawnSyncOptionsWithBufferEncoding } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

function run(argv: string[], options: SpawnSyncOptionsWithBufferEncoding) {
  const [executable, ...args] = argv;
  if (executable === undefined) throw new Error("Missing executable");
  return spawnSync(executable, args, options);
}

// Real interactive shells and their native TAB bindings, not mocked completion
// widgets. All files and shell state are isolated and removed on failure too.
const shells = ["bash", "zsh", "fish"];
for (const shell of [...shells, "python3"]) {
  if (run([shell, "--version"], { timeout: 5000 }).error)
    throw new Error(`Required native completion verifier unavailable: ${shell}`);
}
// Preserve provisioned packages, not user configuration, across HOME isolation.
// An empty Bun cache would turn this offline check into a network install.
const bunInstall = process.env["BUN_INSTALL"] ?? join(homedir(), ".bun");
const dependencyCache = process.env["BUN_INSTALL_CACHE_DIR"] ?? join(bunInstall, "install", "cache");
// Explicit evidence destination survives fixture cleanup for PR review.
const captureDirectory = process.env["STUDIO_COMPLETION_CAPTURE_DIR"];
if (captureDirectory !== undefined) {
  mkdirSync(captureDirectory, { recursive: true });
  writeFileSync(join(captureDirectory, "geometry.json"), JSON.stringify({ columns: 160, rows: 40 }));
}
const directory = mkdtempSync(join(tmpdir(), "studio-native-completion-"));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
try {
  const cli = new URL("../cli.ts", import.meta.url).pathname;
  const config = join(directory, "invalid-config.json");
  writeFileSync(config, "must not be loaded");
  writeFileSync(
    join(directory, "studio"),
    `#!/bin/sh\nexec ${quote(process.execPath)} --no-install ${quote(cli)} "$@"\n`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    BUN_INSTALL: bunInstall,
    BUN_INSTALL_CACHE_DIR: dependencyCache,
    // Do not let Bun's own macOS transpiler cache create HOME/Library.
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    HOME: directory,
    XDG_CONFIG_HOME: directory,
    XDG_CACHE_HOME: directory,
    XDG_STATE_HOME: directory,
    STUDIO_CONFIG: config,
    AWS_SHARED_CREDENTIALS_FILE: join(directory, "missing-credentials"),
    PATH: `${directory}:${process.env["PATH"] ?? ""}`,
    TERM: "xterm-256color",
  };
  for (const shell of shells) {
    const generated = run([process.execPath, "--no-install", cli, "completion", shell], { env, timeout: 15_000 });
    if (generated.status !== 0 || generated.stderr.length !== 0)
      throw new Error(`Generation failed: ${generated.stderr.toString()}`);
    writeFileSync(join(directory, `${shell}.completion`), generated.stdout);
  }
  const python = String.raw`
import fcntl, os, pty, select, signal, struct, sys, termios, time

def interrupted(signum, frame):
    raise SystemExit('Native completion verifier interrupted')

signal.signal(signal.SIGTERM, interrupted)
root = sys.argv[1]
shells = sys.argv[2:]

def read_for(fd, seconds):
    output = b''
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        ready, _, _ = select.select([fd], [], [], min(0.1, max(0, end-time.monotonic())))
        if ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            output += data
            # Answer the shell's terminal negotiation like a basic xterm.
            # Fish waits for these responses before opening its native editor.
            if b'\x1b[0c' in data:
                os.write(fd, b'\x1b[?1;2c')
            if b'\x1b[?u' in data:
                os.write(fd, b'\x1b[?0u')
            if b'\x1b]11;?' in data:
                os.write(fd, b'\x1b]11;rgb:0000/0000/0000\x1b\\')
    return output

for shell in shells:
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(root)
        args = {'bash': ['--noprofile', '--norc', '-i'],
                'zsh': ['-f', '-i'], 'fish': ['--no-config', '-i']}[shell]
        os.execvp(shell, [shell] + args)
    transcript = b''
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 160, 0, 0))
        transcript += read_for(fd, 1)
        if shell == 'bash':
            setup = "PS1='native> '; set -o emacs; source ./bash.completion"
        elif shell == 'zsh':
            setup = "PROMPT='native> '; bindkey -e; autoload -Uz compinit; compinit -D; source ./zsh.completion"
        else:
            setup = "function fish_prompt; printf 'native> '; end; source ./fish.completion"
        os.write(fd, (setup + '\n').encode())
        transcript += read_for(fd, 3)
        # Retain the real multi-candidate display as well as insertion checks.
        os.write(fd, b'\x15studio runtime sta\t\t')
        transcript += read_for(fd, 2)
        os.write(fd, b'\x15')
        # Positive prefixes are unique, so real TAB must insert the suffix.
        # Negative cases must remain unchanged: no unrelated flags, files, or
        # unavailable integration IDs. Prefix printf only AFTER completion;
        # no Studio command action is ever executed.
        cases = [('studio start offline-id --wor', '--worker'),
                 ('studio skill --topic=comp', '--topic=compaction'),
                 ('studio runt', 'runtime'),
                 ('studio runtime stat', 'status'),
                 ('studio runtime status --he', '--help'),
                 ('studio tasks --js', '--json'),
                 ('studio start offline-id --profile=p', '--profile=p'),
                 ('studio skill --topic comp', 'compaction'),
                 ('studio runtime help stat', 'status'),
                 ('studio doctor --js', '--js'),
                 ('studio tasks unavailable-id', 'unavailable-id')]
        for line, expected in cases:
            os.write(fd, b'\x15' + line.encode() + b'\t')
            transcript += read_for(fd, 2)
            os.write(fd, b"\x01printf 'RESULT:%s\\n' \x05\n")
            output = read_for(fd, 2)
            transcript += output
            needle = ('\nRESULT:' + expected + '\r\n').encode()
            if needle not in output:
                raise RuntimeError(shell + ' native TAB failed for ' + repr(line) + '\n' + transcript.decode(errors='replace'))
        print(shell + ': real native TAB nested/flag/topic/help cases passed')
    finally:
        capture = os.environ.get('STUDIO_COMPLETION_CAPTURE_DIR')
        if capture:
            with open(os.path.join(capture, shell + '.ansi'), 'wb') as saved:
                saved.write(transcript)
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
        os.close(fd)
`;
  const result = run(["python3", "-c", python, directory, ...shells], {
    env,
    timeout: 210_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  process.stdout.write(result.stdout);
  if (result.status !== 0) throw new Error(`Native shell completion failed:\n${result.stderr.toString()}`);

  // Also exercise Fish's public native candidate-query API (no fake commandline).
  const fish = run(
    [
      "fish",
      "--no-config",
      "-c",
      "source ./fish.completion; complete -C 'studio start id --wor'; complete -C 'studio tasks unavailable-id'",
    ],
    { cwd: directory, env, timeout: 15_000 },
  );
  if (fish.status !== 0 || fish.stdout.toString().trim() !== "--worker")
    throw new Error(`Fish native complete -C failed: ${fish.stdout.toString()} ${fish.stderr.toString()}`);
  const query = run([process.execPath, "--no-install", cli, "completion", "--query", "--", "tasks", "unavailable-id"], {
    env: { ...env, PATH: directory },
    cwd: directory,
    timeout: 15_000,
  });
  if (query.status !== 0 || query.stdout.length !== 0 || query.stderr.length !== 0)
    throw new Error("Missing optional integrations must produce empty offline ID candidates");
  if (readdirSync(directory).some((name) => /sqlite|runtime|credential/.test(name)))
    throw new Error("Completion created unexpected runtime or credential state");
  console.log("Offline completion with unavailable integrations passed");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
