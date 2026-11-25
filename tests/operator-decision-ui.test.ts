import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  ExecutionPhase,
  ExecutionStore,
  executionSchema,
  pendingDecision,
} from "../execution/store.ts";
import { StudioProfile } from "../config.ts";
import { TaskBrowser } from "../tasks/browser.ts";
import {
  decisionDetails,
  taskNarrative,
  type TaskSnapshot,
} from "../tasks/model.ts";
import { recordDecision } from "../execution/decisions.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const theme: Pick<Theme, "fg" | "bg" | "bold" | "getBgAnsi"> = {
  fg: (_tone, value) => value,
  bg: (_tone, value) => value,
  bold: (value) => value,
  getBgAnsi: () => "",
};
await test("only explicit owned decisions offer Answer and capture the original request across a dialog refresh", async () => {
  const directory = await mkdtemp(join(tmpdir(), "decision-ui-"));
  const store = new ExecutionStore(directory);
  try {
    const id = randomUUID(),
      project = randomUUID();
    const task = {
      id: "task",
      title: "Operator decision task",
      status: "in_progress",
      assignee: `pi:${id}`,
    };
    const attempt = executionSchema.parse({
      id,
      project,
      profile: StudioProfile.Personal,
      phase: ExecutionPhase.Running,
      message: "working",
      launchToken: randomUUID(),
      launchSettled: true,
      revision: "r",
      bead: { ...task, revision: "r" },
    });
    store.saveAttempt(attempt);
    recordDecision(store, id, "Which accepted marker?");
    const waiting = store.attempt(id),
      request = pendingDecision(waiting);
    assert.ok(request !== undefined);
    let snapshot: TaskSnapshot = {
      tasks: [task],
      attempts: [waiting],
      observedAt: "native",
      focusable: new Set(),
      limitReached: false,
    };
    assert.match(
      decisionDetails(task, snapshot) ?? "",
      /Which accepted marker/u,
    );
    assert.match(
      taskNarrative(task, snapshot),
      /awaiting an explicit operator decision/u,
    );
    assert.equal(
      decisionDetails(task, {
        ...snapshot,
        attempts: [
          {
            ...attempt,
            phase: ExecutionPhase.Parked,
            message: "operator decision maybe",
          },
        ],
      }),
      undefined,
    );
    const calls: { id: string; request: string; question: string }[] = [];
    let release: (() => void) | undefined;
    const dialog = new Promise<void>((resolve) => {
      release = resolve;
    });
    const browser = new TaskBrowser(
      snapshot,
      {
        label: "Fixture",
        identity: project,
        load: () => Promise.resolve(snapshot),
        show: () => Promise.resolve(task),
        answer: async (id, request, question) => {
          calls.push({ id, request, question });
          await dialog;
          throw new Error("This decision request is stale; refresh");
        },
      },
      theme,
      () => 40,
      () => {},
      () => {},
      task.id,
    );
    let selected = false;
    for (let i = 0; i < 16; i++) {
      browser.render(100);
      browser.handleInput("\t");
      if (
        browser.render(100).join("\n").includes("› ↗ Answer operator decision")
      ) {
        selected = true;
        break;
      }
    }
    assert.ok(selected);
    const text = browser.render(100).join("\n");
    assert.match(text, /including other ready work/u);
    assert.doesNotMatch(text, /Retry attempt/u);
    browser.handleInput("\r");
    await Promise.resolve();
    assert.deepEqual(calls, [
      { id, request: request.id, question: request.question },
    ]);
    snapshot = {
      ...snapshot,
      attempts: [
        {
          ...waiting,
          operatorDecisions: [
            { ...request, id: randomUUID(), question: "Changed question" },
          ],
        },
      ],
    };
    release?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.length, 1);
    assert.match(browser.render(100).join("\n"), /stale/u);
    for (const state of [
      { ...snapshot, answerBlocked: new Map([[id, "writer is uncertain"]]) },
      { ...snapshot, tasks: [{ ...task, assignee: "another-owner" }] },
    ]) {
      const view = new TaskBrowser(
        state,
        {
          label: "Fixture",
          identity: project,
          load: () => Promise.resolve(state),
          show: () => Promise.resolve(task),
          answer: () => Promise.resolve(true),
        },
        theme,
        () => 40,
        () => {},
        () => {},
        task.id,
      );
      assert.doesNotMatch(
        view.render(100).join("\n"),
        /↗ Answer operator decision/u,
      );
      view.dispose();
    }
    browser.dispose();
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
