import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mantleModels } from "../pi-models.ts";

const runtime = await ModelRuntime.create({
  modelsPath: null,
  authPath: "/nonexistent/studio-fixture-auth.json",
  refreshOnCreate: false,
});
const template = runtime.getModel("amazon-bedrock", "openai.gpt-6.1-sol");
assert.ok(template !== undefined);
const future = {
  ...template,
  id: "future.model",
  name: "Future model",
  headers: { Authorization: "fixture-private-header" },
};
const models = [future, { ...template, id: "us.future.model" }];
const catalog = (api: Record<string, { base_url: string }>) => ({
  "amazon-bedrock": { models: { [future.id]: { id: future.id, api } } },
});

await test("Mantle generation follows declared APIs for new IDs and preserves Pi metadata", () => {
  const generated = mantleModels(
    models,
    catalog({
      responses: {
        base_url: `https://bedrock-mantle.\${AWS_REGION}.api.aws/future/v1`,
      },
      converse: {
        base_url: `https://bedrock-runtime.\${AWS_REGION}.amazonaws.com`,
      },
    }),
    "eu-west-3",
  );
  const definitions = generated.providers["bedrock-mantle"].models;
  assert.equal(definitions.length, 1);
  const model = definitions[0];
  assert.ok(model !== undefined);
  assert.equal(model.id, "future.model");
  assert.equal(model.api, "openai-responses");
  assert.equal(
    model.baseUrl,
    "https://bedrock-mantle.eu-west-3.api.aws/future/v1",
  );
  for (const field of [
    "name",
    "cost",
    "input",
    "inputLimits",
    "reasoning",
    "contextWindow",
    "maxTokens",
    "thinkingLevelMap",
  ] as const)
    assert.deepEqual(model[field], future[field], field);
  assert.doesNotMatch(JSON.stringify(generated), /fixture-private-header/);
  assert.deepEqual(model.compat, { supportsStrictMode: false });
  assert.equal(
    generated.providers["bedrock-mantle"].apiKey,
    "$AWS_BEARER_TOKEN_BEDROCK",
  );
});

await test("Mantle generation supports chat and Anthropic SDK endpoint conventions", () => {
  for (const [protocol, path, api, sdkPath] of [
    ["chat-completions", "/v1", "openai-completions", "/v1"],
    ["messages", "/anthropic/v1", "anthropic-messages", "/anthropic"],
  ] as const) {
    const model = mantleModels(
      models,
      catalog({
        [protocol]: {
          base_url: `https://bedrock-mantle.\${AWS_REGION}.api.aws${path}`,
        },
      }),
      "us-west-2",
    ).providers["bedrock-mantle"].models[0];
    assert.ok(model !== undefined);
    assert.equal(model.api, api);
    assert.equal(
      model.baseUrl,
      `https://bedrock-mantle.us-west-2.api.aws${sdkPath}`,
    );
  }
});

await test("Mantle generation rejects invalid regions and excludes untrusted endpoints or unsupported APIs", () => {
  const source = catalog({
    responses: { base_url: `https://bedrock-mantle.\${AWS_REGION}.api.aws/v1` },
  });
  assert.throws(
    () => mantleModels(models, source, "us-east-1/invalid"),
    /valid AWS region/,
  );
  for (const api of [
    { responses: { base_url: "https://other.example/v1" } },
    {
      responses: {
        base_url: `http://bedrock-mantle.\${AWS_REGION}.api.aws/v1`,
      },
    },
    {
      converse: {
        base_url: `https://bedrock-runtime.\${AWS_REGION}.amazonaws.com`,
      },
    },
    {
      future: { base_url: `https://bedrock-mantle.\${AWS_REGION}.api.aws/v1` },
    },
  ])
    assert.throws(() => mantleModels(models, catalog(api), "us-east-1"));
});
