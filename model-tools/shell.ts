import { resolve } from "node:path";

export interface ShellRequest {
  command: string;
  workdir?: string | undefined;
  timeoutMs?: number | undefined;
}

export function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// Pi takes a command in the session directory and an optional timeout in seconds.
export function piShellArguments(cwd: string, { command, workdir, timeoutMs }: ShellRequest) {
  return {
    command:
      workdir === undefined ? command : `cd -- ${quoteShellArgument(resolve(cwd, workdir))} || exit $?\n${command}`,
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs / 1000 }),
  };
}
