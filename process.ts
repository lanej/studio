import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execute = promisify(execFile);
const failureSchema = z.object({
  code: z.union([z.string(), z.number(), z.null()]).optional(),
  signal: z.string().nullable().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  message: z.string(),
});

export function processFailure(error: unknown): z.infer<typeof failureSchema> {
  if (error instanceof CommandError) return error.failure;
  const parsed = failureSchema.safeParse(error);
  return parsed.success
    ? parsed.data
    : { message: error instanceof Error ? error.message : String(error) };
}

/** Propagate probe failures unless the OS reports that the group is absent. */
export function processGroupExists(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    if (processFailure(error).code === "ESRCH") return false;
    throw error;
  }
}

export function processGroupHasLiveMembers(
  group: number,
  snapshot: string,
): boolean {
  for (const row of snapshot.trim().split("\n")) {
    const fields = /^(\d+)\s+(\S+)$/u.exec(row.trim());
    if (fields === null)
      throw new Error("Unable to read process group state from ps");
    if (Number(fields[1]) === group && fields[2]?.[0] !== "Z") return true;
  }
  return false;
}

export function signalProcessGroup(
  group: number,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-group, signal);
  } catch (error) {
    const code = processFailure(error).code;
    if (code === "ESRCH") return;
    // Darwin reports EPERM when the last group members are zombies awaiting reaping.
    if (process.platform === "darwin" && code === "EPERM") {
      const snapshot = execFileSync("/bin/ps", ["-A", "-o", "pgid=,stat="], {
        encoding: "utf8",
        timeout: 2000,
        maxBuffer: 4 * 1024 * 1024,
      });
      if (!processGroupHasLiveMembers(group, snapshot)) return;
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}

class CommandError extends Error {
  constructor(
    message: string,
    readonly failure: z.infer<typeof failureSchema>,
  ) {
    super(message);
  }
}

export async function run(
  executable: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<string> {
  try {
    const result = await execute(executable, args, {
      timeout: 15_000,
      ...options,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
      windowsHide: true,
    });
    return result.stdout;
  } catch (error) {
    const failure = processFailure(error);
    const stderr = failure.stderr?.trim();
    throw new CommandError(
      `${executable} failed (${String(failure.code ?? failure.signal ?? "unknown")}): ${stderr !== undefined && stderr.length > 0 ? stderr : failure.message}`,
      failure,
    );
  }
}

export async function processStart(pid: number): Promise<string> {
  return (
    await run("ps", ["-p", String(pid), "-o", "lstart="], {
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    })
  ).trim();
}

/** Compare the recorded start time because a later process can reuse the PID. */
export async function processMatchesStart(
  pid: number,
  started: string,
): Promise<boolean> {
  try {
    return (await processStart(pid)) === started;
  } catch (error) {
    if (processFailure(error).code === 1) return false;
    throw error;
  }
}
