import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createEditToolDefinition,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { z } from "zod";
import { Attempts, attemptSchema, Phase } from "../attempts.ts";
import { registerCodeIntelligence } from "../code-intelligence/extension.ts";
import { registerDiagrams } from "../diagram/extension.ts";
import {
  mermaidDefinition,
  registerMermaidTool,
} from "../diagram/mermaid-tool.ts";
import { registerLeadControls } from "../lead-extension.ts";
import { LeadMode } from "../lead-plan.ts";
import { registerModelTools } from "../model-tools/extension.ts";

function event(type: string, data: object): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function patchReply(patch: string): string {
  return responsesReply({
    type: "custom_tool_call",
    name: "apply_patch",
    call_id: "call_patch",
    id: "ctc_patch",
    input: patch,
  });
}

function responsesReply(
  item: object = {
    type: "message",
    id: "msg_fixture",
    role: "assistant",
    content: [{ type: "output_text", text: "Done", annotations: [] }],
  },
): string {
  return (
    event("response.output_item.done", { output_index: 0, item }) +
    event("response.completed", {
      response: {
        id: "resp_fixture",
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    })
  );
}

function messagesReply(call?: { name: string; input: object }): string {
  const block =
    call === undefined
      ? { type: "text", text: "" }
      : {
          type: "tool_use",
          id: `toolu_${call.name}`,
          name: call.name,
          input: {},
        };
  const delta =
    call === undefined
      ? { type: "text_delta", text: "Done" }
      : { type: "input_json_delta", partial_json: JSON.stringify(call.input) };
  return (
    event("message_start", {
      message: {
        id: "msg_fixture",
        model: "claude-sonnet-4-6",
        role: "assistant",
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }) +
    event("content_block_start", { index: 0, content_block: block }) +
    event("content_block_delta", { index: 0, delta }) +
    event("content_block_stop", { index: 0 }) +
    event("message_delta", {
      delta: { stop_reason: call === undefined ? "end_turn" : "tool_use" },
      usage: { output_tokens: 1 },
    }) +
    event("message_stop", {})
  );
}

function lastClaudeToolResult(request: unknown, callId: string) {
  const last = z
    .object({ messages: z.array(z.object({ content: z.unknown() })) })
    .parse(request)
    .messages.at(-1);
  const blocks = z
    .array(
      z.object({
        type: z.literal("tool_result"),
        tool_use_id: z.string(),
        content: z.string(),
        is_error: z.boolean().optional(),
      }),
    )
    .parse(last?.content);
  const result = blocks.find((block) => block.tool_use_id === callId);
  assert.ok(result !== undefined);
  return result;
}

const declaration = z.looseObject({ name: z.string() });
const payload = z.looseObject({ tools: z.array(declaration) });
const canonicalDiagrams = ["render_mermaid", "show_diagram"];
const claudeDiagrams = ["RenderMermaid", "ShowDiagram"];

function diagramToolNames(request: unknown): string[] {
  return payload
    .parse(request)
    .tools.map(({ name }) => name)
    .filter(
      (name) =>
        canonicalDiagrams.includes(name) || claudeDiagrams.includes(name),
    )
    .sort();
}

const transportAcceptance =
  "Pi sends native tool contracts, executes calls and restores the active tool set on model change";

await test(transportAcceptance, { timeout: 30_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "studio-model-tools-"));
  t.after(() => rm(cwd, { force: true, recursive: true }));
  const previousState = process.env["STUDIO_STATE_DIR"];
  const state = join(cwd, "studio-state");
  process.env["STUDIO_STATE_DIR"] = state;
  t.after(() => {
    if (previousState === undefined) delete process.env["STUDIO_STATE_DIR"];
    else process.env["STUDIO_STATE_DIR"] = previousState;
  });
  const file = join(cwd, "message.txt");
  const deniedCommand = "touch forbidden.txt";
  const shellDenial = "The session denied this shell command";
  const diagramDenial = "The session denied this diagram export";
  const diagramAudit = "Inspected parcel tracking";
  const auditUsage = {
    input: 7,
    output: 3,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 10,
    cost: {
      input: 0.01,
      output: 0.02,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0.03,
    },
  };
  const emptyRender = { title: "Empty draft", source: " " };
  const blockedExports: (string | undefined)[] = [];
  const deniedShellInputs: unknown[] = [];
  const requests: unknown[] = [];
  const replies: string[] = [];
  const http = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      const reply = replies.shift();
      response.writeHead(reply === undefined ? 400 : 200, {
        "Content-Type": "text/event-stream",
      });
      response.end(reply ?? "Unexpected provider request");
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    http.closeAllConnections();
    http.close();
  });
  const addr = http.address();
  assert.ok(addr !== null && typeof addr !== "string");
  const url = `http://127.0.0.1:${String(addr.port)}`;
  const codexId = "gpt-5.3-codex";
  const claudeId = "claude-sonnet-4-6";
  const modelsPath = join(cwd, "models.json");
  await writeFile(
    modelsPath,
    JSON.stringify({
      providers: {
        openai: {
          api: "openai-responses",
          baseUrl: url,
          apiKey: "fixture",
          models: [
            {
              id: codexId,
              compat: {
                supportsOpenAIGrammarTools: true,
                supportsAdditionalTools: false,
              },
            },
          ],
        },
        anthropic: {
          api: "anthropic-messages",
          baseUrl: url,
          apiKey: "fixture",
          models: [
            { id: claudeId, compat: { supportsMidConvoToolChanges: false } },
          ],
        },
        gateway: {
          api: "openai-responses",
          baseUrl: url,
          apiKey: "fixture",
          models: [
            { id: "other-model" },
            {
              id: "openai.gpt-6.1-sol",
              compat: { supportsOpenAIGrammarTools: false },
            },
          ],
        },
      },
    }),
  );
  const modelRuntime = await ModelRuntime.create({
    modelsPath,
    authPath: join(cwd, "auth.json"),
    refreshOnCreate: false,
  });
  assert.equal(modelRuntime.getError(), undefined);
  const codex = modelRuntime.getModel("openai", codexId);
  const claude = modelRuntime.getModel("anthropic", claudeId);
  const other = modelRuntime.getModel("gateway", "other-model");
  const mantle = modelRuntime.getModel("gateway", "openai.gpt-6.1-sol");
  assert.ok(mantle !== undefined);
  assert.ok(codex !== undefined && claude !== undefined && other !== undefined);
  const services = await createAgentSessionServices({
    cwd,
    agentDir: cwd,
    modelRuntime,
    settingsManager: SettingsManager.inMemory(
      { retry: { enabled: false }, cacheWarming: "off" },
      { projectTrusted: false },
    ),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        (pi) => {
          pi.on("tool_call", (event) => {
            if (
              event.toolName === "bash" &&
              event.parentToolCallId !== undefined &&
              event.input["command"] === deniedCommand
            ) {
              deniedShellInputs.push(event.input);
              return { block: true, reason: shellDenial };
            }
            return undefined;
          });
          // A result observer may redact patch input after the real mutation.
          // The diagnostic refresh must still use the executor's receipt.
          pi.on("tool_result", (event) => {
            if (event.toolName === "apply_patch")
              event.input = { patch: "[redacted]" };
          });
          registerCodeIntelligence(pi);
          registerDiagrams(pi);
          registerMermaidTool(pi);
          registerModelTools(pi);
        },
        (pi) => {
          pi.registerTool({
            name: "inspect_callable_tools",
            label: "Inspect callable tools",
            description:
              "Report diagram tools callable by an independent extension.",
            parameters: Type.Object({}),
            async execute(_id, _args, _signal, _update, ctx) {
              const names = [...canonicalDiagrams, ...claudeDiagrams];
              const visible = ctx.tools
                .map((tool) => tool.name)
                .filter((name) => names.includes(name));
              const direct = await ctx.executeTool(
                "render_mermaid",
                emptyRender,
              );
              return {
                content: [
                  { type: "text", text: JSON.stringify(visible) },
                  ...direct.result.content,
                ],
                details: undefined,
              };
            },
          });
          pi.on("tool_call", (event) => {
            if (
              event.toolName === "render_mermaid" &&
              event.input["title"] === "Restricted export"
            ) {
              blockedExports.push(event.parentToolCallId);
              return { block: true, reason: diagramDenial };
            }
            return undefined;
          });
          pi.on("tool_result", (event) => {
            if (
              event.toolName === "show_diagram" &&
              event.parentToolCallId === "toolu_ShowDiagram"
            )
              return {
                content: [
                  ...event.content,
                  { type: "text", text: diagramAudit },
                ],
                usage: auditUsage,
              };
            return undefined;
          });
        },
      ],
    },
  });
  const { session } = await createAgentSessionFromServices({
    services,
    model: codex,
    sessionManager: SessionManager.inMemory(cwd),
  });
  t.after(() => {
    session.dispose();
  });
  await session.bindExtensions({ mode: "rpc" });

  const workdir = join(cwd, "operator's workspace");
  await mkdir(workdir);
  await writeFile(join(cwd, "previous.ts"), "export const retries = 1;\n");
  replies.push(
    patchReply(
      [
        "*** Begin Patch",
        "*** Add File: message.txt",
        "*** Reason: Give the client an initial greeting.",
        "+hello",
        "*** Update File: previous.ts",
        "*** Reason: Allow a second attempt after transient failures.",
        "*** Move to: renamed.ts",
        "@@",
        "-export const retries = 1;",
        "+export const retries = 2;",
        ...["two", "three", "four"].flatMap((name) => [
          `*** Add File: ${name}.ts`,
          `*** Reason: Provide the ${name} module.`,
          "+export {};",
        ]),
        "*** End Patch",
      ].join("\n"),
    ),
    responsesReply({
      type: "function_call",
      name: "shell_command",
      call_id: "call_shell",
      id: "fc_shell",
      arguments: JSON.stringify({ command: "pwd", workdir, timeout_ms: 2000 }),
    }),
    responsesReply({
      type: "function_call",
      name: "shell_command",
      call_id: "call_denied",
      id: "fc_denied",
      arguments: JSON.stringify({ command: deniedCommand, timeout_ms: 2500 }),
    }),
    responsesReply(),
  );
  await session.prompt("Create message.txt and check the working directory");
  assert.equal(requests.length, 4);
  const codexTools = payload.parse(requests[0]).tools;
  assert.deepEqual(diagramToolNames(requests[0]), canonicalDiagrams);
  const patchTool = z
    .object({
      type: z.literal("custom"),
      format: z.object({
        type: z.literal("grammar"),
        syntax: z.literal("lark"),
        definition: z.string(),
      }),
    })
    .parse(codexTools.find(({ name }) => name === "apply_patch"));
  assert.match(patchTool.format.definition, /\*\*\* Begin Patch/u);
  assert.match(patchTool.format.definition, /\*\*\* Reason: /u);
  assert.ok(
    !codexTools.some(({ name }) => ["edit", "write", "bash"].includes(name)),
  );
  assert.ok(codexTools.some(({ name }) => name === "shell_command"));
  const resultInput = z.object({
    input: z.array(z.looseObject({ type: z.string().optional() })),
  });
  const resultItems = resultInput.parse(requests[2]).input;
  const patchOutput = resultItems.find(
    (item) =>
      item.type === "custom_tool_call_output" &&
      item["call_id"] === "call_patch",
  );
  const patchFeedback = z.string().parse(patchOutput?.["output"]);
  assert.match(patchFeedback, /project trust/u);
  assert.match(patchFeedback, /"omittedFiles":1/u);
  assert.match(patchFeedback, /"path":"renamed.ts","state":"unavailable"/u);
  const [saved] = session.sessionManager
    .getBranch()
    .flatMap((entry) =>
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.toolName === "apply_patch"
        ? [entry.message]
        : [],
    );
  assert.ok(saved !== undefined);
  assert.partialDeepStrictEqual(saved.details, {
    studioPatchEdits: [
      {
        path: "previous.ts",
        reason: "Allow a second attempt after transient failures.",
        moveTo: "renamed.ts",
        diff: "-1 export const retries = 1;\n+1 export const retries = 2;",
        studioSyntax: { replacements: [{ original: "1", updated: "2" }] },
      },
    ],
    studioPatchDiagnostics: {
      files: ["renamed.ts", "two.ts", "three.ts"].map((path) => ({ path })),
      toolCallIds: [1, 2, 3].map(
        (index) => `${saved.toolCallId}:patch:${String(index)}`,
      ),
    },
  });
  const shellResult = resultItems.find(
    (item) =>
      item.type === "function_call_output" && item["call_id"] === "call_shell",
  );
  assert.ok(z.string().parse(shellResult?.["output"]).includes(workdir));
  const codexDenial = resultInput
    .parse(requests[3])
    .input.find(
      (item) =>
        item.type === "function_call_output" &&
        item["call_id"] === "call_denied",
    );
  assert.ok(z.string().parse(codexDenial?.["output"]).includes(shellDenial));
  assert.equal(await readFile(file, "utf8"), "hello\n");

  await session.setModel(claude);
  requests.length = 0;
  replies.push(
    messagesReply({ name: "Read", input: { file_path: file } }),
    messagesReply({
      name: "Edit",
      input: {
        file_path: file,
        old_string: "hello",
        new_string: "incorrect",
        reason: "   ",
      },
    }),
    messagesReply({
      name: "Edit",
      input: {
        file_path: file,
        old_string: "hello",
        new_string: "goodbye",
        reason: "Give departing clients a farewell.",
      },
    }),
    messagesReply({
      name: "Bash",
      input: { command: deniedCommand, timeout: 2500 },
    }),
    messagesReply({
      name: "ShowDiagram",
      input: {
        title: "Parcel tracking",
        systemId: "tracking",
        nodes: [
          {
            id: "tracking",
            kind: "system",
            label: "Tracking",
            detail: "Receives scans.",
          },
        ],
        edges: [],
      },
    }),
    messagesReply({
      name: "RenderMermaid",
      input: emptyRender,
    }),
    messagesReply({
      name: "render_mermaid",
      input: emptyRender,
    }),
    messagesReply({
      name: "RenderMermaid",
      input: { title: "Restricted export", source: "flowchart TD\n  A --> B" },
    }),
    messagesReply({ name: "inspect_callable_tools", input: {} }),
    messagesReply(),
  );
  await session.prompt("Change the greeting");
  assert.equal(requests.length, 10);
  const claudeTools = payload.parse(requests[0]).tools;
  assert.deepEqual(diagramToolNames(requests[0]), claudeDiagrams);
  for (const name of ["Read", "Edit", "Write", "Bash"])
    assert.ok(
      claudeTools.some((tool) => tool.name === name),
      name,
    );
  assert.ok(
    !claudeTools.some(({ name }) => name === "apply_patch" || name === "edit"),
  );
  const edit = z
    .object({ input_schema: z.object({ required: z.array(z.string()) }) })
    .parse(claudeTools.find(({ name }) => name === "Edit"));
  for (const key of ["file_path", "old_string", "new_string", "reason"])
    assert.ok(edit.input_schema.required.includes(key), key);
  const claudeRead = lastClaudeToolResult(requests[1], "toolu_Read");
  assert.ok(claudeRead.content.includes("1\thello"));
  const missingReason = lastClaudeToolResult(requests[2], "toolu_Edit");
  assert.equal(missingReason.is_error, true);
  assert.match(missingReason.content, /reason/u);
  const claudeDenial = lastClaudeToolResult(requests[4], "toolu_Bash");
  assert.equal(claudeDenial.is_error, true);
  assert.ok(claudeDenial.content.includes(shellDenial));
  const rpcDiagram = lastClaudeToolResult(requests[5], "toolu_ShowDiagram");
  assert.notEqual(rpcDiagram.is_error, true);
  assert.match(rpcDiagram.content, /diagram viewer is unavailable/u);
  assert.ok(rpcDiagram.content.includes(diagramAudit));
  const savedDiagramUsage = session.sessionManager
    .getBranch()
    .flatMap((entry) =>
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.toolCallId === "toolu_ShowDiagram"
        ? [entry.message.usage]
        : [],
    );
  assert.partialDeepStrictEqual(savedDiagramUsage, [auditUsage]);
  const emptyDraft = lastClaudeToolResult(requests[6], "toolu_RenderMermaid");
  assert.equal(emptyDraft.is_error, true);
  assert.match(emptyDraft.content, /Mermaid diagrams must contain/u);
  const hiddenTool = lastClaudeToolResult(requests[7], "toolu_render_mermaid");
  assert.equal(hiddenTool.is_error, true);
  assert.match(hiddenTool.content, /Use RenderMermaid/u);
  const blockedExport = lastClaudeToolResult(
    requests[8],
    "toolu_RenderMermaid",
  );
  assert.equal(blockedExport.is_error, true);
  assert.ok(blockedExport.content.includes(diagramDenial));
  assert.deepEqual(blockedExports, ["toolu_RenderMermaid"]);
  await assert.rejects(access(join(state, "artifacts", "mermaid")), {
    code: "ENOENT",
  });
  const callableTools = lastClaudeToolResult(
    requests[9],
    "toolu_inspect_callable_tools",
  );
  assert.match(callableTools.content, /^\[\]/u);
  assert.match(callableTools.content, /Tool render_mermaid not found/u);
  const expectedShellInput = { command: deniedCommand, timeout: 2.5 };
  assert.deepEqual(deniedShellInputs, [expectedShellInput, expectedShellInput]);
  await assert.rejects(readFile(join(cwd, "forbidden.txt")), {
    code: "ENOENT",
  });
  assert.equal(await readFile(file, "utf8"), "goodbye\n");

  await session.setModel(mantle);
  requests.length = 0;
  // Every hunk must have a reason before the first file changes, including on the JSON transport.
  const gatewayAdd = [
    "*** Add File: first.txt",
    "*** Reason: Preserve the example header.",
    "+*** Reason: literal source",
  ];
  const gatewayReply = (id: string, lines: string[]) =>
    responsesReply({
      type: "function_call",
      name: "apply_patch",
      call_id: id,
      id: `fc_${id}`,
      arguments: JSON.stringify({
        patch: ["*** Begin Patch", ...lines, "*** End Patch"].join("\n"),
      }),
    });
  replies.push(
    gatewayReply("blank", [
      ...gatewayAdd,
      "*** Delete File: message.txt",
      "*** Reason:    ",
    ]),
    gatewayReply("missing", [...gatewayAdd, "*** Delete File: message.txt"]),
    responsesReply(),
  );
  await session.prompt("Update the gateway workspace");
  const gatewayTools = payload.parse(requests[0]).tools;
  assert.deepEqual(diagramToolNames(requests[0]), canonicalDiagrams);
  const gatewayPatch = gatewayTools.find(({ name }) => name === "apply_patch");
  z.object({
    type: z.literal("function"),
    parameters: z.object({
      properties: z.object({ patch: z.object({ type: z.literal("string") }) }),
    }),
  }).parse(gatewayPatch);
  await assert.rejects(readFile(join(cwd, "first.txt")), { code: "ENOENT" });
  assert.equal(await readFile(file, "utf8"), "goodbye\n");
  for (const id of ["blank", "missing"]) {
    const item = resultInput
      .parse(requests[2])
      .input.find(
        (entry) =>
          entry.type === "function_call_output" && entry["call_id"] === id,
      );
    assert.match(z.string().parse(item?.["output"]), /\*\*\* Reason:/u);
  }
  replies.push(
    gatewayReply("valid", [
      ...gatewayAdd,
      "*** Update File: first.txt",
      "*** Reason: Give readers a starting value.",
      "@@",
      " *** Reason: literal source",
      "+one",
      "*** Update File: first.txt",
      "*** Reason: Show how the value changes.",
      "@@",
      " one",
      "+two",
    ]),
    responsesReply(),
  );
  await session.prompt("Store the example header");
  assert.equal(
    await readFile(join(cwd, "first.txt"), "utf8"),
    "*** Reason: literal source\none\ntwo\n",
  );
  const recorded = session.sessionManager
    .getBranch()
    .findLast(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolName === "apply_patch",
    );
  assert.ok(
    recorded?.type === "message" && recorded.message.role === "toolResult",
  );
  assert.partialDeepStrictEqual(recorded.message.details, {
    studioPatchEdits: [
      { kind: "added", reason: "Preserve the example header." },
      {
        kind: "updated",
        reason: "Give readers a starting value. Show how the value changes.",
      },
    ],
  });

  await session.setModel(other);
  requests.length = 0;
  replies.push(responsesReply());
  await session.prompt("Inspect the workspace");
  const restored = payload.parse(requests[0]).tools.map(({ name }) => name);
  assert.deepEqual(diagramToolNames(requests[0]), canonicalDiagrams);
  for (const name of ["read", "edit", "write", "bash"])
    assert.ok(restored.includes(name), name);
  for (const name of ["Edit", "Read", "Write", "Bash", "apply_patch"])
    assert.ok(!restored.includes(name), name);

  await session.setModel(claude);
  session.setActiveToolsByName(
    session.getActiveToolNames().filter((name) => name !== "render_mermaid"),
  );
  requests.length = 0;
  replies.push(
    messagesReply({
      name: "RenderMermaid",
      input: emptyRender,
    }),
    messagesReply(),
  );
  await session.prompt("Inspect the restricted diagram tools");
  assert.deepEqual(diagramToolNames(requests[0]), ["ShowDiagram"]);
  const disabledRender = lastClaudeToolResult(
    requests[1],
    "toolu_RenderMermaid",
  );
  assert.equal(disabledRender.is_error, true);
  assert.notEqual(disabledRender.content, emptyDraft.content);

  const restricted = await createAgentSessionFromServices({
    services,
    model: codex,
    tools: ["read"],
    sessionManager: SessionManager.inMemory(cwd),
  });
  t.after(() => {
    restricted.session.dispose();
  });
  await restricted.session.bindExtensions({ mode: "rpc" });
  requests.length = 0;
  replies.push(
    patchReply(
      "*** Begin Patch\n*** Delete File: message.txt\n*** Reason: Remove the fixture.\n*** End Patch",
    ),
    responsesReply(),
  );
  await restricted.session.prompt("Inspect this read-only workspace");
  const readOnly = payload.parse(requests[0]).tools.map(({ name }) => name);
  assert.ok(readOnly.includes("read"));
  assert.ok(!readOnly.includes("apply_patch"));
  assert.equal(requests.length, 2);
  assert.equal(await readFile(file, "utf8"), "goodbye\n");

  const governed = await createAgentSessionFromServices({
    services,
    model: codex,
    sessionManager: SessionManager.inMemory(cwd),
    customTools: [
      {
        name: "edit",
        parameters: createEditToolDefinition(cwd).parameters,
        description: "Make repository-approved edits.",
        label: "Repository-approved edit",
        execute() {
          return Promise.reject(new Error("Edit requires approval"));
        },
      },
    ],
  });
  t.after(() => {
    governed.session.dispose();
  });
  await governed.session.bindExtensions({ mode: "rpc" });
  requests.length = 0;
  replies.push(responsesReply());
  await governed.session.prompt("Inspect the approved tools");
  const governedCodex = payload
    .parse(requests[0])
    .tools.map(({ name }) => name);
  assert.ok(governedCodex.includes("edit"));
  assert.ok(!governedCodex.includes("apply_patch"));
  await governed.session.setModel(claude);
  requests.length = 0;
  replies.push(messagesReply());
  await governed.session.prompt("Inspect the approved tools under Claude");
  const governedClaude = payload
    .parse(requests[0])
    .tools.map(({ name }) => name);
  assert.ok(governedClaude.includes("edit"));
  assert.ok(!governedClaude.includes("Edit"));

  // Exercise the actual task-bound planning gate with a real Pi registry.
  const attempts = new Attempts(join(cwd, "attempts"));
  t.after(() => {
    attempts.close();
  });
  for (const foreignAlias of [false, true]) {
    const manager = SessionManager.inMemory(cwd);
    const id = manager.getSessionId();
    const record = attemptSchema.parse({
      id,
      source: { url, projectId: id },
      bead: {
        id: "tracking",
        title: "Inspect parcel tracking",
        status: "in_progress",
        revision: "1",
      },
      revision: "1",
      check: [],
      profile: "personal",
      model: { provider: "anthropic", model: claudeId, reasoning: "off" },
      leadPlan: { mode: LeadMode.Planning, draft: null },
      reservation: {
        primary: cwd,
        root: cwd,
        holder: id,
        agent: "pi",
        branch: "main",
        baseRef: "HEAD",
        baseCommit: "a".repeat(40),
        attempted: false,
      },
      session: "managed-fixture",
      live: false,
      pane: null,
      pid: null,
      transcript: null,
      checkout: null,
      processStarted: null,
      phase: Phase.Running,
      verification: null,
      message: "",
    });
    assert.ok(attempts.reserve(record));
    const managedExtension: ExtensionFactory = (pi) => {
      registerModelTools(pi, { coding: false });
      registerLeadControls(
        pi,
        attempts,
        id,
        () => Promise.resolve(record),
        () => undefined,
      );
      registerDiagrams(pi);
      registerMermaidTool(pi);
    };
    // This extension deliberately supplies the identical schema under a different owner.
    const foreignExtension: ExtensionFactory = (pi) => {
      pi.registerTool(mermaidDefinition("RenderMermaid"));
    };
    const managedServices = await createAgentSessionServices({
      cwd,
      agentDir: cwd,
      modelRuntime,
      settingsManager: services.settingsManager,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: foreignAlias
          ? [managedExtension, foreignExtension]
          : [managedExtension],
      },
    });
    const managed = await createAgentSessionFromServices({
      services: managedServices,
      model: claude,
      sessionManager: manager,
    });
    t.after(() => {
      managed.session.dispose();
    });
    await managed.session.bindExtensions({ mode: "rpc" });
    requests.length = 0;
    replies.push(
      messagesReply({ name: "RenderMermaid", input: emptyRender }),
      messagesReply({ name: "render_mermaid", input: emptyRender }),
      messagesReply(),
    );
    await managed.session.prompt("Inspect the managed planning tools");
    assert.deepEqual(
      diagramToolNames(requests[0]),
      foreignAlias ? ["ShowDiagram", "render_mermaid"] : claudeDiagrams,
    );
    const managedTools = payload
      .parse(requests[0])
      .tools.map(({ name }) => name);
    assert.ok(managedTools.includes("read"));
    assert.ok(
      !managedTools.some((name) =>
        ["Read", "Bash", "Edit", "Write", "write", "edit", "bash"].includes(
          name,
        ),
      ),
    );
    const alias = lastClaudeToolResult(requests[1], "toolu_RenderMermaid");
    const canonical = lastClaudeToolResult(requests[2], "toolu_render_mermaid");
    const admitted = foreignAlias ? canonical : alias;
    const denied = foreignAlias ? alias : canonical;
    assert.equal(admitted.content, emptyDraft.content);
    assert.equal(denied.is_error, true);
    assert.notEqual(denied.content, emptyDraft.content);
  }
});
