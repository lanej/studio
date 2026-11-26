import { editReason, requireEditReason } from "../code-intelligence/edit-tool.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { writeFileSync, mkdirSync, readFileSync, lstatSync, realpathSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import { z } from "zod";
import { ExecutionBeads } from "./beads.ts";
import { ExecutionStore, ExecutionPhase, type Execution, type RuntimeProject } from "./store.ts";

export function writableTools(
  project: RuntimeProject,
  attempt: Execution,
  check: () => Promise<void>,
): ToolDefinition[] {
  const checkout = attempt.checkout;
  if (!checkout) throw new Error("Missing admitted checkout");
  const text = (value: string) => ({
    content: [{ type: "text" as const, text: value }],
    details: {},
  });
  const input = z.object({ path: z.string().min(1) });
  const pathFor = async (path: string, writing: boolean): Promise<string> => {
    const root = await realpath(checkout.path);
    const target = resolve(root, path);
    const local = relative(root, target);
    if (
      local === "" ||
      local === ".." ||
      local.startsWith(`..${sep}`) ||
      isAbsolute(local) ||
      local.split(sep).includes(".git")
    )
      throw new Error("Choose a regular file inside the managed checkout");
    if (
      writing &&
      attempt.owns.length > 0 &&
      !attempt.owns.some((owned) => local === owned || local.startsWith(`${owned}/`))
    )
      throw new Error("This path is outside the accepted ownership scope");
    let ancestor = target;
    while (ancestor !== root) {
      try {
        if ((await lstat(ancestor)).isSymbolicLink() || (await realpath(ancestor)) !== ancestor)
          throw new Error("Worker tools cannot follow symbolic links");
      } catch (error) {
        if (!z.object({ code: z.literal("ENOENT") }).safeParse(error).success) throw error;
      }
      ancestor = dirname(ancestor);
    }
    return target;
  };
  const fence = async (): Promise<void> => {
    await check();
    if (!attempt.bead || attempt.revision === undefined) throw new Error("Task admission is missing");
    await new ExecutionBeads(project.source).requireCurrent(attempt.bead, attempt.revision, attempt.id);
  };
  const effect = (path: string, operation: () => void): void => {
    const store = new ExecutionStore();
    try {
      store.transaction(() => {
        const owner = store.attempt(attempt.id);
        if (
          owner.launchToken !== attempt.launchToken ||
          owner.pid !== process.pid ||
          owner.phase !== ExecutionPhase.Running
        )
          throw new Error("The writable task lease was retired before its file effect");
        let ancestor = path;
        while (ancestor !== realpathSync(checkout.path)) {
          try {
            if (lstatSync(ancestor).isSymbolicLink() || realpathSync(ancestor) !== ancestor)
              throw new Error("Worker effects cannot follow symbolic links");
          } catch (error) {
            if (!z.object({ code: z.literal("ENOENT") }).safeParse(error).success) throw error;
          }
          ancestor = dirname(ancestor);
        }
        operation();
      });
    } finally {
      store.close();
    }
  };
  return [
    {
      name: "read",
      label: "Read owned checkout",
      description: "Read a regular checkout file (up to 256 KiB). No external paths or links.",
      parameters: Type.Object({ path: Type.String() }),
      execute: async (_id, params) => {
        const file = await pathFor(input.parse(params).path, false);
        const info = await lstat(file);
        if (!info.isFile() || info.size > 256 * 1024) throw new Error("Choose a bounded regular text file");
        const content = await readFile(file, "utf8");
        if (Buffer.byteLength(content) > 256 * 1024 || content.includes("\0"))
          throw new Error("Choose a bounded text file");
        return text(content);
      },
    },
    {
      name: "write",
      executionMode: "sequential",
      label: "Write accepted task file",
      description: "Write a text file in the accepted ownership scope.",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute: async (_id, params) => {
        const parsed = input.extend({ content: z.string().max(256 * 1024) }).parse(params);
        const file = await pathFor(parsed.path, true);
        await fence();
        if (Buffer.byteLength(parsed.content) > 256 * 1024) throw new Error("Choose bounded text content");
        effect(file, () => {
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, parsed.content);
        });
        return text(`Wrote ${parsed.path}`);
      },
    },
    {
      name: "edit",
      executionMode: "sequential",
      label: "Edit accepted task file",
      description: "Replace one exact occurrence of text in an accepted regular file.",
      parameters: Type.Object({
        path: Type.String(),
        reason: editReason,
        oldText: Type.String(),
        newText: Type.String(),
      }),
      prepareArguments: requireEditReason,
      execute: async (_id, params) => {
        requireEditReason(params);
        const parsed = input
          .extend({
            oldText: z
              .string()
              .min(1)
              .max(256 * 1024),
            newText: z.string().max(256 * 1024),
          })
          .parse(params);
        const file = await pathFor(parsed.path, true);
        const info = await lstat(file);
        if (!info.isFile() || info.size > 256 * 1024) throw new Error("Choose a bounded regular text file");
        const before = await readFile(file, "utf8");
        if (before.split(parsed.oldText).length !== 2) throw new Error("oldText must match exactly once");
        await fence();
        effect(file, () => {
          if (readFileSync(file, "utf8") !== before) throw new Error("File changed before edit");
          const after = before.replace(parsed.oldText, parsed.newText);
          if (Buffer.byteLength(after) > 256 * 1024) throw new Error("Choose bounded text content");
          writeFileSync(file, after);
        });
        return text(`Edited ${parsed.path}`);
      },
    },
  ];
}
