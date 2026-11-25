import type {
  AgentToolUpdateCallback,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import {
  mkdtemp,
  readFile as readPrivateReceipt,
  rm,
  writeFile as writePrivateInput,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "../package-resources.ts";
import { MAX_PATCH_BYTES, patchSuccess } from "./codex-patch-runner.mjs";
import { patchEdits } from "./patch-edits.ts";
import { patchDiagnosticTargets } from "./patch-diagnostics.ts";
import {
  piShellArguments,
  quoteShellArgument,
  type ShellRequest,
} from "./shell.ts";

type Update = AgentToolUpdateCallback<unknown>;

// Nested Pi calls inherit the parent signal and run the session's tool hooks.
async function callPi(
  ctx: ExtensionToolContext,
  tool: "read" | "write" | "edit" | "bash",
  input: unknown,
  onUpdate?: Update,
) {
  const outcome = await ctx.executeTool(
    tool,
    input,
    onUpdate === undefined ? {} : { onUpdate },
  );
  return { ...outcome.result, isError: outcome.isError };
}

export function readFile(
  ctx: ExtensionToolContext,
  range: {
    path: string;
    offset?: number | undefined;
    limit?: number | undefined;
  },
  onUpdate?: Update,
) {
  return callPi(ctx, "read", range, onUpdate);
}

export function writeFile(
  ctx: ExtensionToolContext,
  path: string,
  content: string,
  onUpdate?: Update,
) {
  return callPi(ctx, "write", { path, content }, onUpdate);
}

export function replaceText(
  ctx: ExtensionToolContext,
  replacement: {
    path: string;
    oldText: string;
    newText: string;
    replaceAll: boolean;
    reason: string;
  },
  onUpdate?: Update,
) {
  const { path, oldText, newText, replaceAll, reason } = replacement;
  return callPi(
    ctx,
    "edit",
    {
      path,
      edits: [{ oldText, newText }],
      matchMode: replaceAll ? "all" : "exact",
      reason,
    },
    onUpdate,
  );
}

export function runShell(
  ctx: ExtensionToolContext,
  request: ShellRequest,
  onUpdate?: Update,
) {
  return callPi(ctx, "bash", piShellArguments(ctx.cwd, request), onUpdate);
}

export async function applyPatch(
  ctx: ExtensionToolContext,
  patch: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (Buffer.byteLength(patch) > MAX_PATCH_BYTES)
    throw new Error(`Patch exceeds the ${String(MAX_PATCH_BYTES)}-byte limit.`);
  // A private input file keeps source text out of shell syntax and argv limits.
  const directory = await mkdtemp(join(tmpdir(), "studio-codex-patch-"));
  try {
    const input = join(directory, "patch");
    const receipt = join(directory, "edits.json");
    await writePrivateInput(input, patch, { flag: "wx", mode: 0o600, signal });
    const command = [
      process.execPath,
      "--no-env-file",
      `--cwd=${packageRoot}`,
      `--config=${join(packageRoot, "resources/bunfig.toml")}`,
      join(packageRoot, "model-tools/codex-patch-runner.mjs"),
      input,
    ]
      .map(quoteShellArgument)
      .join(" ");
    // Bun starts in Studio's installation. The admitted shell supplies the actual target cwd.
    const outcome = await runShell(ctx, {
      command: `${command} "$PWD" ${quoteShellArgument(receipt)}`,
    });
    const applied =
      !outcome.isError &&
      outcome.content.some(
        (item) =>
          item.type === "text" && item.text.startsWith(`${patchSuccess}\n`),
      );
    // Decoration travels outside shell stdout; the model receives the original
    // result and the transcript can replay the edit without reopening the file.
    const edits = applied
      ? await readPrivateReceipt(receipt, "utf8")
          .then((raw) => patchEdits.parse(JSON.parse(raw)))
          .catch(() => undefined)
      : undefined;
    return {
      content: outcome.content,
      details: applied
        ? {
            studioPatchApplied: true,
            ...(edits === undefined ? {} : { studioPatchEdits: edits }),
            studioPatchTargets: patchDiagnosticTargets(patch),
          }
        : undefined,
      isError: outcome.isError,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
