import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { isStudioEdit } from "../code-intelligence/edit-tool.ts";

// These are the Pi declarations each operation replaces in the model's tool list.
// The underlying tools stay active so nested calls still run through Pi's hooks.
export const replacedTools = {
  read: ["read"],
  write: ["write"],
  replace: ["edit"],
  shell: ["bash"],
  patch: ["edit", "write"],
} as const;

export type CodingOperation = keyof typeof replacedTools;

export function operationAvailable(
  operation: CodingOperation,
  active: ReadonlySet<string>,
  tools: readonly ToolInfo[],
): boolean {
  // A patch can read, write, move, or delete files and uses the admitted shell.
  const required = operation === "patch" ? ["read", "edit", "write", "bash"] : replacedTools[operation];
  return required.every((name) => {
    if (!active.has(name)) return false;
    const tool = tools.find((info) => info.name === name);
    if (tool === undefined || tool.exposure !== "direct") return false;
    if (operation === "replace") return isStudioEdit(tool);
    if (name === "edit" && isStudioEdit(tool)) return true;
    // SDK base-tool overrides also report builtin:<name>, but omit Pi's native prompt guidelines.
    return tool.sourceInfo.path === `builtin:${name}` && tool.promptGuidelines !== undefined;
  });
}
