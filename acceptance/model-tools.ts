import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createEditToolDefinition,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { registerCodeIntelligence } from "../code-intelligence/extension.ts";
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

await test("Pi sends native tool contracts, executes calls and restores the active tool set on model change", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "studio-model-tools-"));
  t.after(() => rm(cwd, { force: true, recursive: true }));
  const file = join(cwd, "message.txt");
  const deniedCommand = "touch forbidden.txt";
  const shellDenial = "The session denied this shell command";
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
          registerModelTools(pi);
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
    messagesReply(),
  );
  await session.prompt("Change the greeting");
  assert.equal(requests.length, 5);
  const claudeTools = payload.parse(requests[0]).tools;
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
  for (const name of ["read", "edit", "write", "bash"])
    assert.ok(restored.includes(name), name);
  for (const name of ["Edit", "Read", "Write", "Bash", "apply_patch"])
    assert.ok(!restored.includes(name), name);

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
});
