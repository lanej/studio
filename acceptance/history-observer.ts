import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { z } from "zod";

/** Test-only observation: never handles a key or changes editor/model state. */
export default function observeHistory(pi: ExtensionAPI): void {
  const destination = z.string().min(1).parse(process.env["STUDIO_HISTORY_PROBE"]);
  const generation = randomUUID();
  let settled = 0;
  let cycles = 0;
  let inputs = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let remove: (() => void) | undefined;
  pi.on("session_start", (event, ctx) => {
    const record = () => {
      const staged = `${destination}.tmp`;
      writeFileSync(
        staged,
        JSON.stringify({
          generation,
          reason: event.reason,
          settled,
          cycles,
          inputs,
          text: ctx.ui.getEditorText(),
          selected: ctx.model?.id,
          available: ctx.modelRegistry
            .getAvailable()
            .filter((model) => model.provider === "fixture")
            .map((model) => model.id),
          scoped: ctx.scopedModels.map(({ model }) => model.id),
          bindings: getKeybindings().getUserBindings(),
        }),
      );
      renameSync(staged, destination);
    };
    record();
    remove = ctx.ui.onTerminalInput(() => {
      inputs++;
      clearTimeout(timer);
      timer = setTimeout(record, 10);
      return undefined;
    });
    pi.on("agent_settled", () => {
      settled++;
      record();
    });
    pi.on("model_select", (selection) => {
      if (selection.source === "cycle") cycles++;
      record();
    });
  });
  pi.on("session_shutdown", () => {
    clearTimeout(timer);
    remove?.();
  });
}
