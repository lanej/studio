import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AgentRole, ReasoningLevel } from "../config.ts";
import { runChild } from "../execution/child-session.ts";
import { coldReadInstructions } from "../review-contract.ts";

const prompt = "Read the admitted snapshot and report its contents.";
const finalText = "The snapshot contains the fixture.";
const toolName = "inspect_snapshot";

function reply(
  response: ServerResponse,
  stop: "tool_calls" | "stop" | "length",
  callsTool = stop === "tool_calls",
) {
  const delta = callsTool
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_fixture",
            type: "function",
            function: { name: toolName, arguments: "{}" },
          },
        ],
      }
    : { role: "assistant", content: finalText };
  const chunk = {
    id: "child-fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: "bounded",
    choices: [{ index: 0, delta, finish_reason: stop }],
  };
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
}

async function fixture(
  t: TestContext,
  respond: (response: ServerResponse, request: number) => void,
) {
  const cwd = await mkdtemp(join(tmpdir(), "studio-child-"));
  const sessionDir = join(cwd, "sessions");
  const agentDir = join(cwd, "agent");
  const previous = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = previous;
  });
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(sessionDir);
  await mkdir(agentDir);
  const globalInstructions =
    "Global instructions must not enter the child prompt.";
  await writeFile(join(agentDir, "APPEND_SYSTEM.md"), globalInstructions);
  const projectInstructions = "This text must never enter the child prompt.";
  await writeFile(join(cwd, "AGENTS.md"), projectInstructions);
  const authorizations: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    request.resume();
    authorizations.push(request.headers.authorization);
    respond(response, authorizations.length);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const runtime = await ModelRuntime.create({
    authPath: join(cwd, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const modelRegistry = new ModelRegistry(runtime);
  modelRegistry.registerProvider("studio-child-fixture", {
    api: "openai-completions",
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    models: [
      {
        id: "bounded",
        name: "bounded",
        input: ["text"],
        reasoning: true,
        contextWindow: 16000,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  await runtime.setRuntimeApiKey("studio-child-fixture", "parent-only");
  const model = modelRegistry.find("studio-child-fixture", "bounded");
  assert.ok(model !== undefined);
  const sessionManager = SessionManager.create(cwd, join(cwd, "lead"));
  sessionManager.appendMessage({
    role: "user",
    content: "Unrelated private lead context",
    timestamp: Date.now(),
  });
  const controller = new AbortController();
  let inspections = 0;
  let transcript: string | undefined;
  const run = (maxTurns = 8) =>
    runChild({ modelRegistry, sessionManager }, AgentRole.Reviewer, prompt, {
      agentId: "fixture-attempt",
      cwd,
      sessionDir,
      model,
      thinkingLevel: ReasoningLevel.Low,
      maxTurns,
      signal: controller.signal,
      tools: [
        {
          name: toolName,
          label: "Inspect",
          description: "Inspect the assigned fixture",
          parameters: Type.Object({}),
          execute() {
            inspections++;
            return Promise.resolve({
              content: [{ type: "text", text: "fixture" }],
              details: undefined,
            });
          },
        },
      ],
      onSessionCreated(session: AgentSession) {
        transcript = session.sessionManager.getSessionFile();
        assert.ok(transcript !== undefined);
        assert.equal(dirname(transcript), sessionDir);
        assert.equal(
          session.sessionManager.getHeader()?.parentSession,
          sessionManager.getSessionFile(),
        );
        assert.equal(
          session.sessionManager.getSessionName(),
          "reviewer#fixture-",
        );
        assert.deepEqual(session.messages, []);
        assert.deepEqual(session.getActiveToolNames(), [toolName]);
        assert.ok(session.systemPrompt.includes(coldReadInstructions));
        assert.ok(!session.systemPrompt.includes(projectInstructions));
        assert.ok(!session.systemPrompt.includes(globalInstructions));
        assert.equal(session.model?.provider, model.provider);
        assert.equal(session.model.id, model.id);
        assert.equal(session.thinkingLevel, ReasoningLevel.Low);
        assert.equal(authorizations.length, 0);
      },
    });
  return {
    run,
    controller,
    authorizations,
    inspections: () => inspections,
    transcript: () => {
      assert.ok(transcript !== undefined);
      return readFile(transcript, "utf8");
    },
  };
}

await test("the Studio child uses its parent's provider and a fresh restricted reviewer session", async (t) => {
  const child = await fixture(t, (res, count) => {
    reply(res, count === 1 ? "tool_calls" : "stop");
  });
  const result = await child.run();
  assert.equal(result.aborted, false);
  assert.equal(result.failure, undefined);
  assert.equal(result.responseText, finalText);
  assert.equal(child.inspections(), 1);
  assert.deepEqual(child.authorizations, [
    "Bearer parent-only",
    "Bearer parent-only",
  ]);
  const transcript = await child.transcript();
  for (const evidence of [prompt, toolName, finalText])
    assert.ok(transcript.includes(evidence));
});

await test(
  "cancelling a running Studio child interrupts the in-flight provider request",
  { timeout: 10000 },
  async (t) => {
    const child = await fixture(t, () => {
      child.controller.abort();
    });
    const result = await child.run();
    assert.equal(result.aborted, true);
    assert.equal(child.authorizations.length, 1);
  },
);

await test("a child can finish after its turn-budget reminder", async (t) => {
  const child = await fixture(t, (res, count) => {
    reply(res, count === 1 ? "tool_calls" : "stop");
  });
  const result = await child.run(1);
  assert.equal(result.failure, undefined);
  assert.equal(result.aborted, false);
  assert.equal(result.responseText, finalText);
  assert.equal(child.authorizations.length, 2);
  assert.match(await child.transcript(), /wrap up|final answer/iu);
});

await test("repeated truncated tool calls stop after the five wrap-up turns", async (t) => {
  const child = await fixture(t, (res, count) => {
    reply(res, count <= 6 ? "length" : "stop", count <= 6);
  });
  const result = await child.run(1);
  assert.match(result.failure ?? "", /turn limit/u);
  assert.equal(result.aborted, false);
  assert.equal(result.responseText, "");
  assert.equal(child.authorizations.length, 6);
  assert.equal(child.inspections(), 0);
});

await test("a truncated final answer cannot complete the child assignment", async (t) => {
  const child = await fixture(t, (res) => {
    reply(res, "length");
  });
  const result = await child.run();
  assert.ok(result.failure !== undefined);
  assert.equal(result.responseText, "");
  assert.equal(result.aborted, false);
});
