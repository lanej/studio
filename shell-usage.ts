import {
  estimateTokens,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";

function serializeArguments(modelArgs: unknown): string | undefined {
  if (
    typeof modelArgs !== "object" ||
    modelArgs === null ||
    Array.isArray(modelArgs)
  )
    return undefined;
  try {
    return JSON.stringify(modelArgs);
  } catch {
    return undefined;
  }
}

// Pi reports provider usage for an entire assistant response. Its context
// estimator counts each tool call's name and serialized arguments, then the
// content blocks returned to the model. Keep UI-only arguments and result
// details out of that estimate.
export function estimateShellUsage(
  toolName: string,
  modelArgs: unknown,
  result: Pick<AgentToolResult, "content">,
): { call: number; result: number } | undefined {
  const args = serializeArguments(modelArgs);
  if (args === undefined) return undefined;

  // These are the two text inputs Pi counts for an assistant tool-call block.
  // Passing only that text avoids charging other blocks from the same response.
  const call = estimateTokens({
    role: "user",
    content: toolName + args,
    timestamp: 0,
  });
  return {
    call,
    result: estimateTokens({
      role: "toolResult",
      toolName,
      toolCallId: "",
      content: result.content,
      isError: false,
      timestamp: 0,
    }),
  };
}
