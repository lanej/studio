import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { StudioProfile } from "../config.ts";
import { ExecutionPhase, executionSchema } from "../execution/store.ts";
import { TaskBrowser } from "../tasks/browser.ts";
import { readTaskEvidence } from "../tasks/evidence.ts";
import { taskLinks, taskNarrative, type TaskSnapshot } from "../tasks/model.ts";

const project = randomUUID();
const rejected = {
  id: "canonical-long-rejected-task",
  title: "Reject the unsafe result",
  status: "in_progress",
};
const successor = {
  id: "canonical-long-successor-task",
  title: "Wait for the prerequisite",
  status: "open",
  dependencies: [{ id: rejected.id, dependency_type: "blocks" }],
};
const attempt = executionSchema.parse({
  id: randomUUID(),
  project,
  profile: StudioProfile.Personal,
  phase: ExecutionPhase.Parked,
  bead: { ...rejected, revision: "1" },
  message: "Verifier rejected the result",
  verification: {
    summary: "Rejected",
    check: ["bun", "verify.mjs"],
    exitCode: 42,
    gitHead: "a".repeat(40),
    gitState: "clean",
    output: "CANARY_REJECTED",
  },
});
const snapshot: TaskSnapshot = {
  tasks: [rejected, successor],
  attempts: [attempt],
  observedAt: "12:34:56",
  focusable: new Set(),
  limitReached: false,
};

await test("task narratives preserve a rejected receipt without declaring its open successor runnable", () => {
  assert.match(
    taskNarrative(rejected, snapshot),
    /verifier exited 42.*retained this attempt for review/u,
  );
  assert.match(
    taskNarrative(successor, snapshot),
    /prerequisite has not been observed closed/u,
  );
  const unavailable = taskNarrative(successor, {
    ...snapshot,
    evidenceError: "database unavailable",
  });
  assert.match(unavailable, /evidence is unavailable/u);
  assert.doesNotMatch(unavailable, /No local attempt/u);
  assert.match(
    taskNarrative(rejected, {
      ...snapshot,
      attempts: [
        { ...attempt, phase: ExecutionPhase.Running, verification: undefined },
      ],
    }),
    /last recorded/u,
  );
  assert.deepEqual(taskLinks(rejected, snapshot.tasks).feeds, [successor.id]);
  assert.deepEqual(taskLinks(successor, snapshot.tasks).uses, [rejected.id]);
  const current = {
    ...attempt,
    id: randomUUID(),
    phase: ExecutionPhase.Running,
    verification: undefined,
  };
  assert.match(
    taskNarrative(
      { ...rejected, assignee: `pi:${attempt.id}` },
      { ...snapshot, attempts: [attempt, current] },
    ),
    /exited 42/u,
  );
  assert.match(
    taskNarrative(
      { id: "foreign", title: "External state", status: "custom_state" },
      snapshot,
    ),
    /custom_state/u,
  );
});

await test("evidence reads are project scoped, read only, and distinguish unavailable from absent", () => {
  const directory = mkdtempSync(join(tmpdir(), "studio-task-evidence-"));
  try {
    assert.deepEqual(readTaskEvidence(project, directory), { attempts: [] });
    assert.equal(existsSync(join(directory, "runtime.sqlite")), false);
    const db = new Database(join(directory, "runtime.sqlite"));
    db.run("CREATE TABLE records(kind TEXT,id TEXT,record TEXT)");
    for (const record of [
      attempt,
      { ...attempt, project: randomUUID(), id: randomUUID() },
    ])
      db.query("INSERT INTO records VALUES ('attempt',?,?)").run(
        record.id,
        JSON.stringify(record),
      );
    db.close();
    assert.deepEqual(
      readTaskEvidence(project, directory).attempts.map((item) => item.id),
      [attempt.id],
    );
    writeFileSync(join(directory, "runtime.sqlite"), "unreadable database");
    assert.match(
      readTaskEvidence(project, directory).evidenceError ?? "",
      /database/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("compact task browser keeps titles, hides identity, follows dependencies and returns to the selected row", async () => {
  const theme: Pick<Theme, "fg" | "bg" | "bold" | "getBgAnsi"> = {
    fg: (_color, value) => value,
    bg: (_color, value) => value,
    bold: (value) => value,
    getBgAnsi: () => "",
  };
  const browser = new TaskBrowser(
    snapshot,
    {
      label: "Canary",
      identity: project,
      load: () =>
        Promise.resolve({ ...snapshot, tasks: [...snapshot.tasks].reverse() }),
      show: (id) =>
        Promise.resolve(
          snapshot.tasks.find((task) => task.id === id) ?? rejected,
        ),
    },
    theme,
    () => 20,
    () => {},
    () => {},
  );
  const render = () => browser.render(60).map(stripAnsi).join("\n");
  assert.match(render(), /! Reject the unsafe result/u);
  assert.doesNotMatch(render(), /canonical-long|in_progress|Status:/u);
  browser.handleInput("j");
  render();
  browser.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(render(), /A prerequisite/u);
  browser.handleInput("\t");
  render();
  browser.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(render(), /verifier exited 42/u);
  browser.handleInput("\x1b");
  assert.match(render(), /› ! Reject the unsafe result/u);
  browser.handleInput("r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(render(), /› ! Reject the unsafe result/u);
  for (const [columns, rows] of [
    [80, 24],
    [60, 20],
  ]) {
    assert(columns !== undefined && rows !== undefined);
    const view = new TaskBrowser(
      snapshot,
      {
        label: "Canary",
        identity: project,
        load: () => Promise.resolve(snapshot),
        show: () => Promise.resolve(rejected),
      },
      theme,
      () => rows,
      () => {},
      () => {},
    ).render(columns);
    assert.equal(view.length, rows);
    for (const line of view)
      assert.equal(visibleWidth(line), columns, stripAnsi(line));
  }
});

await test("failed external links and late detail replies preserve the operator's selection", async () => {
  const theme: Pick<Theme, "fg" | "bg" | "bold" | "getBgAnsi"> = {
    fg: (_color, value) => value,
    bg: (_color, value) => value,
    bold: (value) => value,
    getBgAnsi: () => "",
  };
  const external = {
    ...rejected,
    dependencies: [{ id: "outside", dependency_type: "blocks" }],
  };
  const fail = new TaskBrowser(
    { ...snapshot, tasks: [external, successor] },
    {
      label: "Canary",
      identity: project,
      load: () => Promise.resolve(snapshot),
      show: () => Promise.reject(new Error("Dependency lookup unavailable")),
    },
    theme,
    () => 20,
    () => {},
    () => {},
    external.id,
  );
  const failedView = () => fail.render(60).map(stripAnsi).join("\n");
  failedView();
  fail.handleInput("\t");
  failedView();
  fail.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(failedView(), /Reject the unsafe result/u);
  assert.match(failedView(), /Dependency lookup unavailable/u);
  assert.doesNotMatch(failedView(), /No tasks in this source/u);
  fail.handleInput("\x1b");
  assert.match(failedView(), /› ! Reject the unsafe result/u);

  let release: ((task: typeof rejected) => void) | undefined;
  const pending = new Promise<typeof rejected>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const browser = new TaskBrowser(
    snapshot,
    {
      label: "Canary",
      identity: project,
      load: () => Promise.resolve(snapshot),
      show: (id) => {
        calls.push(id);
        return id === rejected.id ? pending : Promise.resolve(successor);
      },
    },
    theme,
    () => 20,
    () => {},
    () => {},
  );
  const view = () => browser.render(60).map(stripAnsi).join("\n");
  view();
  browser.handleInput("\r");
  browser.handleInput("\x1b");
  browser.handleInput("j");
  browser.handleInput("\r");
  assert.match(view(), /› ○ Wait for the prerequisite/u);
  assert.match(view(), /j\/k move/u);
  release?.(rejected);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [rejected.id]);
  assert.match(view(), /› ○ Wait for the prerequisite/u);
  browser.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [rejected.id, successor.id]);
  assert.match(view(), /j\/k scroll/u);
});
