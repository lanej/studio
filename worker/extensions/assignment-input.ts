import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { processFailure } from "../../process.ts";

export function assignmentInputExtension(
  check: () => Promise<void>,
): ExtensionFactory {
  let turn = 0;
  return (pi) => {
    pi.on("input", async (event, ctx) => {
      if (event.source === "extension") return;
      if (event.streamingBehavior !== undefined) {
        try {
          await check();
          return;
        } catch (error) {
          ctx.ui.notify(processFailure(error).message, "error");
        }
      }
      return { action: "handled" };
    });
    pi.on("turn_start", (_event, ctx) => {
      if (++turn > 32) ctx.abort();
    });
    pi.on("session_before_switch", () => ({ cancel: true }));
    pi.on("session_before_fork", () => ({ cancel: true }));
    pi.on("session_before_tree", () => ({ cancel: true }));
  };
}
