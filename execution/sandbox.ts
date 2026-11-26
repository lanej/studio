import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { configPath } from "../config.ts";
import { packageRoot } from "../package-resources.ts";
import { stateDirectory } from "../attempts.ts";
import { run, processFailure } from "../process.ts";
import { safeGit } from "./git.ts";
import { gitState } from "../task-verification.ts";

export interface VerificationSandbox {
  argv: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  assertSourceUnchanged(): Promise<void>;
  close(): Promise<void>;
}
export interface VerificationSnapshot {
  projectRoot: string;
  tree: string;
  branch: string;
}
const beneath = (path: string, root: string): boolean => {
  const local = relative(root, path);
  return local === "" || (local !== ".." && !local.startsWith("../") && !isAbsolute(local));
};
const quote = (value: string): string => JSON.stringify(value);

/** Verification runs worker-influenced project code without controller state, auth, network, or host IPC. */
export async function verificationSandbox(
  cwd: string,
  argv: string[],
  readPaths: string[] = [],
  snapshot?: VerificationSnapshot,
): Promise<VerificationSandbox> {
  const checkout = await realpath(cwd);
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "studio-verification-")));
  try {
    const workspace = join(temporary, "workspace");
    await mkdir(workspace);
    const dependencies: string[] = [];
    const execute = (args: string[], env?: NodeJS.ProcessEnv) => {
      if (!snapshot) throw new Error("A source snapshot is required");
      return safeGit(snapshot.projectRoot, checkout, ["--work-tree", workspace, ...args], {
        ...(env?.["GIT_INDEX_FILE"] === undefined ? {} : { indexFile: env["GIT_INDEX_FILE"] }),
      });
    };
    if (snapshot) {
      const index = {
        GIT_INDEX_FILE: join(temporary, "materialization-index"),
      };
      await execute(["read-tree", snapshot.tree], index);
      await execute(["checkout-index", "--all", `--prefix=${workspace}/`], index);
      // Dependency trees are read capabilities, never copied as ignored source or made writable.
      const addDependencies = async (directory: string): Promise<void> => {
        const local = relative(workspace, directory);
        const source = join(checkout, local, "node_modules");
        const destination = join(directory, "node_modules");
        if (
          !(await lstat(destination)
            .then(() => true)
            .catch(() => false)) &&
          (await lstat(source)
            .then(() => true)
            .catch(() => false))
        ) {
          const ignored = await safeGit(snapshot.projectRoot, checkout, [
            "check-ignore",
            "--quiet",
            "--",
            join(local, "node_modules"),
          ])
            .then(() => true)
            .catch((error: unknown) => {
              if (processFailure(error).code === 1) return false;
              throw error;
            });
          if (ignored) {
            const dependency = await realpath(source);
            dependencies.push(dependency);
            // A directory-only ignore such as node_modules/ does not ignore a symlink.
            // Retain the directory shape while sharing its read-only dependency entries.
            await mkdir(destination);
            for (const entry of await readdir(dependency))
              await symlink(join(dependency, entry), join(destination, entry));
          }
        }
        for (const entry of await readdir(directory, { withFileTypes: true }))
          if (entry.isDirectory() && entry.name !== "node_modules") await addDependencies(join(directory, entry.name));
      };
      await addDependencies(workspace);
    }
    const protectedPaths = await Promise.all(
      [
        stateDirectory(),
        getAgentDir(),
        configPath(),
        join(userInfo().homedir, ".ssh"),
        join(userInfo().homedir, ".config/gh"),
        join(userInfo().homedir, "Library/Keychains"),
      ].map((path) => realpath(path).catch(() => path)),
    );
    const executableRoot = await realpath(dirname(process.execPath));
    const metadata = (args: string[]) =>
      !snapshot
        ? run("/usr/bin/git", args, {
            cwd: checkout,
            env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
          })
        : safeGit(snapshot.projectRoot, checkout, args);
    const gitDirectory = (await metadata(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    const gitWorktree = (await metadata(["rev-parse", "--path-format=absolute", "--git-dir"])).trim();
    const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    const packageMetadata = await run("/usr/bin/git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: packageRoot,
      env: cleanEnvironment,
    })
      .then((text) => realpath(text.trim()))
      .catch((error: unknown) => {
        if (processFailure(error).code === 128) return undefined;
        throw error;
      });
    const metadataPaths = [
      ...new Set([
        gitDirectory,
        gitWorktree,
        join(checkout, ".git"),
        join(await realpath(packageRoot), ".git"),
        ...(packageMetadata === undefined ? [] : [packageMetadata]),
      ]),
    ].filter(
      (path, index, paths) => !paths.some((parent, parentIndex) => parentIndex !== index && beneath(path, parent)),
    );
    const explicitReadPaths = await Promise.all(readPaths.map((path) => realpath(path)));
    if (
      explicitReadPaths.some((path) => metadataPaths.some((secret) => beneath(path, secret) || beneath(secret, path)))
    )
      throw new Error("Verification read paths may not expose original Git metadata or authority");
    const scratchGit = join(temporary, "git");
    const objectRoot = join(gitDirectory, "objects");
    const objectBindings: { source: string; destination: string }[] = [];
    if (snapshot) {
      await safeGit(snapshot.projectRoot, checkout, ["check-ref-format", "--branch", snapshot.branch]);
      await mkdir(join(scratchGit, "refs", "heads", dirname(snapshot.branch)), {
        recursive: true,
      });
      await mkdir(join(scratchGit, "objects", "info"), { recursive: true });
      await writeFile(
        join(scratchGit, "config"),
        "[core]\n repositoryformatversion = 0\n bare = false\n hooksPath = /dev/null\n fsmonitor = false\n[protocol]\n allow = never\n",
      );
      await writeFile(join(scratchGit, "HEAD"), `ref: refs/heads/${snapshot.branch}\n`);
      const head = (await metadata(["rev-parse", "HEAD"])).trim();
      await writeFile(join(scratchGit, "refs", "heads", snapshot.branch), `${head}\n`);
      await copyFile(join(temporary, "materialization-index"), join(scratchGit, "index"));
      // Expose only object data, never the original config, refs, logs, or alternate transport URLs.
      for (const entry of await readdir(objectRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !(entry.name === "pack" || /^[a-f0-9]{2}$/u.test(entry.name))) continue;
        const source = join(objectRoot, entry.name);
        const destination = join(scratchGit, "objects", entry.name);
        objectBindings.push({ source, destination });
        if (process.platform === "linux") await mkdir(destination);
        else await symlink(source, destination);
      }
      await writeFile(join(workspace, ".git"), `gitdir: ${scratchGit}\n`);
    }
    const mapped = argv.map((value) =>
      beneath(value, checkout) && isAbsolute(value) ? join(workspace, relative(checkout, value)) : value,
    );
    const requested = mapped[0];
    if (requested === undefined) throw new Error("A verification command is required");
    // Git dependencies use the controller's trusted executable, never an arbitrary PATH wrapper.
    const tools = join(temporary, "bin");
    await mkdir(tools);
    await symlink("/usr/bin/git", join(tools, "git"));
    const path = `${tools}${delimiter}${process.env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"}`;
    const executableCandidates = isAbsolute(requested)
      ? [requested]
      : requested.includes("/")
        ? [join(workspace, requested)]
        : path.split(delimiter).map((directory) => join(directory, requested));
    let requestedRoot: string | undefined;
    let requestedExecutable: string | undefined;
    for (const candidate of executableCandidates) {
      try {
        await access(candidate, constants.X_OK);
        requestedExecutable = await realpath(candidate);
        requestedRoot = dirname(requestedExecutable);
        break;
      } catch {
        /* continue resolution */
      }
    }
    if (requestedRoot === undefined) throw new Error("The agreed verification executable is unavailable");
    const interpreterLibraries: string[] = [];
    if (requestedExecutable !== undefined && /^python\d+\.\d+t?$/u.test(basename(requestedExecutable))) {
      // Resolve CPython's sibling stdlib without running worker-influenced executables outside isolation.
      const library = await realpath(join(requestedRoot, "..", "lib", basename(requestedExecutable))).catch(
        () => undefined,
      );
      if (library !== undefined && (await stat(library)).isDirectory()) interpreterLibraries.push(library);
    }
    let developer: { directory: string; root: string } | undefined;
    if (process.platform === "darwin") {
      const selection = process.env["DEVELOPER_DIR"] ?? (await run("/usr/bin/xcode-select", ["--print-path"])).trim();
      const selected = await realpath(selection);
      const directory = await realpath(join(selected, "Contents", "Developer")).catch(() => selected);
      if (!(await stat(directory)).isDirectory())
        throw new Error("The selected Apple developer directory is unavailable");
      const contents = dirname(directory);
      const bundle = dirname(contents);
      developer = {
        directory,
        root: basename(contents) === "Contents" && bundle.endsWith(".app") ? bundle : directory,
      };
    }
    const allowed = [
      checkout,
      temporary,
      ...dependencies,
      await realpath(packageRoot),
      executableRoot,
      requestedRoot,
      ...interpreterLibraries,
      ...(!developer ? [] : [developer.root]),
      ...objectBindings.map((binding) => binding.source),
      ...explicitReadPaths,
    ];
    if (allowed.some((path) => protectedPaths.some((secret) => beneath(secret, path) || beneath(path, secret))))
      throw new Error("Verification read paths may not expose controller state or credentials");
    const environment: NodeJS.ProcessEnv = {
      PATH: path,
      HOME: temporary,
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
      LANG: process.env["LANG"] ?? "en_US.UTF-8",
      TERM: "dumb",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      BUN_INSTALL_CACHE_DIR: join(temporary, "bun-cache"),
      NO_COLOR: "1",
      ...(!developer ? {} : { DEVELOPER_DIR: developer.directory }),
      ...(!snapshot
        ? {}
        : {
            GIT_OPTIONAL_LOCKS: "0",
          }),
    };
    const assertSourceUnchanged = async (): Promise<void> => {
      if (!snapshot) return;
      const after = await gitState(workspace, snapshot.branch, execute);
      if (after.gitState !== snapshot.tree)
        throw new Error("Verification changed its reviewed source snapshot; only ignored build outputs may change");
    };
    await assertSourceUnchanged();
    const result = {
      cwd: workspace,
      environment,
      assertSourceUnchanged,
      close: () => rm(temporary, { recursive: true, force: true }),
    };
    if (process.platform === "darwin") {
      const profile = [
        "(version 1)",
        "(allow default)",
        "(deny network*)",
        "(deny mach-lookup mach-register ipc-posix*)",
        "(deny signal (require-all (require-not (target self)) (require-not (target children))))",
        `(deny file-write* (require-all (require-not (subpath ${quote(temporary)})) (require-not (literal "/dev/null"))))`,
        `(deny file-read-data file-read-xattr (require-all ${["/System", "/usr", "/bin", "/sbin", "/Library", "/opt", "/private/etc", "/private/var/db/dyld", "/dev", ...allowed].map((path) => `(require-not (subpath ${quote(path)}))`).join(" ")} (require-not (literal "/"))))`,
        ...[
          "/System",
          "/usr",
          "/bin",
          "/sbin",
          "/Library",
          "/opt",
          "/private/etc",
          "/private/var/db/dyld",
          "/dev",
          ...allowed,
        ].map((path) => `(allow file-read* (subpath ${quote(path)}))`),
        `(allow file-write* (subpath ${quote(temporary)}))`,
        '(allow file-write-data (literal "/dev/null"))',
        ...protectedPaths.map((path) => `(deny file-read* file-write* (subpath ${quote(path)}))`),
        ...metadataPaths.map(
          (path) =>
            `(deny file-read* file-write* (require-all (subpath ${quote(path)}) ${objectBindings.map((binding) => `(require-not (subpath ${quote(binding.source)}))`).join(" ")}))`,
        ),
      ].join("\n");
      await access("/usr/bin/sandbox-exec", constants.X_OK);
      return {
        ...result,
        argv: ["/usr/bin/sandbox-exec", "-p", profile, ...mapped],
      };
    }
    if (process.platform !== "linux")
      throw new Error("Unattended verification requires a supported macOS/Linux isolation backend");
    const args = [
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--cap-drop",
      "ALL",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
    ];
    for (const path of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt"]) {
      try {
        await stat(path);
        args.push("--ro-bind", path, path);
      } catch {
        /* optional host system directory */
      }
    }
    for (const path of allowed.filter((path) => path !== temporary)) args.push("--ro-bind", path, path);
    args.push("--bind", temporary, temporary);
    const maskedFile = join(temporary, "masked-file");
    await writeFile(maskedFile, "");
    // Mask protected state even when a broad system read mount contains it.
    const maskedPaths = [...new Set([...protectedPaths, ...metadataPaths])].filter(
      (path, index, paths) => !paths.some((parent, parentIndex) => parentIndex !== index && beneath(path, parent)),
    );
    for (const path of maskedPaths) {
      const metadata = await stat(path).catch(() => undefined);
      if (metadata)
        args.push(
          ...(metadata.isDirectory() ? ["--tmpfs", path, "--remount-ro", path] : ["--ro-bind", maskedFile, path]),
        );
    }
    for (const binding of objectBindings) args.push("--ro-bind", binding.source, binding.destination);
    args.push("--chdir", workspace, "--", ...mapped);
    return { ...result, argv: ["bwrap", ...args] };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function assertVerificationIsolation(cwd: string, readPaths: string[] = []): Promise<void> {
  const candidates = [...(process.env["PATH"] ?? "").split(delimiter).map((directory) => join(directory, "bun"))];
  let executable: string | undefined;
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      executable = await realpath(candidate);
      break;
    } catch {
      /* try the next configured runtime path */
    }
  }
  if (executable === undefined) throw new Error("Bun is unavailable on PATH for isolated verification");
  const sandbox = await verificationSandbox(
    cwd,
    [
      executable,
      "--no-env-file",
      `--config=${join(packageRoot, "resources/bunfig.toml")}`,
      join(packageRoot, "scripts/runtime.mjs"),
    ],
    readPaths,
  );
  try {
    const [command, ...args] = sandbox.argv;
    if (command === undefined) throw new Error("No verification isolation backend is available");
    await run(command, args, { cwd: sandbox.cwd, env: sandbox.environment });
  } finally {
    await sandbox.close();
  }
}
