import type { Command } from "commander";
import { isDeepStrictEqual } from "node:util";

// The declarations also power offline completion. Load execution dependencies
// only inside actions so inspection cannot initialize the runtime graph.
export async function approveManualMerge(
  id: string,
  head: string,
): Promise<void> {
  const { recordManualMergeApproval } = await import("./manual-merge.ts");
  await recordManualMergeApproval(id, head);
}

export async function retryAttempt(id: string): Promise<void> {
  const { retryWriterFence } = await import("./recovery.ts");
  const { ExecutionStore, ExecutionPhase, pendingDecision } = await import(
    "./store.ts"
  );
  const { ExecutionBeads } = await import("./beads.ts");
  const { ensureRuntime } = await import("./supervisor.ts");
  const store = new ExecutionStore();
  try {
    const record = store.attempt(id);
    if (pendingDecision(record) !== undefined)
      throw new Error(
        "An operator decision is pending; answer its exact request instead of retrying",
      );
    if (record.interactive !== undefined)
      throw new Error(
        "Interactive attempts retain their original pane binding. Inspect the transcript and checkout; automatic replacement is unavailable.",
      );
    if (
      ![
        ExecutionPhase.Parked,
        ExecutionPhase.Uncertain,
        ExecutionPhase.Delivery,
      ].includes(record.phase)
    )
      throw new Error(
        "Only parked, uncertain, or delivery-pending work can be explicitly retried",
      );
    if (await retryWriterFence(record))
      throw new Error(
        "The prior host/verifier may still exist or lacks a complete launch receipt; retain its writer fence until positively reconciled",
      );
    const project = store.project(record.project);
    const service = new ExecutionBeads(project.source);
    if (record.bead === undefined || record.revision === undefined)
      throw new Error(
        "Inspect the uncertain claim by its recorded actor before retrying; no admitted task is confirmed",
      );
    await service.requireCurrent(record.bead, record.revision, record.id);
    if (await retryWriterFence(record))
      throw new Error("A prior writer appeared during retry validation");
    store.change(id, (row) => {
      if (
        !isDeepStrictEqual(row, record) ||
        !isDeepStrictEqual(store.project(record.project), project)
      )
        throw new Error(
          "The attempt or project changed during retry validation",
        );
      row.launchToken = undefined;
      row.launchSettled = true;
      row.phase = ExecutionPhase.Queued;
      row.pid = undefined;
      row.started = undefined;
      row.message =
        "Explicit retry requested after confirming the prior host is gone";
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
  const runtime = program
    .command("runtime")
    .description("Control the independent approved-work runtime");
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
      console.log(
        "Runtime start requested. Inspect studio runtime status for confirmed ownership and work.",
      );
    });
  runtime
    .command("serve")
    .description(
      "Run the private runtime supervisor (normally started by runtime start)",
    )
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
    .description(
      "Inspect runtime ownership, attempts, retained sessions and policy",
    )
    .action(async () => {
      const { ExecutionStore } = await import("./store.ts");
      const { processMatchesStart } = await import("../process.ts");
      const { mergePolicy } = await import("./policy.ts");
      const store = new ExecutionStore();
      try {
        const supervisor = store.supervisor();
        const projects = await Promise.all(
          store.projects().map(async (project) => ({
            id: project.id,
            root: project.root,
            profile: project.profile,
            mergePolicy: await mergePolicy(project.id),
          })),
        );
        console.log(
          JSON.stringify(
            {
              supervisor: supervisor ?? null,
              allocationOwner: store.allocationOwner() ?? null,
              live:
                supervisor !== undefined &&
                (await processMatchesStart(supervisor.pid, supervisor.started)),
              projects,
              attempts: store.attempts(),
            },
            null,
            2,
          ),
        );
      } finally {
        store.close();
      }
    });
  runtime
    .command("stop")
    .description(
      "Stop new admission; existing task hosts retain ownership and continue",
    )
    .action(async () => {
      const { ExecutionStore } = await import("./store.ts");
      const store = new ExecutionStore();
      try {
        store.transaction(() => {
          const supervisor = store.supervisor();
          if (supervisor !== undefined)
            store.setSupervisor({ ...supervisor, stop: true });
        });
      } finally {
        store.close();
      }
      console.log(
        "Scheduling stop recorded. Existing task hosts continue; inspect status before stopping any task.",
      );
    });
  runtime
    .command("approve-merge <attempt>")
    .description(
      "Approve the current reviewed head of one manual-merge pull request",
    )
    .requiredOption(
      "--head <sha>",
      "Full commit SHA shown by the ready attempt",
    )
    .action(async (id: string, options: { head: string }) => {
      await approveManualMerge(id, options.head);
      console.log(
        `Merge approval recorded for ${options.head}. The delivery controller will check current readiness before submitting it.`,
      );
    });
  runtime
    .command("answer <attempt> <request>")
    .description(
      "Answer a retained operator decision and resume scheduling, including other ready work",
    )
    .requiredOption("--text <text>")
    .action(async (id: string, request: string, options: { text: string }) => {
      console.log(
        JSON.stringify(
          await (
            await import("./decisions.ts")
          ).answerDecision(id, request, options.text),
        ),
      );
    });
  runtime
    .command("retry <attempt>")
    .description(
      "Resume one retained attempt after its prior host is confirmed gone",
    )
    .action(async (id: string) => {
      await retryAttempt(id);
    });
}
