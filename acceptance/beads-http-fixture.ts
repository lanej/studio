import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { z } from "zod";
import { withBeads, fixtureMetricsEnv, type NativeBeads } from "./beads-fixture.ts";

export interface BeadsHttpSource {
  url: string;
  projectId: string;
}

function announcedAddress(service: ChildProcess, deadline: number, diagnostics: () => string): Promise<string> {
  return new Promise((resolve, reject) => {
    let pending = "";
    let bytes = 0;
    const finish = (error: Error | undefined, url?: string) => {
      clearTimeout(timer);
      service.stdout?.off("data", data);
      service.off("error", failed);
      service.off("close", closed);
      if (error) reject(error);
      else if (url !== undefined) resolve(url);
    };
    const failed = (error: Error) => {
      finish(new Error(`Could not start Beads HTTP fixture: ${error.message}`));
    };
    const closed = () => {
      finish(
        new Error(
          `Beads HTTP fixture exited before announcing its address (code ${String(service.exitCode)}, signal ${String(service.signalCode)}): ${diagnostics()}`,
        ),
      );
    };
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8000) {
        finish(new Error("Beads HTTP fixture startup output exceeded 8000 bytes"));
        return;
      }
      pending += chunk.toString();
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) return;
        const line = pending.slice(0, newline).replace(/\r$/u, "");
        pending = pending.slice(newline + 1);
        if (!line.startsWith("bd serve: listening on ")) continue;
        const parsed = /^bd serve: listening on (http:\/\/127\.0\.0\.1:([1-9]\d{0,4}))$/u.exec(line);
        if (parsed?.[1] === undefined || parsed[2] === undefined || Number(parsed[2]) > 65535) {
          finish(new Error(`Invalid Beads HTTP fixture address announcement: ${line}`));
          return;
        }
        finish(undefined, parsed[1]);
        return;
      }
    };
    const timer = setTimeout(
      () => {
        finish(new Error(`Beads HTTP fixture did not announce its bound address: ${diagnostics()}`));
      },
      Math.max(0, deadline - Date.now()),
    );
    service.stdout?.on("data", data);
    service.once("error", failed);
    service.once("close", closed);
  });
}

/** The owned service binds its ephemeral port atomically; no listener hands off a reservation. */
export async function withBeadsServer<T>(
  bd: string,
  options: { cwd: string; env: NodeJS.ProcessEnv },
  use: (server: { url: string; deadline: number; assertRunning: () => void; diagnostics: () => string }) => Promise<T>,
  startupMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + startupMs;
  const service = spawn(bd, ["serve", "--addr", "127.0.0.1:0"], {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise<void>((resolve) => {
    service.once("close", () => {
      resolve();
    });
  });
  let diagnostics = "";
  let startupError: Error | undefined;
  const record = (chunk: Buffer) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-8000);
  };
  service.stdout.on("data", record);
  service.stderr.on("data", record);
  service.on("error", (error) => {
    startupError = error;
  });
  const assertRunning = () => {
    if (startupError) throw new Error(`Could not start Beads HTTP fixture: ${startupError.message}`);
    assert.equal(service.exitCode, null, diagnostics);
    assert.equal(service.signalCode, null, diagnostics);
    assert(service.pid !== undefined, `Could not start ${bd} serve`);
  };
  try {
    const url = await announcedAddress(service, deadline, () => diagnostics);
    assertRunning();
    const result = await use({
      url,
      deadline,
      assertRunning,
      diagnostics: () => diagnostics,
    });
    assertRunning();
    return result;
  } finally {
    if (service.exitCode === null && service.signalCode === null && service.pid !== undefined) {
      service.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (service.exitCode === null && service.signalCode === null) service.kill("SIGKILL");
      }, 5000);
      try {
        await closed;
      } finally {
        clearTimeout(timer);
      }
    } else await closed;
  }
}

export async function withBeadsHttp<T>(
  bd: string,
  dolt: string,
  use: (fixture: NativeBeads, source: BeadsHttpSource) => Promise<T>,
): Promise<T> {
  return withBeads(bd, dolt, async (fixture) => {
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !/^(BEADS_|BD_|DOLT_|GIT_|WORKTREE_|ZELLIJ|TMUX|PI_|PASEO_)/.test(key),
        ),
      ),
      HOME: fixture.directory,
      DOLT_ROOT_PATH: join(fixture.directory, "dolt-home"),
      DOLT_CLI_NO_UPDATE_CHECK: "1",
      ...fixtureMetricsEnv,
      PATH: `${dirname(dolt)}:${process.env["PATH"] ?? ""}`,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    return await withBeadsServer(
      bd,
      { cwd: fixture.workspace, env },
      async ({ url, deadline, assertRunning, diagnostics }) => {
        let projectId: string | undefined;
        while (Date.now() < deadline && projectId === undefined) {
          assertRunning();
          try {
            const response = await fetch(`${url}/v0/beads/context`, {
              signal: AbortSignal.timeout(1000),
            });
            if (response.ok)
              projectId = z.object({ project_id: z.string().min(1) }).parse(await response.json()).project_id;
          } catch {
            // The bound service may still be preparing its project context.
          }
          assertRunning();
          if (projectId === undefined) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert(
          projectId !== undefined && projectId.length > 0,
          `Beads HTTP fixture project context did not become ready: ${diagnostics()}`,
        );
        return await use(fixture, { url, projectId });
      },
    );
  });
}
