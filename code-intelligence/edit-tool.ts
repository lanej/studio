import {
  createEditToolDefinition,
  generateDiffString,
  generateUnifiedPatch,
  withFileMutationQueue,
  type AgentToolResult,
  type EditToolDetails,
  type EditToolInput,
  type ToolInfo,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { access, readFile, writeFile } from "node:fs/promises";
import { analyzeEditSyntax } from "./syntax-analysis.ts";
import { maxSyntaxSourceBytes, supportsSyntax } from "./tree-sitter.ts";
import { Type } from "typebox";
import { z } from "zod";

export const editReason = Type.String({
  description: "In one sentence, explain the problem this edit fixes or the outcome it enables.",
  minLength: 1,
  pattern: "\\S",
});

const reasonInput = z.looseObject({ reason: z.string().trim().min(1) });

// Preserve the rest of the call while validating the reason before Pi coerces scalars.
export function requireEditReason(input: unknown) {
  const parsed = reasonInput.safeParse(input);
  if (!parsed.success) throw new Error("Explain why this edit is needed in the reason field.");
  return parsed.data;
}

// Pi computes its numbered diff after stripping the BOM and normalizing line endings.
function diffSource(text: string): string {
  return text.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
}

const studioEditSources = new WeakMap<object, ToolInfo["sourceInfo"]>();

export function isStudioEdit(tool: Pick<ToolInfo, "name" | "parameters" | "sourceInfo">): boolean {
  return tool.name === "edit" && studioEditSources.get(tool.parameters) === tool.sourceInfo;
}

async function withSyntax(
  path: string,
  result: AgentToolResult<EditToolDetails | undefined>,
  before?: Buffer,
  after?: string,
) {
  if (
    !supportsSyntax(path) ||
    !before ||
    after === undefined ||
    before.length > maxSyntaxSourceBytes ||
    Buffer.byteLength(after) > maxSyntaxSourceBytes ||
    !result.details ||
    result.details.diff.length > 65536
  )
    return result;
  try {
    const syntax = await analyzeEditSyntax(
      path,
      diffSource(before.toString("utf8")),
      diffSource(after),
      result.details.diff,
    );
    return !syntax ? result : { ...result, details: { ...result.details, studioSyntax: syntax } };
  } catch {
    // The file was already updated. A parser failure must not invite a second edit.
    return result;
  }
}

async function exactEdit(cwd: string, { path, edits }: EditToolInput, mode: "exact" | "all", signal?: AbortSignal) {
  const [replacement] = edits;
  if (!replacement || edits.length !== 1 || replacement.oldText === "")
    throw new Error("Exact editing requires one non-empty old string.");
  const file = resolve(cwd, path);
  return withFileMutationQueue(file, async () => {
    signal?.throwIfAborted();
    const buffer = await readFile(file);
    const raw = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(buffer);
    if (raw.includes("\0")) throw new Error("Edit requires a UTF-8 text file.");
    const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
    const before = raw.slice(bom.length);

    // Match LF input in a CRLF file. In mixed-ending files, match the literal text.
    const crlf = before.includes("\r\n") && !/(?<!\r)\n/u.test(before);
    const fileEndings = (value: string) => (crlf ? value.replaceAll(/\r?\n/gu, "\r\n") : value);
    const oldText = fileEndings(replacement.oldText);
    const newText = fileEndings(replacement.newText);
    const first = before.indexOf(oldText);
    if (first === -1) throw new Error("old_string does not match the file exactly.");
    if (mode === "exact" && before.indexOf(oldText, first + 1) !== -1)
      throw new Error("old_string matches multiple locations. Add context or set replace_all.");
    if (oldText === newText) throw new Error("old_string and new_string are identical.");
    // A callback preserves dollar signs literally in the replacement.
    const after = bom + before.replaceAll(oldText, () => newText);
    const start = diffSource(raw);
    const end = diffSource(after);
    const { diff, firstChangedLine } = generateDiffString(start, end);
    const details = {
      diff,
      patch: generateUnifiedPatch(path, start, end),
      ...(firstChangedLine === undefined ? {} : { firstChangedLine }),
    };
    signal?.throwIfAborted();
    await writeFile(file, after, "utf8");
    return withSyntax(
      path,
      {
        content: [{ type: "text", text: `Edited ${path}.` }],
        details,
      },
      buffer,
      after,
    );
  });
}

export function registerReasonedEdit(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    const edit = pi.getAllTools().find((tool) => tool.name === "edit");
    // SDK base-tool overrides do not carry the native prompt guidelines.
    // Keep custom executors (e.g. remote filesystems) and tool allowlists intact.
    if (edit?.sourceInfo.path !== "builtin:edit" || !edit.promptGuidelines) return;
    const { prepareArguments, ...native } = createEditToolDefinition(ctx.cwd);
    const parameters = Type.Object({
      ...native.parameters.properties,
      reason: editReason,
      matchMode: Type.Optional(
        Type.Union([Type.Literal("exact"), Type.Literal("all")], {
          description: "For a single replacement, require an exact match or replace all exact matches.",
        }),
      ),
    });
    pi.registerTool({
      ...native,
      defaultActive: false,
      parameters,
      ...(!prepareArguments
        ? {}
        : {
            prepareArguments(raw: unknown) {
              const args = requireEditReason(raw);
              return { ...prepareArguments(args), reason: args.reason };
            },
          }),
      async execute(id, args, signal, update, context) {
        requireEditReason(args);
        if (args.matchMode !== undefined) return exactEdit(context.cwd, args, args.matchMode, signal);
        if (!supportsSyntax(args.path)) return native.execute(id, args, signal, update, context);
        // Capture this edit's actual read and successful write inside Pi's mutation queue.
        // Reading the path again after execute could observe a subsequent edit.
        let before: Buffer | undefined;
        let after: string | undefined;
        const tool = createEditToolDefinition(ctx.cwd, {
          operations: {
            access: (path) => access(path, constants.R_OK | constants.W_OK),
            async readFile(path) {
              const buffer = await readFile(path);
              if (buffer.length <= maxSyntaxSourceBytes) before = buffer;
              return buffer;
            },
            async writeFile(path, content) {
              await writeFile(path, content, "utf8");
              if (before && Buffer.byteLength(content) <= maxSyntaxSourceBytes) after = content;
            },
          },
        });
        const result = await tool.execute(id, args, signal, update, context);
        return withSyntax(args.path, result, before, after);
      },
    });
    const registered = pi.getAllTools().find((tool) => tool.name === "edit" && tool.parameters === parameters);
    if (registered !== undefined) studioEditSources.set(parameters, registered.sourceInfo);
  });
}
