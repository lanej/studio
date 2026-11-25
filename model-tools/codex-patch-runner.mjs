import { readFile, writeFile } from "node:fs/promises";
import { applyPatch } from "pi-codex-tools";

// Import the public parser API. The package's standalone Pi extension also manages its own tool list.
export { APPLY_PATCH_GRAMMAR, MAX_PATCH_BYTES, parseApplyPatch } from "pi-codex-tools";
export const patchSuccess = "Success. Updated the following files:";

if (import.meta.main) {
  try {
    const patch = await readFile(process.argv[2], "utf8");
    const cwd = process.argv[3];
    if (!cwd) throw new Error("Missing patch working directory");
    const receipt = process.argv[4];
    const capture = receipt ? (await import("./patch-edits.ts")).capturePatchEdits() : undefined;
    const { changes } = await applyPatch(patch, {
      cwd,
      beforeMutation: capture?.beforeMutation,
      maxOriginalBytes: capture?.maxOriginalBytes,
    });
    console.log(patchSuccess);
    for (const change of changes) {
      const marker = { added: "A", updated: "M", deleted: "D" }[change.kind];
      const path = change.moveTo === undefined ? change.path : `${change.path} -> ${change.moveTo}`;
      console.log(`${marker} ${path}`);
    }
    if (capture) {
      try {
        await writeFile(receipt, JSON.stringify(await capture.edits(changes)), { flag: "wx", mode: 0o600 });
      } catch {
        // The patch succeeded even if its optional conversation details cannot be saved.
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
