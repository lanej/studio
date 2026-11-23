import { writerFence } from "./recovery.ts";
import { runVerification } from "./verification.ts";
import type { Command } from "commander";
import { ensureRuntime, serveRuntime, alive } from "./supervisor.ts";
import { ExecutionStore, ExecutionPhase } from "./store.ts";
import { ExecutionBeads } from "./beads.ts";
import { mergePolicy } from "./policy.ts";

export function registerRuntimeCommands(program: Command): void {
  const runtime = program
    .command("runtime")
    .description("Control the independent approved-work runtime");
  runtime
    .command("verify <attempt>", { hidden: true })
    .requiredOption("--token <token>")
    .action(async (id: string, options: { token: string }) => {
      await runVerification(id, options.token);
    });
  runtime
    .command("start")
    .description("Start the configured runtime independently of this terminal")
    .action(async () => {
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
              live:
                supervisor !== undefined &&
                (await alive(supervisor.pid, supervisor.started)),
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
    .action(() => {
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
    .command("retry <attempt>")
    .description(
      "Resume one retained attempt after its prior host is confirmed gone",
    )
    .action(async (id: string) => {
      const store = new ExecutionStore();
      try {
        const record = store.attempt(id);
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
        if (await writerFence(record))
          throw new Error(
            "The prior host/verifier may still exist or lacks a complete launch receipt; retain its writer fence until positively reconciled",
          );
        const service = new ExecutionBeads(
          store.project(record.project).source,
        );
        if (record.bead === undefined || record.revision === undefined)
          throw new Error(
            "Inspect the uncertain claim by its recorded actor before retrying; no admitted task is confirmed",
          );
        await service.requireCurrent(record.bead, record.revision, record.id);
        store.change(id, (row) => {
          if (
            row.launchToken !== record.launchToken ||
            row.pid !== record.pid ||
            row.started !== record.started
          )
            throw new Error(
              "A prior host reported ownership during retry validation",
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
      await ensureRuntime();
    });
}
