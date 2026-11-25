import { serveRuntime } from "../execution/supervisor.ts";

const stop = new AbortController();
process.once("SIGTERM", () => {
  stop.abort();
});
await serveRuntime(stop.signal, async (zellij, ...arguments_) => {
  const pane = await zellij.launch(...arguments_);
  console.log(
    `Withheld launch acknowledgement for terminal_${String(pane)} ${arguments_[2]} ${arguments_[3].at(-2) ?? ""}`,
  );
  throw new Error("Fixture withheld the real Zellij launch acknowledgement");
});
