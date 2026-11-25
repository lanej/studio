import { defineTool } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { Type } from "typebox";

export function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function shellCommandText(
  cwd: string,
  command: string,
  workdir?: string,
): string {
  return workdir === undefined
    ? command
    : `cd -- ${quoteShellArgument(resolve(cwd, workdir))} || exit $?\n${command}`;
}

export const shellCommand = defineTool({
  name: "shell_command",
  label: "Shell command",
  description:
    "Run a shell command and return its output when it finishes. Use workdir to select the working directory for this call.",
  promptSnippet: "Run a command in the checkout",
  parameters: Type.Object(
    {
      command: Type.String(),
      workdir: Type.Optional(Type.String({ minLength: 1 })),
      timeout_ms: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 2147483647 }),
      ),
    },
    { additionalProperties: false },
  ),
  async execute(_id, args, _signal, onUpdate, ctx) {
    const command = shellCommandText(ctx.cwd, args.command, args.workdir);
    const call = await ctx.executeTool(
      "bash",
      {
        command,
        ...(args.timeout_ms === undefined
          ? {}
          : { timeout: args.timeout_ms / 1000 }),
      },
      onUpdate === undefined ? {} : { onUpdate },
    );
    return { ...call.result, isError: call.isError };
  },
});
