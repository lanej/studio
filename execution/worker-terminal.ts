import { run } from "../process.ts";
import { Zellij } from "../zellij.ts";

type WorkerTerminal = Pick<Zellij, "identity" | "detachedTab" | "launch">;

export function workerTerminalEnvironment(baseline: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...baseline };
  delete env["ZELLIJ"];
  delete env["ZELLIJ_SESSION_NAME"];
  delete env["ZELLIJ_PANE_ID"];
  return env;
}

/** One session per supervisor incarnation; do not recreate or adopt a replaced target. */
export function workerTerminal(
  name: string,
  baseline: NodeJS.ProcessEnv = process.env,
  adapters: { run: typeof run; connect(session: string): WorkerTerminal } = {
    run,
    connect: (session) => new Zellij(session, undefined, false),
  },
) {
  let identity: string | undefined;
  let requested = false;
  let confirmed = false;
  return async (executable: string, cwd: string) => {
    if (!requested) {
      requested = true;
      await adapters.run(executable, ["attach", "--create-background", name], {
        cwd,
        env: workerTerminalEnvironment(baseline),
      });
      confirmed = true;
    }
    if (!confirmed)
      throw new Error(
        `Creation of Studio worker session ${name} is unconfirmed; inspect it before restarting the runtime`,
      );
    const zellij = adapters.connect(name);
    if (identity !== undefined && zellij.identity !== identity)
      throw new Error(`Studio worker session ${name} was replaced; inspect it before restarting the runtime`);
    identity ??= zellij.identity;
    const tab = await zellij.detachedTab();
    return { zellij, tab };
  };
}
