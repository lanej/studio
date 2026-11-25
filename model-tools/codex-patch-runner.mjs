import { readFile } from "node:fs/promises";
import { applyPatch } from "pi-codex-tools";

// Import the public parser API. The package's standalone Pi extension also manages its own tool list.
export { APPLY_PATCH_GRAMMAR, MAX_PATCH_BYTES, parseApplyPatch } from "pi-codex-tools";
export const patchSuccess = "Success. Updated the following files:";

if (import.meta.main) {
  try {
    const patch = await readFile(process.argv[2], "utf8");
    const cwd = process.argv[3];
    if (!cwd) throw new Error("Missing patch working directory");
    const { changes } = await applyPatch(patch, { cwd });
    console.log(patchSuccess);
    for (const change of changes) {
      const marker = { added: "A", updated: "M", deleted: "D" }[change.kind];
      const path = change.moveTo === undefined ? change.path : `${change.path} -> ${change.moveTo}`;
      console.log(`${marker} ${path}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
