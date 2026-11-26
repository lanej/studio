import { basename } from "node:path";
import { z } from "zod";
import {
  BeadsReader,
  knownTaskStatus,
  TaskStatus,
  taskSchema,
} from "../beads.ts";
import type { StudioConfig } from "../config.ts";
import { retryAttempt } from "../execution/cli.ts";
import { answerDecision } from "../execution/decisions.ts";
import { safeGit } from "../execution/git.ts";
import { hasInteractivePane } from "../execution/interactive-target.ts";
import { retryWriterFence } from "../execution/recovery.ts";
import {
  ExecutionPhase,
  pendingDecision,
  type Execution,
} from "../execution/store.ts";
import { focusTaskPane, taskPaneBeads } from "../task-run.ts";
import { TaskBeads } from "../task-service.ts";
import { readTaskEvidence } from "./evidence.ts";
import type { PanelSource } from "./panel.ts";

export function createTaskPanelSource(
  config: Pick<StudioConfig, "beads" | "beadsService" | "runtime">,
  {
    authority,
    cwd,
    editAnswer,
  }: {
    authority: StudioConfig["beadsService"];
    cwd: string;
    editAnswer: (
      question: string,
      taskTitle: string,
    ) => Promise<string | undefined>;
  },
): PanelSource | undefined {
  const source = authority ?? config.beadsService;
  const service = source === undefined ? undefined : new TaskBeads(source);
  const reader =
    service !== undefined
      ? {
          list: async () =>
            z.array(taskSchema).parse((await service.list()).items),
          show: async (id: string) => taskSchema.parse(await service.get(id)),
        }
      : config.beads === undefined
        ? undefined
        : new BeadsReader(config.beads);
  if (reader === undefined) return;
  const projectId = source?.projectId;
  const project = config.runtime.projects.find(
    (item) =>
      item.source.projectId === projectId && item.source.url === source?.url,
  );
  return {
    focusPane: async (id, attemptId, signal) => {
      if (source !== undefined)
        await focusTaskPane(source, id, attemptId, signal);
    },
    label:
      project === undefined
        ? source === undefined
          ? basename(config.beads?.workspace ?? cwd)
          : "Beads"
        : basename(project.root),
    identity: projectId ?? config.beads?.database ?? "",
    emptyHint: "Tasks added in Beads will appear here.",
    show: (id) => reader.show(id),
    ...(project === undefined
      ? {}
      : {
          retry: retryAttempt,
          answer: async (
            id: string,
            request: string,
            question: string,
            taskTitle: string,
          ) => {
            const text = await editAnswer(question, taskTitle);
            if (text === undefined) return false;
            await answerDecision(id, request, text);
            return true;
          },
          diff: async (attempt: Execution) => {
            if (attempt.checkout === undefined || attempt.base === undefined)
              throw new Error(
                "Retained checkout or base receipt is unavailable.",
              );
            const diff = await safeGit(project.root, attempt.checkout.path, [
              "diff",
              "--no-ext-diff",
              "--no-textconv",
              attempt.base,
              "--",
            ]);
            return `${diff}\nTracked diff only; untracked files are not included.`;
          },
        }),
    load: async () => {
      const tasks = await reader.list();
      const evidence = readTaskEvidence(projectId);
      const retryBlocked = new Map<string, string>();
      const answerBlocked = new Map<string, string>();
      for (const attempt of evidence.attempts) {
        if (pendingDecision(attempt) === undefined) continue;
        if (
          attempt.phase !== ExecutionPhase.AwaitingDecision ||
          attempt.interactive !== undefined ||
          attempt.bead === undefined ||
          attempt.revision === undefined
        )
          answerBlocked.set(
            attempt.id,
            "the admitted request is not in a settled background decision wait",
          );
        else
          try {
            if (await retryWriterFence(attempt))
              answerBlocked.set(
                attempt.id,
                "the prior host/verifier is live or uncertain; wait for positive settlement",
              );
          } catch {
            answerBlocked.set(
              attempt.id,
              "writer state could not be confirmed",
            );
          }
      }
      for (const attempt of evidence.attempts) {
        if (
          attempt.phase !== ExecutionPhase.Parked &&
          attempt.phase !== ExecutionPhase.Uncertain
        )
          continue;
        if (attempt.interactive !== undefined) {
          retryBlocked.set(
            attempt.id,
            "interactive attempts retain their original pane binding; inspect the transcript and checkout. Automatic replacement is unavailable.",
          );
          continue;
        }
        try {
          if (await retryWriterFence(attempt))
            retryBlocked.set(
              attempt.id,
              "the prior writer may still exist or its launch receipt is incomplete; reconcile it first.",
            );
        } catch {
          retryBlocked.set(
            attempt.id,
            "writer state could not be confirmed; inspect the retained execution.",
          );
        }
      }
      const live =
        projectId === undefined
          ? new Set<string>()
          : await taskPaneBeads(projectId);
      return {
        tasks,
        ...evidence,
        retryBlocked,
        answerBlocked,
        observedAt: new Date().toLocaleTimeString(),
        focusable: new Set(
          tasks
            .filter(
              (task) =>
                knownTaskStatus(task.status) === TaskStatus.InProgress &&
                (live.has(task.id) ||
                  evidence.attempts.some(
                    (attempt) =>
                      attempt.bead?.id === task.id &&
                      attempt.bead.assignee === task.assignee &&
                      hasInteractivePane(attempt),
                  )),
            )
            .map((task) => task.id),
        ),
        limitReached: tasks.length === 1000,
      };
    },
  };
}
