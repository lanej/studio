import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { run, processFailure } from "../process.ts";

const gitExecutable = "/usr/bin/git";
const inside = (path: string, root: string): boolean => {
  const local = relative(root, path);
  return (
    local === "" ||
    (local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local))
  );
};
function environment(indexFile?: string): NodeJS.ProcessEnv {
  const result = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return {
    ...result,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ATTR_NOSYSTEM: "1",
    ...(indexFile === undefined ? {} : { GIT_INDEX_FILE: indexFile }),
  };
}
const raw = (
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = environment(),
  timeout = 15000,
) => run(gitExecutable, args, { cwd, env, timeout });

/** Bind explicitly to the registered worktree and neutralize executable Git configuration before reading worker data. */
export async function safeGit(
  projectRoot: string,
  cwd: string,
  args: string[],
  options: { indexFile?: string; timeout?: number } = {},
): Promise<string> {
  const root = await realpath(cwd);
  const common = await realpath(
    (
      await raw(projectRoot, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ])
    ).trim(),
  );
  const directory = await realpath(
    (
      await raw(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"])
    ).trim(),
  );
  if (!inside(directory, resolve(common, "worktrees")))
    throw new Error(
      "Controller Git operations require the registered isolated worktree Git directory",
    );
  const backlink = (
    await readFile(resolve(directory, "gitdir"), "utf8")
  ).trim();
  if ((await realpath(backlink)) !== (await realpath(resolve(root, ".git"))))
    throw new Error(
      "The checkout's Git identity no longer matches its registered worktree",
    );
  const storedCommon = await realpath(
    resolve(
      directory,
      (await readFile(resolve(directory, "commondir"), "utf8")).trim(),
    ),
  );
  if (storedCommon !== common)
    throw new Error("The checkout changed repository authority");
  return scopedGit(
    projectRoot,
    root,
    common,
    ["--git-dir", directory, "--work-tree", root],
    args,
    options,
    root,
  );
}

/** Apply the same Git driver, hook and filter restrictions before allocating a worker checkout. */
export async function projectObjectGit(
  projectRoot: string,
  args: string[],
): Promise<string> {
  const common = await realpath(
    (
      await raw(projectRoot, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ])
    ).trim(),
  );
  return scopedGit(
    projectRoot,
    projectRoot,
    common,
    ["--git-dir", common],
    args,
    {},
  );
}

async function scopedGit(
  projectRoot: string,
  cwd: string,
  common: string,
  scoped: string[],
  args: string[],
  options: { indexFile?: string; timeout?: number },
  workerRoot?: string,
): Promise<string> {
  const config = (
    await raw(cwd, [
      ...scoped,
      "config",
      "--includes",
      "--null",
      "--show-origin",
      "--name-only",
      "--list",
    ])
  ).split("\0");
  const overrides = [
    "core.hooksPath=/dev/null",
    "core.fsmonitor=false",
    "core.attributesFile=/dev/null",
    "gc.auto=0",
    "maintenance.auto=false",
    "commit.gpgSign=false",
    "tag.gpgSign=false",
    "protocol.allow=never",
    "protocol.ext.allow=never",
    "submodule.recurse=false",
    "merge.verifySignatures=false",
  ];
  const worktreeRoot = resolve(common, "..", ".worktrees");
  for (let index = 0; index + 1 < config.length; index += 2) {
    const origin = config[index] ?? "";
    const key = config[index + 1] ?? "";
    if (origin.startsWith("file:")) {
      const path = await realpath(resolve(cwd, origin.slice(5)));
      if (
        (workerRoot !== undefined && inside(path, workerRoot)) ||
        inside(path, worktreeRoot)
      )
        throw new Error(
          "Executable Git configuration may not be included from worker-writable source paths",
        );
    }
    if (/^filter\..*\.(?:clean|smudge|process)$/u.test(key))
      overrides.push(`${key}=`);
    if (/^filter\..*\.required$/u.test(key)) overrides.push(`${key}=false`);
    if (/^protocol\..*\.allow$/u.test(key)) overrides.push(`${key}=never`);
    if (/^merge\..*\.driver$/u.test(key))
      overrides.push(`${key}=/usr/bin/false`);
  }
  // Author identity is data from the configured project, never an executable hook.
  for (const key of ["user.name", "user.email"]) {
    const value = await raw(projectRoot, ["config", "--get", key], {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    })
      .then((text) => text.trim())
      .catch((error: unknown) => {
        if (processFailure(error).code === 1) return "";
        throw error;
      });
    if (value.length > 0) overrides.push(`${key}=${value}`);
  }
  const command =
    args[0] === "diff"
      ? ["diff", "--no-ext-diff", "--no-textconv", ...args.slice(1)]
      : args;
  return raw(
    cwd,
    [
      "--no-replace-objects",
      ...scoped,
      ...overrides.flatMap((value) => ["-c", value]),
      ...command,
    ],
    environment(options.indexFile),
    options.timeout,
  );
}

/** Authorized network operations run from the trusted enrolled source, with hooks disabled. */
export function networkGit(
  projectRoot: string,
  args: string[],
  timeout = 120000,
): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(?:GIT_DIR|GIT_COMMON_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_EXEC_PATH|GIT_CONFIG|GIT_CONFIG_COUNT|GIT_CONFIG_PARAMETERS|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+)$/u.test(
          key,
        ),
    ),
  );
  return run(
    gitExecutable,
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "fetch.recurseSubmodules=false",
      ...args,
    ],
    { cwd: projectRoot, env: { ...env, GIT_TERMINAL_PROMPT: "0" }, timeout },
  );
}
