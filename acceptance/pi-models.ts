import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Type } from "typebox";
import { z } from "zod";
import { exampleConfig } from "../config.ts";
import { mantleModels } from "../pi-models.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "studio-mantle-"));
const agent = join(temporary, "agent");
const execute = promisify(execFile);
const received: {
  path: string;
  model: string;
  bearer: string | undefined;
  payload: unknown;
}[] = [];
const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const path = new URL(request.url ?? "", "http://localhost").pathname;
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString());
    const { model } = z.object({ model: z.string() }).parse(payload);
    received.push({
      path,
      model,
      bearer: request.headers.authorization,
      payload,
    });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (type: string, data: object) =>
      response.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
      );
    if (path.endsWith("/responses")) {
      send("response.output_item.done", {
        output_index: 0,
        item: {
          type: "message",
          id: "msg_fixture",
          role: "assistant",
          content: [{ type: "output_text", text: "OK", annotations: [] }],
        },
      });
      send("response.completed", {
        response: {
          id: "resp_fixture",
          status: "completed",
          output: [],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
    } else if (path.endsWith("/messages")) {
      send("message_start", {
        message: {
          id: "msg_fixture",
          model,
          role: "assistant",
          content: [],
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      });
      send("content_block_start", {
        index: 0,
        content_block: { type: "text", text: "" },
      });
      send("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: "OK" },
      });
      send("content_block_stop", { index: 0 });
      send("message_delta", {
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      });
      send("message_stop", {});
    } else {
      response.write(
        `data: ${JSON.stringify({
          id: "chat_fixture",
          object: "chat.completion.chunk",
          model,
          created: 0,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "OK" },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          id: "chat_fixture",
          object: "chat.completion.chunk",
          model,
          created: 0,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`,
      );
    }
    response.end();
  });
});
try {
  await mkdir(agent);
  const bundled = await ModelRuntime.create({
    modelsPath: null,
    authPath: join(temporary, "empty-auth.json"),
    refreshOnCreate: false,
  });
  const cached = bundled.getModel("amazon-bedrock", "openai.gpt-6.1-sol");
  assert.ok(cached !== undefined);
  // A remote catalog can introduce IDs after the pinned SDK was released.
  const newer = { ...cached, id: "fixture.future-model" };
  const cache = JSON.stringify({
    "amazon-bedrock": {
      models: [newer],
      lastModified: Date.now() + 86_400_000,
      checkedAt: Date.now(),
    },
  });
  await writeFile(join(agent, "models-store.json"), cache);
  const declarations = [
    { id: cached.id, protocol: "responses", path: "/openai/v1" },
    { id: "openai.gpt-oss-120b", protocol: "responses", path: "/v1" },
    {
      id: "anthropic.claude-opus-4-7",
      protocol: "messages",
      path: "/anthropic/v1",
    },
    {
      id: "nvidia.nemotron-nano-12b-v2",
      protocol: "chat-completions",
      path: "/v1",
    },
    { id: newer.id, protocol: "responses", path: "/future/v1" },
  ];
  const source = {
    "amazon-bedrock": {
      models: Object.fromEntries(
        declarations.map(({ id, protocol, path }) => [
          id,
          {
            id,
            capabilities: {
              reasoning: { effort: ["low", "medium", "high"] },
              temperature: false,
            },
            api: {
              [protocol]: {
                base_url: `https://bedrock-mantle.\${AWS_REGION}.api.aws${path}`,
                capabilities: {
                  tools: { strict: protocol !== "chat-completions" },
                },
              },
            },
          },
        ]),
      ),
    },
  };
  const catalogPath = join(temporary, "api.json");
  await writeFile(catalogPath, JSON.stringify(source));
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agent,
    AWS_REGION: "us-west-2",
    AWS_DEFAULT_REGION: "us-east-2",
    AWS_BEARER_TOKEN_BEDROCK: "fixture-token",
  };
  const driver = (...args: string[]) =>
    execute(join(root, "scripts/studio"), args, { env, timeout: 15_000 });
  const emitted = await driver(
    "config",
    "--pi-models",
    catalogPath,
    "--region",
    "eu-west-3",
  );
  assert.doesNotMatch(emitted.stdout, /fixture-token/);
  await writeFile(join(agent, "models.json"), emitted.stdout);
  const runtime = await ModelRuntime.create({
    authPath: join(agent, "auth.json"),
    modelsPath: join(agent, "models.json"),
  });
  assert.equal(runtime.getError(), undefined);
  const generated = runtime.getModels("bedrock-mantle");
  assert.equal(generated.length, declarations.length);
  for (const { id, protocol, path } of declarations) {
    const model = runtime.getModel("bedrock-mantle", id);
    const original =
      id === newer.id ? newer : bundled.getModel("amazon-bedrock", id);
    assert.ok(model !== undefined);
    assert.ok(original !== undefined);
    assert.equal(
      model.baseUrl,
      `https://bedrock-mantle.eu-west-3.api.aws${protocol === "messages" ? "/anthropic" : path}`,
    );
    assert.deepEqual(model.cost, original.cost);
    assert.deepEqual(model.inputLimits, original.inputLimits);
    assert.equal(model.contextWindow, original.contextWindow);
    assert.equal(model.maxTokens, original.maxTokens);
    assert.equal(model.reasoning, original.reasoning);
  }
  for (const selection of Object.values(exampleConfig.profiles.work))
    assert.ok(
      runtime.getModel(selection.provider, selection.model) !== undefined,
    );
  assert.equal(
    runtime.getModel("amazon-bedrock", "us.openai.gpt-6.1-sol")?.api,
    "bedrock-converse-stream",
  );
  assert.equal(await readFile(join(agent, "models-store.json"), "utf8"), cache);
  const envOutput = await driver("config", "--pi-models", catalogPath);
  assert.match(envOutput.stdout, /bedrock-mantle\.us-west-2\.api\.aws/u);
  await assert.rejects(
    execute(
      join(root, "scripts/studio"),
      ["config", "--pi-models", catalogPath],
      {
        env: { ...env, AWS_REGION: "", AWS_DEFAULT_REGION: "" },
        timeout: 10_000,
      },
    ),
    /Set --region/,
  );

  // Exercise the generated APIs through the real SDK on a local HTTP fixture.
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const fixture = mantleModels(
    [...bundled.getModels("amazon-bedrock"), newer],
    source,
    "eu-west-3",
  );
  fixture.providers["bedrock-mantle"].apiKey = "fixture-token";
  for (const model of fixture.providers["bedrock-mantle"].models)
    model.baseUrl = `http://127.0.0.1:${String(address.port)}${new URL(model.baseUrl).pathname}`;
  await writeFile(join(agent, "models.json"), JSON.stringify(fixture));
  const local = await ModelRuntime.create({
    authPath: join(agent, "auth.json"),
    modelsPath: join(agent, "models.json"),
  });
  for (const model of local.getModels("bedrock-mantle")) {
    const result = await local.completeSimple(
      model,
      {
        tools: [
          {
            name: "fixture_tool",
            description: "Fixture",
            parameters: Type.Object({ value: Type.String() }),
          },
        ],
        messages: [
          { role: "user", content: "Reply OK", timestamp: Date.now() },
        ],
      },
      { reasoning: "low", maxTokens: 8, signal: AbortSignal.timeout(10_000) },
    );
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(
      result.content.find((block) => block.type === "text")?.text,
      "OK",
    );
  }
  for (const { id, protocol, path } of declarations)
    assert.deepEqual(
      received
        .filter(({ model }) => model === id)
        .map(({ path: actual }) => actual),
      [
        `${path}/${protocol === "responses" ? "responses" : protocol === "messages" ? "messages" : "chat/completions"}`,
      ],
    );
  assert.ok(
    received
      .filter(({ path }) => !path.endsWith("/messages"))
      .every(({ bearer }) => bearer === "Bearer fixture-token"),
  );
  const chat = received.find(({ path }) => path.endsWith("/chat/completions"));
  assert.ok(chat !== undefined);
  const tools = z
    .object({
      tools: z.array(
        z.object({ function: z.object({ strict: z.boolean().optional() }) }),
      ),
    })
    .parse(chat.payload).tools;
  assert.ok(tools.length > 0);
  assert.ok(tools.every(({ function: fn }) => fn.strict === undefined));
  const messages = received.find(({ path }) => path.endsWith("/messages"));
  assert.ok(messages !== undefined);
  z.object({
    thinking: z.object({ type: z.literal("adaptive") }),
    output_config: z.object({ effort: z.literal("low") }),
  }).parse(messages.payload);
  console.log(
    "Pi consumed generated Mantle models and dispatched Responses, Chat Completions and Messages with preserved IDs, metadata and region selection.",
  );
} finally {
  if (server.listening)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      }),
    );
  await rm(temporary, { recursive: true, force: true });
}
