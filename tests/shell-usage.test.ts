import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { estimateShellUsage } from "../shell-usage.ts";

await test("shell usage estimates count the complete model call and all returned blocks", () => {
  const name = "shell_command";
  const args = {
    command: "rg -n 'a|b' file.ts",
    workdir: "/tmp/example",
    timeout_ms: 3000,
  };
  const result: AgentToolResult = {
    content: [
      { type: "text", text: "hidden by the collapsed preview\n".repeat(100) },
      { type: "image", data: "AA==", mimeType: "image/png" },
      { type: "text", text: "last line" },
    ],
    details: { fullOutputPath: "/tmp/output", metadata: "private".repeat(200) },
  };
  assert.deepEqual(estimateShellUsage(name, args, result), {
    call: Math.ceil((name.length + JSON.stringify(args).length) / 4),
    result: estimateTokens({
      role: "toolResult",
      toolCallId: "example",
      toolName: name,
      content: result.content,
      isError: false,
      timestamp: 0,
    }),
  });
  assert.deepEqual(estimateShellUsage("bash", { command: "true" }, { content: [] }), {
    call: 6,
    result: 0,
  });
});

await test("shell usage skips missing or unserializable tool arguments", () => {
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  for (const invalid of [undefined, null, cycle])
    assert.equal(estimateShellUsage("bash", invalid, { content: [] }), undefined);
});
