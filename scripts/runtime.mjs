import { readFileSync } from "node:fs";

const manifest = new URL("../package.json", import.meta.url);

function requireBun() {
  const requirement = JSON.parse(readFileSync(manifest, "utf8")).engines?.bun;
  const minimum = /^>=(\d+)\.(\d+)\.(\d+)$/u.exec(requirement ?? "");
  if (!minimum) {
    throw new Error("Studio requires an engines.bun minimum in the form >=major.minor.patch.");
  }
  const version = process.versions.bun;
  const current = /^(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/u.exec(version ?? "");
  if (current) {
    for (let index = 1; index <= 3; index += 1) {
      if (Number(current[index]) > Number(minimum[index])) return;
      if (Number(current[index]) < Number(minimum[index])) break;
      if (index === 3) return;
    }
  }
  throw new Error(`Studio requires Bun ${requirement} on PATH; found ${version ?? "no Bun runtime"}. Install or upgrade Bun through your environment setup.`);
}

// Imported by installation helpers and invoked by launchers before application code.
try {
  requireBun();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
