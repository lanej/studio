import { spawn } from "node:child_process";
import { constants } from "node:os";
import { join } from "node:path";
import { packageRoot } from "./package-resources.ts";

export async function startSession(args: string[] = []): Promise<void> {
  const child = spawn(join(packageRoot, "scripts/pi"), ["--extension", join(packageRoot, "extension.ts"), ...args], {
    stdio: "inherit",
  });
  const interrupt = (): void => {
    child.kill("SIGINT");
  };
  const terminate = (): void => {
    child.kill("SIGTERM");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        process.exitCode = code ?? (signal === null ? 1 : 128 + constants.signals[signal]);
        resolve();
      });
    });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}
