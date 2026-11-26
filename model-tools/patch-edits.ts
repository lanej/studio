import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { diffLines } from "diff";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";
import { diffScope } from "../code-intelligence/scopes.ts";
import { analyzeEditSyntax, syntaxReplacement } from "../code-intelligence/syntax-analysis.ts";
import { maxSyntaxSourceBytes, supportsSyntax } from "../code-intelligence/tree-sitter.ts";

export const patchEdits = z
  .array(
    z.object({
      kind: z.enum(["added", "updated", "deleted"]),
      path: z.string(),
      reason: z.string().optional(),
      moveTo: z.string().optional(),
      overwrote: z.literal(true).optional(),
      diff: z.string().optional(),
      studioSyntax: z
        .object({
          scopes: z.array(diffScope).max(32),
          replacements: z.array(syntaxReplacement).max(2048),
        })
        .optional(),
      studioDiffScopes: z.array(diffScope).max(32).optional(),
    }),
  )
  .max(1000);
type PatchEdit = z.infer<typeof patchEdits>[number];
type FileChange = Pick<PatchEdit, "path" | "kind" | "moveTo" | "reason">;
interface Mutation {
  kind: "add" | "update" | "delete";
  path: string;
  original?: string;
  overwrote?: boolean;
  content?: string;
}

const maxDiffBytes = 64 * 1024;
const previewBytes = 256 * 1024;
const sourceBudget = 4 * maxSyntaxSourceBytes;

// Add can overwrite an existing regular file; delete can unlink a symlink.
// Never open the symlink's target just to display a deletion.
async function originalAtPath(path: string, limit: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) return undefined;
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await file.read(bytes, count, bytes.length - count, null);
      if (bytesRead === 0) break;
      count += bytesRead;
    }
    if (count !== stat.size) return undefined;
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, count));
  } finally {
    await file.close();
  }
}

function diffSource(text: string) {
  // Same numbered-line coordinates as Studio Edit and its syntax analysis.
  return text.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
}

interface Images {
  before: string;
  after: string;
}

async function displayEdit(change: FileChange, images: Images) {
  const before = diffSource(images.before);
  const after = diffSource(images.after);
  if (
    (before.length === 0 || after.length === 0) &&
    Buffer.byteLength(before) + Buffer.byteLength(after) > maxDiffBytes
  )
    return undefined;
  // generateDiffString uses the same line diff. Bound the search distance before
  // invoking it on completely different or generated files.
  if (
    before.length > 0 &&
    after.length > 0 &&
    diffLines(before, after, { timeout: 100, maxEditLength: 512 }) === undefined
  )
    return undefined;
  const { diff } = generateDiffString(before, after);
  if (Buffer.byteLength(diff) > maxDiffBytes) return undefined;
  const path = change.moveTo ?? change.path;
  const studioSyntax =
    diff.length > 0 && supportsSyntax(path)
      ? await analyzeEditSyntax(path, before, after, diff).catch(() => undefined)
      : undefined;
  return { diff, ...(!studioSyntax ? {} : { studioSyntax }) };
}

export function capturePatchEdits() {
  const images = new Map<number, Images>();
  const overwritten = new Set<number>();
  let operationIndex = 0;
  let remaining = sourceBudget;
  return {
    maxOriginalBytes: sourceBudget,
    async beforeMutation(operation: Mutation) {
      const index = operationIndex++;
      if (operation.overwrote === true) overwritten.add(index);
      if (index >= 32 || remaining <= 0) return;
      try {
        const after = operation.content ?? "";
        const limit = Math.min(maxSyntaxSourceBytes, remaining);
        if (Buffer.byteLength(after) > limit) return;
        const before =
          operation.kind === "update"
            ? operation.original
            : operation.kind === "add" && operation.overwrote !== true
              ? ""
              : await originalAtPath(operation.path, limit);
        if (
          before === undefined ||
          Buffer.byteLength(before) > limit ||
          // The patch executor decodes update sources with replacement on invalid UTF-8.
          before.includes("\0") ||
          after.includes("\0") ||
          before.includes("\uFFFD") ||
          after.includes("\uFFFD")
        )
          return;
        const bytes = Buffer.byteLength(before) + Buffer.byteLength(after);
        if (bytes > remaining) return;
        remaining -= bytes;
        images.set(index, { before, after });
      } catch {
        // A write-only file or a symlink can still be replaced or removed.
      }
    },
    async edits(changes: FileChange[]) {
      const edits: PatchEdit[] = [];
      let remainingPreview = previewBytes;
      for (const [index, change] of changes.entries()) {
        const edit: PatchEdit = {
          ...change,
          ...(overwritten.has(index) ? { overwrote: true } : {}),
        };
        edits.push(edit);
        const sources = images.get(index);
        if (!sources || remainingPreview <= 0) continue;
        try {
          const data = await displayEdit(change, sources);
          if (!data) continue;
          const bytes = Buffer.byteLength(JSON.stringify(data));
          if (bytes > remainingPreview) continue;
          remainingPreview -= bytes;
          Object.assign(edit, data);
        } catch {
          // The patch already succeeded. Keep the file in the receipt if optional analysis fails.
        }
      }
      return edits;
    },
  };
}
