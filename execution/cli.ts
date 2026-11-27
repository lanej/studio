import { Option, type Command } from "commander";
import { isDeepStrictEqual } from "node:util";

// The declarations also power offline completion. Load execution dependencies
// only inside actions so inspection cannot initialize the runtime graph.
export async function approveManualMerge(id: string, head: string): Promise<void> {
  const { recordManualMergeApproval } = await import("./manual-merge.ts");
  await recordManualMergeApproval(id, head);
}

export async function retryAttempt(id: string): Promise<void> {
  const { retryWriterFence } = await import("./recovery.ts");
  const { ExecutionStore, ExecutionPhase, pendingDecision } = await import("./store.ts");
  const { ExecutionBeads } = await import("./beads.ts");
  const { ensureRuntime } = await import("./supervisor.ts");
  const store = new ExecutionStore();
  try {
    const record = store.attempt(id);
    if (pendingDecision(record) !== undefined)
      throw new Error("An operator decision is pending; answer its exact request instead of retrying");
    if (record.interactive)
      throw new Error(
        "Interactive attempts retain their original pane binding. Inspect the transcript and checkout; automatic replacement is unavailable.",
      );
    if (![ExecutionPhase.Parked, ExecutionPhase.Uncertain, ExecutionPhase.Delivery].includes(record.phase))
      throw new Error("Only parked, uncertain, or delivery-pending work can be explicitly retried");
    if (await retryWriterFence(record))
      throw new Error(
        "The prior host/verifier may still exist or lacks a complete launch receipt; retain its writer fence until positively reconciled",
      );
    const project = store.project(record.project);
    const service = new ExecutionBeads(project.source);
    if (!record.bead || record.revision === undefined)
      throw new Error(
        "Inspect the uncertain claim by its recorded actor before retrying; no admitted task is confirmed",
      );
    await service.requireCurrent(record.bead, record.revision, record.id);
    if (await retryWriterFence(record)) throw new Error("A prior writer appeared during retry validation");
    store.change(id, (row) => {
      if (!isDeepStrictEqual(row, record) || !isDeepStrictEqual(store.project(record.project), project))
        throw new Error("The attempt or project changed during retry validation");
      row.launchToken = undefined;
      row.launchSettled = true;
      row.phase = ExecutionPhase.Queued;
      row.pid = undefined;
      row.started = undefined;
      row.message = "Explicit retry requested after confirming the prior host is gone";
    });
  } finally {
    store.close();
  }
  try {
    await ensureRuntime();
  } catch (error) {
    throw new Error(
      `Retry was queued, but the runtime did not start: ${error instanceof Error ? error.message : String(error)}. Start the runtime after resolving this.`,
      { cause: error },
    );
  }
}

export function registerRuntimeCommands(program: Command): void {
  const runtime = program.command("runtime").description("Control the independent approved-work runtime");
  runtime
    .command("verify <attempt>", { hidden: true })
    .requiredOption("--token <token>")
    .action(async (id: string, options: { token: string }) => {
      const { runVerification } = await import("./verification.ts");
      await runVerification(id, options.token);
    });
  runtime
    .command("start")
    .description("Start the configured runtime independently of this terminal")
    .action(async () => {
      const { ensureRuntime } = await import("./supervisor.ts");
      await ensureRuntime();
      console.log("Runtime start requested. Inspect studio runtime status for confirmed ownership and work.");
    });
  runtime
    .command("serve")
    .description("Run the private runtime supervisor (normally started by runtime start)")
    .action(async () => {
      const { serveRuntime } = await import("./supervisor.ts");
      const controller = new AbortController();
      const stop = () => {
        controller.abort();
      };
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
      try {
        await serveRuntime(controller.signal);
      } finally {
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
      }
    });
  runtime
    .command("status")
    .description("Inspect runtime ownership, attempts, retained sessions and policy in a live terminal dashboard")
    .addOption(new Option("--summary", "Print a compact snapshot (default for redirected output)").conflicts("json"))
    .option("--json", "Print the full status snapshot as JSON")
    .action(async (options: { summary?: boolean; json?: boolean }) => {
      const { readRuntimeStatus, formatRuntimeSummary } = await import("./status.ts");
      const snapshot = await readRuntimeStatus();
      if (options.json === true) console.log(JSON.stringify(snapshot, null, 2));
      else if (
        options.summary === true ||
        !process.stdin.isTTY ||
        !process.stdout.isTTY ||
        process.env["TERM"] === "dumb"
      )
        console.log(formatRuntimeSummary(snapshot));
      else {
        const { showRuntimeStatus } = await import("./status-tui.ts");
        await showRuntimeStatus(snapshot);
      }
    });
  const bead = runtime.command("bead").description("Close or delete a bead in an enrolled project");
  bead
    .command("close <project> <id>")
    .description("Close one bead with a recorded reason")
    .requiredOption("--reason <text>", "Reason to record in Beads")
    .action(async (project: string, id: string, options: { reason: string }) => {
      const { changeRuntimeBead, inspectRuntimeBead } = await import("./status-beads.ts");
      await changeRuntimeBead(await inspectRuntimeBead({ project, id }), {
        kind: "close",
        reason: options.reason.trim(),
      });
      console.log(`Closed ${id} in Beads`);
    });
  bead
    .command("delete <project> <id>")
    .description("Permanently delete one bead")
    .requiredOption("--confirm <id>", "Repeat the exact bead ID to confirm deletion")
    .action(async (project: string, id: string, options: { confirm: string }) => {
      if (options.confirm !== id) throw new Error("Confirm deletion with the exact bead ID");
      const { changeRuntimeBead, inspectRuntimeBead } = await import("./status-beads.ts");
      await changeRuntimeBead(await inspectRuntimeBead({ project, id }), { kind: "delete" });
      console.log(`Deleted ${id} in Beads`);
    });
  runtime
    .command("stop")
    .description("Stop new admission; existing task hosts retain ownership and continue")
    .action(async () => {
      const { ExecutionStore } = await import("./store.ts");
      const store = new ExecutionStore();
      try {
        store.transaction(() => {
          const supervisor = store.supervisor();
          if (supervisor) store.setSupervisor({ ...supervisor, stop: true });
        });
      } finally {
        store.close();
      }
      console.log("Scheduling stop recorded. Existing task hosts continue; inspect status before stopping any task.");
    });
  runtime
    .command("approve-merge <attempt>")
    .description("Approve the current reviewed head of one manual-merge pull request")
    .requiredOption("--head <sha>", "Full commit SHA shown by the ready attempt")
    .action(async (id: string, options: { head: string }) => {
      await approveManualMerge(id, options.head);
      console.log(
        `Merge approval recorded for ${options.head}. The delivery controller will check current readiness before submitting it.`,
      );
    });
  runtime
    .command("answer <attempt> <request>")
    .description("Answer a retained operator decision and resume scheduling, including other ready work")
    .requiredOption("--text <text>")
    .action(async (id: string, request: string, options: { text: string }) => {
      console.log(JSON.stringify(await (await import("./decisions.ts")).answerDecision(id, request, options.text)));
    });
  runtime
    .command("retry <attempt>")
    .description("Resume one retained attempt after its prior host is confirmed gone")
    .action(async (id: string) => {
      await retryAttempt(id);
    });
}
