import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AssistantMessageComponent,
  getMarkdownTheme,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

type AssistantMessage = Parameters<
  AssistantMessageComponent["updateContent"]
>[0];

function message(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    model: "fixture",
    provider: "fixture",
    stopReason: "stop",
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

await test("expanded thinking preserves Markdown and reflows independently of the answer", () => {
  initTheme("dark", false);
  const prose = "The screenshot shows a thin slice of the terminal. "
    .repeat(4)
    .trimEnd();
  const input = message([
    { type: "thinking", thinking: "**Inspecting the screenshot**" },
    { type: "thinking", thinking: prose },
    { type: "text", text: "The answer follows." },
  ]);
  const transformed: { markdown: string; width: number; streaming: boolean }[] =
    [];
  const component = new AssistantMessageComponent(
    undefined,
    false,
    getMarkdownTheme(),
    undefined,
    1,
    [
      (markdown, { messageType, availableWidth, isStreaming }) => {
        if (messageType === "assistant-thinking") {
          transformed.push({
            markdown,
            width: availableWidth,
            streaming: isStreaming,
          });
        }
        return markdown;
      },
    ],
  );
  component.updateContent(input, true);
  for (const width of [160, 34]) {
    const lines = component.render(width);
    const plain = lines.map(stripTerminalSequences);
    assert.deepEqual(
      plain
        .filter((line) => line.includes("\u{F09D1}"))
        .map((line) => line.trimStart()),
      ["▾ \u{F09D1} "],
    );
    assert.ok(
      plain.some((line) => line.trim() === "│ Inspecting the screenshot"),
    );
    const body = plain.filter(
      (line) => line.includes("│ ") && !line.includes("Inspecting"),
    );
    assert.equal(
      body
        .map((line) => line.slice(line.indexOf("│") + 1).trim())
        .filter((line) => line.length > 0)
        .join(" "),
      prose,
    );
    assert.ok(body.every((line) => visibleWidth(line) <= Math.min(width, 91)));
    assert.ok(lines.every((line) => !line.includes("\u001b[3m")));
    assert.ok(plain.some((line) => line.trim() === "The answer follows."));
  }
  component.setHideThinkingBlock(true);
  const folded = component.render(34).map(stripTerminalSequences);
  assert.ok(folded.some((line) => line.trim() === "▸ \u{F09D1}"));
  assert.ok(!folded.join("").includes("Inspecting"));
  assert.deepEqual(
    transformed,
    [88, 30].map((width) => ({
      markdown: `**Inspecting the screenshot**\n\n${prose}`,
      width,
      streaming: true,
    })),
  );
});

await test("clicking a folded run preserves neighboring runs and the user's global visibility setting", () => {
  initTheme("dark", false);
  const input = message([
    { type: "thinking", thinking: "First note." },
    { type: "text", text: "Progress." },
    { type: "thinking", thinking: "Second note." },
  ]);
  const component = new AssistantMessageComponent(
    input,
    true,
    getMarkdownTheme(),
    "Notes",
  );
  const width = 48;
  const lines = component.render(width).map(stripTerminalSequences);
  assert.equal(lines.filter((line) => line.trim() === "▸ Notes").length, 2);
  assert.ok(!lines.join("").includes("note."));
  const row = lines.findIndex((line) => line.includes("▸ Notes"));
  assert.ok(
    component.handleMouse({
      type: "click",
      button: "left",
      x: 1,
      y: row,
      screenX: 1,
      screenY: row,
      width,
      height: lines.length,
      alt: false,
      shift: false,
      ctrl: false,
    })?.handled,
  );
  component.updateContent(input, true);
  const reopened = component
    .render(width)
    .map(stripTerminalSequences)
    .join("\n");
  assert.match(reopened, /│ First note\./u);
  assert.doesNotMatch(reopened, /Second note/u);
  component.setHideThinkingBlock(true);
  component.setHiddenThinkingLabel("");
  const hidden = component
    .render(width)
    .map(stripTerminalSequences)
    .join("")
    .trim();
  assert.equal(hidden, "Progress.");
});
