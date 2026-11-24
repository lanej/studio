import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskDelivery } from "../lead-plan.ts";
import { parseWorkerResult } from "../execution/worker.ts";

await test("local results consume only summary while retaining the original response", () => {
  for (const publication of [
    { title: "", body: "" },
    { title: null, body: 42 },
    { title: { unused: true }, body: ["unused"] },
    { title: "x".repeat(201), body: "x".repeat(20001) },
  ]) {
    const response = {
      summary: "Verified source and criterion evidence",
      ...publication,
    };
    const original = structuredClone(response);
    for (const delivery of [undefined, TaskDelivery.Local])
      assert.deepEqual(parseWorkerResult(response, delivery), {
        summary: response.summary,
      });
    assert.deepEqual(response, original);
  }
});

await test("local and PR results still require a nonempty bounded summary", () => {
  for (const delivery of [TaskDelivery.Local, TaskDelivery.PullRequest]) {
    for (const value of [
      {},
      { summary: "" },
      { summary: null },
      { summary: 42 },
      { summary: "x".repeat(8001) },
      null,
      [],
    ])
      assert.throws(() => parseWorkerResult(value, delivery));
  }
});

await test("PR results retain publication metadata validation and optional-field fallbacks", () => {
  const summary = "Verified implementation";
  const valid = {
    summary,
    title: "Fix the reported behavior",
    body: "Outcome and evidence",
  };
  assert.deepEqual(parseWorkerResult(valid, TaskDelivery.PullRequest), valid);
  assert.deepEqual(parseWorkerResult({ summary }, TaskDelivery.PullRequest), {
    summary,
  });
  assert.deepEqual(
    parseWorkerResult({ summary, body: "" }, TaskDelivery.PullRequest),
    { summary, body: "" },
  );
  for (const publication of [
    { title: "" },
    { title: null },
    { title: 42 },
    { title: "x".repeat(201) },
    { body: null },
    { body: [] },
    { body: "x".repeat(20001) },
  ])
    assert.throws(() =>
      parseWorkerResult({ summary, ...publication }, TaskDelivery.PullRequest),
    );
});
