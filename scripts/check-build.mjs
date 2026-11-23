import "./runtime.mjs";
import { fileURLToPath } from "node:url";

const result = await Bun.build({
  entrypoints: [fileURLToPath(new URL("../cli.ts", import.meta.url))],
  target: "bun",
  packages: "external",
  write: false,
});
if (!result.success) throw new AggregateError(result.logs, "Studio source validation failed.");
