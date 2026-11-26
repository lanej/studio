import assert from "node:assert/strict";
import { test } from "node:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { retryAttempt } from "../execution/cli.ts";
import { processStart } from "../process.ts";
import { retainedConflicts } from "../execution/supervisor.ts";
import { Database } from "bun:sqlite";
import {
  initTheme,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import {
  Container,
  Input,
  isKeyRelease,
  ProcessTerminal,
  type Component,
  TuiMainScreen,
  type OverlayHandle,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { attemptSchema, Phase } from "../attempts.ts";
import type { Task } from "../beads.ts";
import { StudioProfile } from "../config.ts";
import {
  ExecutionPhase,
  ExecutionStore,
  projectSchema,
  VerificationPhase,
  executionSchema,
  type Execution,
} from "../execution/store.ts";
import { retryWriterFence } from "../execution/recovery.ts";
import { paneKeybindingsSchema } from "../pane-keybindings-config.ts";
import { TaskBrowser } from "../tasks/browser.ts";
import { TaskPanel } from "../tasks/panel.ts";
import { readTaskEvidence } from "../tasks/evidence.ts";
import {
  parkedDetails,
  needsAttention,
  retainedEvidence,
  taskLinks,
  taskNarrative,
  taskDelivery,
  type TaskSnapshot,
} from "../tasks/model.ts";

const project = randomUUID();
const attemptId = randomUUID();
const rejected = {
  id: "canonical-long-rejected-task",
  title: "Reject the unsafe result",
  status: "in_progress",
  assignee: `pi:${attemptId}`,
};
const successor = {
  id: "canonical-long-successor-task",
  title: "Wait for the prerequisite",
  status: "open",
  dependencies: [{ id: rejected.id, dependency_type: "blocks" }],
};
const attempt = executionSchema.parse({
  id: attemptId,
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

await test("retry retains a settled host fence when its process identity is incomplete", async () => {
  assert.equal(
    await retryWriterFence({
      ...attempt,
      launchSettled: true,
      pid: 123,
      started: undefined,
    }),
    true,
  );
  assert.equal(
    await retryWriterFence({
      ...attempt,
      launchSettled: true,
      pid: undefined,
      started: "unknown",
    }),
    true,
  );
  assert.equal(
    await retryWriterFence({
      ...attempt,
      launchSettled: true,
      verifier: { phase: VerificationPhase.Running },
    }),
    true,
  );
});

await test("retry revalidates admission, live writers, remote authority and the same attempt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "studio-retry-guard-"));
  const beforeState = process.env["STUDIO_STATE_DIR"];
  const beforeConfig = process.env["STUDIO_CONFIG"];
  process.env["STUDIO_STATE_DIR"] = directory;
  process.env["STUDIO_CONFIG"] = join(directory, "config.json");
  writeFileSync(process.env["STUDIO_CONFIG"], "{}");
  const store = new ExecutionStore();
  const id = randomUUID();
  const admitted = executionSchema.parse({
    ...attempt,
    id,
    launchSettled: true,
    revision: "accepted",
    bead: {
      ...attempt.bead,
      assignee: `pi:${id}`,
      revision: "accepted",
      metadata: { "pi.attempt": id },
    },
  });
  assert(admitted.bead !== undefined);
  let remote = admitted.bead;
  let race = () => {};
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/v0/beads/context")
      response.end(
        JSON.stringify({
          project_id: project,
          backend: "dolt",
          dolt_mode: "server",
          capabilities: [
            "project.enforce",
            "issues.get",
            "issues.create",
            "issues.update",
          ],
        }),
      );
    else {
      race();
      response.end(JSON.stringify(remote));
    }
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address !== null && typeof address !== "string");
    const enrolled = projectSchema.parse({
      id: project,
      root: directory,
      source: {
        url: `http://127.0.0.1:${String(address.port)}`,
        projectId: project,
      },
      profile: "personal",
      base: "main",
      beadsWorkspace: directory,
      beadsDatabase: "fixture",
    });
    store.enroll(enrolled);
    store.saveAttempt({
      ...admitted,
      interactive: { session: "owned-fixture", socket: "owned-server", tab: 0 },
    });
    await assert.rejects(retryAttempt(id), /original pane binding/u);
    assert.equal(store.attempt(id).phase, ExecutionPhase.Parked);
    store.saveAttempt({ ...admitted, bead: undefined });
    await assert.rejects(retryAttempt(id), /no admitted task/u);
    store.saveAttempt({
      ...admitted,
      pid: process.pid,
      started: await processStart(process.pid),
    });
    await assert.rejects(retryAttempt(id), /prior host\/verifier/u);
    store.saveAttempt({
      ...admitted,
      verifier: { phase: VerificationPhase.Running },
    });
    await assert.rejects(retryAttempt(id), /prior host\/verifier/u);
    store.saveAttempt(admitted);
    remote = { ...admitted.bead, assignee: "pi:someone-else" };
    await assert.rejects(retryAttempt(id), /revision or owner changed/u);
    remote = { ...admitted.bead, revision: "changed" };
    await assert.rejects(retryAttempt(id), /revision or owner changed/u);
    remote = admitted.bead;
    race = () => {
      store.change(id, (row) => {
        row.owns = ["new-scope"];
      });
    };
    await assert.rejects(retryAttempt(id), /attempt or project changed/u);
    assert.equal(store.attempt(id).phase, ExecutionPhase.Parked);
    store.saveAttempt(admitted);
    race = () => {
      store.enroll({ ...enrolled, merge: !enrolled.merge });
    };
    await assert.rejects(retryAttempt(id), /attempt or project changed/u);
    assert.equal(store.attempt(id).phase, ExecutionPhase.Parked);
    race = () => {};
    store.enroll(enrolled);
    store.saveAttempt(admitted);
    await assert.rejects(
      retryAttempt(id),
      /queued, but the runtime did not start.*disabled/u,
    );
    assert.equal(store.attempt(id).phase, ExecutionPhase.Queued);
    assert.equal(store.attempts().length, 1);
    assert.equal(store.attempt(id).verification?.exitCode, 42);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    store.close();
    if (beforeState === undefined) delete process.env["STUDIO_STATE_DIR"];
    else process.env["STUDIO_STATE_DIR"] = beforeState;
    if (beforeConfig === undefined) delete process.env["STUDIO_CONFIG"];
    else process.env["STUDIO_CONFIG"] = beforeConfig;
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("retained conflicts match admitted queue order, project and ownership fences", () => {
  const queued = {
    ...attempt,
    id: randomUUID(),
    phase: ExecutionPhase.Queued,
    owns: ["src/core"],
  };
  const earlier = { ...queued, id: randomUUID(), owns: ["src/core/file.ts"] };
  const later = { ...earlier, id: randomUUID() };
  const empty = { ...earlier, id: randomUUID(), bead: undefined };
  const foreign = { ...earlier, id: randomUUID(), project: randomUUID() };
  const done = { ...earlier, id: randomUUID(), phase: ExecutionPhase.Complete };
  assert.deepEqual(
    retainedConflicts(queued, [
      empty,
      foreign,
      done,
      earlier,
      queued,
      later,
    ]).map((row) => row.id),
    [earlier.id],
  );
  assert.deepEqual(
    retainedConflicts(queued, [
      queued,
      { ...later, phase: ExecutionPhase.Parked, owns: [] },
    ]).map((row) => row.id),
    [later.id],
  );
});

await test("parked details use the current owner and scheduler path rules", () => {
  assert(attempt.bead !== undefined);
  const owned = { ...attempt, owns: ["src/core"] };
  const first = {
    ...attempt,
    id: randomUUID(),
    phase: ExecutionPhase.Queued,
    owns: ["src/core/file.ts"],
    bead: { ...attempt.bead, id: "first", title: "First" },
  };
  const second = {
    ...first,
    id: randomUUID(),
    owns: [],
    bead: { ...first.bead, id: "second", title: "Second" },
  };
  const foreign = {
    ...first,
    id: randomUUID(),
    project: randomUUID(),
    bead: { ...first.bead, title: "Foreign" },
  };
  const task = { ...rejected, assignee: `pi:${owned.id}` };
  const view = { ...snapshot, attempts: [owned, first, second, foreign] };
  const details = parkedDetails(task, view) ?? "";
  assert.match(details, /Verification failed.*42/u);
  assert.match(details, /Last evidenced step: verification exited 42/u);
  assert.match(details, /First: src\/core \/ src\/core\/file.ts/u);
  assert.match(details, /Second: ownership unspecified/u);
  assert.doesNotMatch(details, /Foreign/u);
  assert.equal(
    parkedDetails({ ...task, assignee: "someone-else" }, view),
    undefined,
  );
  assert.match(
    parkedDetails(task, {
      ...view,
      attempts: [
        { ...owned, phase: ExecutionPhase.Uncertain, verification: undefined },
      ],
    }) ?? "",
    /Uncertain execution.*\nLast completed step: unknown/u,
  );
  assert.match(
    parkedDetails(task, {
      ...view,
      attempts: [{ ...owned, reviewFinding: "Fix the API" }],
    }) ?? "",
    /Reviewer requested changes: Fix the API/u,
  );
});

await test("retained diff snapshots refresh with same-attempt evidence and clear on failed retry", async () => {
  const task = { ...rejected, assignee: `pi:${attempt.id}` };
  const current = {
    ...attempt,
    revision: "1",
    base: "a".repeat(40),
    checkout: {
      primary: "/fixture",
      root: "/fixture/.worktrees",
      path: "/fixture/.worktrees/one",
      task_id: "one",
      owner_id: "owner",
      agent: "agent",
      branch: "task/one",
      created_at: "now",
      base_ref: "main",
    },
  };
  const view = { ...snapshot, tasks: [task], attempts: [current] };
  const theme: Pick<Theme, "fg" | "bg" | "bold" | "getBgAnsi"> = {
    fg: (_color, value) => value,
    bg: (_color, value) => value,
    bold: (value) => value,
    getBgAnsi: () => "",
  };
  let retried = "";
  let loaded = view;
  let output = "OLD_DIFF";
  let diffReads = 0;
  const diffState: { pending?: Promise<string> } = {};
  let retryFails = true;
  const browser = new TaskBrowser(
    view,
    {
      label: "Fixture",
      identity: project,
      load: () => Promise.resolve(loaded),
      show: () => Promise.resolve(task),
      diff: () => {
        diffReads++;
        return diffState.pending ?? Promise.resolve(output);
      },
      retry: (id) => {
        retried = id;
        return retryFails
          ? Promise.reject(new Error("RETRY_UNCERTAIN"))
          : Promise.resolve();
      },
    },
    theme,
    () => 24,
    () => {},
    () => {},
    task.id,
  );
  const render = () => browser.render(120).map(stripAnsi).join("\n");
  render();
  browser.handleInput("\t");
  assert.match(render(), /› ↗ Open retained diff/u);
  browser.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(render(), /OLD_DIFF/u);
  assert.match(render(), /Captured diff snapshot/u);
  assert.match(render(), /Re-open retained diff to refresh/u);
  assert(current.verification !== undefined);
  loaded = {
    ...view,
    attempts: [
      {
        ...current,
        message: "NEW_FAILURE",
        verification: {
          ...current.verification,
          summary: "New failed check",
          exitCode: 43,
          output: "NEW_FAILURE",
        },
      },
    ],
  };
  await browser.refresh();
  assert.match(render(), /NEW_FAILURE/u);
  assert.doesNotMatch(render(), /OLD_DIFF/u);
  output = "NEW_DIFF";
  // The focused diff action survives refresh; opening it reads the current checkout again.
  browser.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(render(), /NEW_DIFF/u);
  assert.equal(diffReads, 2);
  output = "MANUAL_CHECKOUT_EDIT";
  await browser.refresh();
  assert.match(render(), /NEW_DIFF/u);
  assert.doesNotMatch(render(), /MANUAL_CHECKOUT_EDIT/u);
  browser.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(render(), /MANUAL_CHECKOUT_EDIT/u);
  assert.equal(diffReads, 3);
  const beforeRemoval = loaded;
  loaded = { ...loaded, attempts: [] };
  await browser.refresh();
  assert.doesNotMatch(render(), /MANUAL_CHECKOUT_EDIT/u);
  loaded = beforeRemoval;
  await browser.refresh();
  assert.doesNotMatch(render(), /MANUAL_CHECKOUT_EDIT/u);
  browser.handleInput("\t");
  render();
  browser.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(render(), /MANUAL_CHECKOUT_EDIT/u);
  assert.equal(diffReads, 4);
  browser.handleInput("\t");
  render();
  browser.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(retried, attempt.id);
  assert.match(render(), /RETRY_UNCERTAIN/u);
  assert.doesNotMatch(render(), /MANUAL_CHECKOUT_EDIT/u);
  retryFails = false;
  browser.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(render(), /Retry queued/u);
  assert.doesNotMatch(render(), /MANUAL_CHECKOUT_EDIT/u);
  let release: ((value: string) => void) | undefined;
  diffState.pending = new Promise<string>((resolve) => {
    release = resolve;
  });
  browser.handleInput("\x1b[Z");
  assert.match(render(), /› ↗ Open retained diff/u);
  browser.handleInput("\r");
  render();
  browser.handleInput("\t");
  assert.match(render(), /› ↗ Retry attempt/u);
  browser.handleInput("\r");
  assert(release !== undefined);
  release("LATE_OLD_DIFF");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.doesNotMatch(render(), /LATE_OLD_DIFF/u);
});

await test("narrow and wide inspectors explain missing evidence and block unsafe recovery", () => {
  const task = { ...rejected, assignee: `pi:${attempt.id}` };
  const view = {
    ...snapshot,
    tasks: [task],
    attempts: [{ ...attempt, verification: undefined }],
    retryBlocked: new Map([[attempt.id, "writer identity is uncertain"]]),
  };
  const theme: Pick<Theme, "fg" | "bg" | "bold" | "getBgAnsi"> = {
    fg: (_color, value) => value,
    bg: (_color, value) => value,
    bold: (value) => value,
    getBgAnsi: () => "",
  };
  for (const width of [60, 80]) {
    const browser = new TaskBrowser(
      view,
      {
        label: "Fixture",
        identity: project,
        load: () => Promise.resolve(view),
        show: () => Promise.resolve(task),
        retry: () => Promise.resolve(),
      },
      theme,
      () => 100,
      () => {},
      () => {},
      task.id,
    );
    const screen = browser.render(width).map(stripAnsi).join("\n");
    assert.match(screen, /Verification evidence unavailable/u);
    assert.match(screen, /Retained diff unavailable/u);
    assert.match(screen, /Retry unavailable: writer identity/u);
    assert.match(screen, /uncertain/u);
    assert.doesNotMatch(screen, /Retry attempt \(guards checked/u);
    const interactiveView = new TaskBrowser(
      {
        ...view,
        retryBlocked: new Map(),
        attempts: [
          {
            ...view.attempts[0],
            ...attempt,
            interactive: {
              session: "retained",
              socket: "owned-server",
              tab: 0,
            },
            verification: undefined,
          },
        ],
      },
      {
        label: "Fixture",
        identity: project,
        load: () => Promise.resolve(view),
        show: () => Promise.resolve(task),
        retry: () => Promise.resolve(),
      },
      theme,
      () => 100,
      () => {},
      () => {},
      task.id,
    )
      .render(width)
      .map(stripAnsi)
      .join("\n");
    assert.match(interactiveView, /original pane binding/u);
    assert.doesNotMatch(interactiveView, /Retry attempt \(guards checked/u);
  }
});

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

await test("historical failures remain inspectable without attributing absent or different ownership", () => {
  for (const assignee of [undefined, "pi:someone-else", `pi:${attempt.id}`]) {
    const task = { ...rejected, assignee };
    const current = assignee === `pi:${attempt.id}`;
    const narrative = taskNarrative(task, snapshot);
    assert.equal(needsAttention(task, snapshot), current);
    assert.equal(parkedDetails(task, snapshot) !== undefined, current);
    assert.match(retainedEvidence(task, snapshot), /CANARY_REJECTED/u);
    if (current) {
      assert.doesNotMatch(narrative, /Historical/u);
      assert.match(retainedEvidence(task, snapshot), /Current owner-matched/u);
    } else {
      assert.match(narrative, /Historical/u);
      assert.match(narrative, /Beads currently reports “in_progress”/u);
      assert.match(
        narrative,
        assignee === undefined
          ? /no explicit current owner/u
          : /different owner/u,
      );
      assert.match(
        retainedEvidence(task, snapshot),
        /Historical\/unattributed receipt/u,
      );
    }
  }
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
  browser.handleInput("\x1b[D");
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
  assert.match(failedView(), /Dependency lookup unavailable/u);
  assert.doesNotMatch(failedView(), /No tasks in this source/u);
  fail.handleInput("\x1b[D");
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
  browser.handleInput("\x1b[D");
  browser.handleInput("j");
  assert.match(view(), /› ○ Wait for the prerequisite/u);
  assert.match(view(), /↑↓ move/u);
  release?.(rejected);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [rejected.id]);
  assert.match(view(), /› ○ Wait for the prerequisite/u);
  browser.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [rejected.id, successor.id]);
  assert.match(view(), /↑↓ scroll/u);
});

await test("live refresh preserves the focused task and Escape closes the floating browser", async () => {
  const theme: Pick<Theme, "fg" | "bg" | "bold" | "getBgAnsi"> = {
    fg: (_color, value) => value,
    bg: (_color, value) => value,
    bold: (value) => value,
    getBgAnsi: () => "",
  };
  let closed = false;
  let reads = 0;
  let release: ((value: TaskSnapshot) => void) | undefined;
  const loaded = new Promise<TaskSnapshot>((resolve) => {
    release = resolve;
  });
  const shown: string[] = [];
  const browser = new TaskBrowser(
    snapshot,
    {
      label: "Canary",
      identity: project,
      load: () => {
        reads++;
        return loaded;
      },
      show: (id) => {
        shown.push(id);
        return Promise.resolve(successor);
      },
    },
    theme,
    () => 13,
    () => {},
    () => {
      closed = true;
    },
  );
  const view = () => browser.render(60).map(stripAnsi).join("\n");
  assert.match(view(), /Enter inspect/u);
  browser.handleInput("j");
  assert.match(view(), /› ○ Wait for the prerequisite/u);
  const refresh = browser.refresh();
  await browser.refresh();
  assert.equal(reads, 1, "background refreshes must not overlap");
  browser.handleInput("\r");
  release?.({
    ...snapshot,
    tasks: [successor, { ...rejected, status: "closed" }],
  });
  await refresh;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    shown,
    [successor.id],
    "inspection requested during refresh must run afterwards",
  );
  browser.handleInput("\t");
  view();
  browser.handleInput("j");
  const before = view().split("\n").slice(2, -3);
  await browser.refresh();
  assert.deepEqual(
    view().split("\n").slice(2, -3),
    before,
    "refresh must preserve inspector scroll and disclosure selection",
  );
  browser.handleInput("\x1b[D");
  assert.match(view(), /› ○ Wait for the prerequisite/u);
  browser.handleInput("\x1b");
  assert.equal(closed, true);
  browser.dispose();
  await browser.refresh();
  assert.equal(reads, 2, "disposed panels must not read again");
});

await test("the worker answer drawer owns focus above the lead draft and restores its inspector", async () => {
  class TestTui extends TuiMainScreen {
    override requestRender(): void {}
    paintedRows() {
      return this.resolveFakeCursors(this.render(68));
    }
  }
  const terminal = new ProcessTerminal();
  terminal.hideCursor = () => {};
  const tui = new TestTui(terminal);
  const lead = new Input();
  lead.handleInput("unsent");
  lead.handleInput("\x1b[D");
  const aboveEditor = new Container();
  tui.addChild(aboveEditor);
  tui.addChild(lead);
  tui.setFocus(lead);
  const messages: string[] = [];
  let earlyInput:
    | Parameters<ExtensionContext["ui"]["onTerminalInput"]>[0]
    | undefined;
  initTheme("dark", false);
  const theme = getThemeByName("dark");
  assert.ok(theme !== undefined);
  const custom: ExtensionContext["ui"]["custom"] = (factory, options) =>
    new Promise((resolve, reject) => {
      let handle: OverlayHandle | undefined;
      let closed = false;
      void Promise.resolve(
        factory(tui, theme, new KeybindingsManager(), (result) => {
          closed = true;
          handle?.hide();
          resolve(result);
        }),
      ).then((component) => {
        if (closed) return;
        handle = tui.showOverlay(component);
        options?.onHandle?.(handle);
      }, reject);
    });
  let widget: (Component & { dispose?(): void }) | undefined;
  const setWidget: ExtensionContext["ui"]["setWidget"] = (
    _key,
    content,
    options,
  ) => {
    widget?.dispose?.();
    aboveEditor.clear();
    widget = undefined;
    if (content === undefined) return;
    assert.equal(options?.placement, "aboveEditor");
    assert.ok(typeof content === "function");
    widget = content(tui, theme);
    aboveEditor.addChild(widget);
  };
  const ctx = {
    hasUI: true,
    ui: {
      custom,
      setWidget,
      notify: (message: string) => {
        messages.push(message);
      },
      onTerminalInput: (guard: NonNullable<typeof earlyInput>) => {
        earlyInput = guard;
        return () => {
          earlyInput = undefined;
        };
      },
    },
  };
  const send = (key: string) => {
    if (earlyInput?.(key)?.consume !== true && !isKeyRelease(key))
      tui.getFocusedComponent()?.handleInput?.(key);
  };
  const view = () => tui.getFocusedComponent()?.render(68).join("\n") ?? "";
  const panel = new TaskPanel();
  let rejectRead: ((error: Error) => void) | undefined;
  const source = {
    label: "Canary",
    identity: project,
    load: () =>
      new Promise<TaskSnapshot>((_resolve, reject) => {
        rejectRead = reject;
      }),
    show: () => Promise.resolve(rejected),
    focusPane: () => Promise.resolve(),
  };
  const parent = panel.open(ctx, () =>
    Promise.resolve({
      ...source,
      load: () => Promise.resolve(snapshot),
    }),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const inspector = tui.getFocusedComponent();
  assert.ok(inspector !== null && inspector !== lead);
  const reply = panel.editAnswer(
    ctx,
    "Which behavior should the worker use?",
    "Restore graph focus",
  );
  assert.equal(tui.getFocusedComponent(), aboveEditor.children[0]);
  const drawer = view().split("\n").map(stripAnsi).join("\n");
  assert.match(drawer, /Worker question.*Restore graph focus/u);
  assert.match(drawer, /Which behavior should the worker use/u);
  assert.equal(tui.hasOverlay(), false);
  tui.setShowHardwareCursor(false);
  const painted = tui.paintedRows();
  assert.equal(painted.filter((row) => row.includes("\x1b[7m")).length, 1);
  assert.ok(painted.some((row) => row.includes("unsent")));
  tui.setShowHardwareCursor(true);
  assert.ok(tui.paintedRows().every((row) => !row.includes("\x1b[7m")));
  tui.setShowHardwareCursor(false);
  // The action key and the first word can arrive in a single terminal read.
  send("q");
  send("\x1b[113;1:3u"); // Kitty key release
  send("uit");
  assert.equal(lead.getValue(), "unsent");
  await Promise.resolve();
  assert.equal(earlyInput, undefined);
  send("\r");
  assert.equal(await reply, "quit");
  assert.equal(tui.getFocusedComponent(), inspector);
  const quickCancel = panel.editAnswer(ctx, "Still needed?");
  send("edit me");
  const replyField = aboveEditor.children[0];
  assert.ok(replyField !== undefined);
  tui.setFocus(lead);
  const replyRows = replyField.render(68).map(stripAnsi);
  const y = replyRows.findIndex((row) => row.includes("edit me"));
  const x = replyRows[y]?.indexOf(" me");
  assert.ok(x !== undefined && x >= 0);
  const click = replyField.handleMouse?.({
    type: "click",
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width: 68,
    height: 12,
    shift: false,
    alt: false,
    ctrl: false,
  });
  assert.equal(click?.focus, true);
  tui.setFocus(replyField);
  send(",");
  assert.match(view(), /edit,/u);
  send("\x1b");
  assert.equal(await quickCancel, undefined);
  assert.equal(earlyInput, undefined);
  assert.equal(tui.getFocusedComponent(), inspector);
  const interrupted = panel.editAnswer(ctx, "Waiting for your reply.");
  send("unsubmitted");
  panel.close();
  assert.equal(aboveEditor.children.length, 0);
  assert.equal(tui.getFocusedComponent(), lead);
  assert.ok(tui.paintedRows().some((row) => row.includes("\x1b[7mt\x1b[27m")));
  assert.equal(await interrupted, undefined);
  await parent;
  assert.equal(tui.getFocusedComponent(), lead);
  assert.equal(aboveEditor.children.length, 0);
  const opened = panel.open(ctx, () => Promise.resolve(source));
  send("j"); // The opening command and another key arrive in one terminal read.
  assert.equal(lead.getValue(), "unsent");
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.match(view(), /Loading/u);
  send("\r");
  send("j");
  send("\x1b");
  await opened;
  assert.equal(tui.getFocusedComponent(), lead);
  assert.equal(lead.getValue(), "unsent");
  rejectRead?.(new Error("Old session disconnected"));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(tui.getFocusedComponent(), lead);
  assert.deepEqual(messages, []);
  const bindings = paneKeybindingsSchema.parse({
    pane: { close: [] },
    tasks: { quit: "x" },
  });
  const earlyClose = panel.open(
    ctx,
    () => Promise.resolve(source),
    undefined,
    bindings,
  );
  send("x");
  await earlyClose;
  assert.equal(tui.getFocusedComponent(), lead);
  const remapped = panel.open(
    ctx,
    () => Promise.resolve(source),
    undefined,
    bindings,
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.match(view(), /Loading… +x close/u);
  for (const key of ["q", "\x1b", "\x03"]) send(key);
  assert.match(view(), /Loading/u);
  send("x");
  await remapped;
  assert.equal(tui.getFocusedComponent(), lead);
  await panel.open(ctx, () =>
    Promise.reject(new Error("Current service unavailable")),
  );
  assert.deepEqual(messages, ["Current service unavailable"]);
  send("!");
  assert.equal(lead.getValue(), "unsen!t");
});

await test("automatic refresh revalidates an explicitly inspected task outside a bounded listing", async () => {
  const shown: string[] = [];
  const theme: Pick<Theme, "fg" | "bg" | "bold" | "getBgAnsi"> = {
    fg: (_color, value) => value,
    bg: (_color, value) => value,
    bold: (value) => value,
    getBgAnsi: () => "",
  };
  const browser = new TaskBrowser(
    { ...snapshot, limitReached: true },
    {
      label: "Canary",
      identity: project,
      load: () =>
        Promise.resolve({ ...snapshot, tasks: [rejected], limitReached: true }),
      show: (id) => {
        shown.push(id);
        return Promise.resolve({ ...successor, status: "closed" });
      },
    },
    theme,
    () => 20,
    () => {},
    () => {},
    successor.id,
  );
  browser.render(60);
  await browser.refresh();
  assert.deepEqual(shown, [successor.id]);
  assert.match(
    browser.render(60).map(stripAnsi).join("\n"),
    /Wait for the prerequisite/u,
  );
  browser.handleInput("\x1b[D");
  assert.match(
    browser.render(60).map(stripAnsi).join("\n"),
    /› ● Wait for the prerequisite/u,
  );
});

await test("a list projection does not erase expanded task details during refresh", async () => {
  const detail = {
    ...rejected,
    description: "Retain the complete accepted brief",
  };
  const theme: Pick<Theme, "fg" | "bg" | "bold" | "getBgAnsi"> = {
    fg: (_color, value) => value,
    bg: (_color, value) => value,
    bold: (value) => value,
    getBgAnsi: () => "",
  };
  const browser = new TaskBrowser(
    { ...snapshot, tasks: [detail] },
    {
      label: "Canary",
      identity: project,
      load: () => Promise.resolve({ ...snapshot, tasks: [rejected] }),
      show: () => Promise.resolve(detail),
    },
    theme,
    () => 24,
    () => {},
    () => {},
    detail.id,
  );
  const view = () => browser.render(60).map(stripAnsi).join("\n");
  view();
  browser.handleInput("\t");
  view();
  browser.handleInput("\r");
  assert.match(view(), /Retain the complete accepted brief/u);
  await browser.refresh();
  assert.match(view(), /Retain the complete accepted brief/u);
  assert.doesNotMatch(view(), /No description recorded/u);
});

function deliveryText(task: Task, data: TaskSnapshot): string {
  const display = taskDelivery(task, data);
  return [display.label, ...display.details].join(" ");
}

await test("delivery distinguishes approved intent from bound publication and historical receipts", () => {
  const metadata = (delivery?: "local" | "pull-request") => ({
    "studio.approval": "reviewed-digest",
    "studio.task": {
      key: "first",
      title: "First",
      description: "Do work",
      acceptance: "Verified",
      delivery,
    },
  });
  // Delivery intent starts unassigned; owner-bound cases below opt in explicitly.
  const localTask = { ...rejected, assignee: undefined, metadata: metadata() };
  assert.ok(attempt.bead !== undefined);
  const local = {
    ...attempt,
    bead: { ...attempt.bead, metadata: metadata() },
    integration: "a".repeat(40),
  };
  const view = (task: Task, row: Execution = local) =>
    deliveryText(task, { ...snapshot, tasks: [task], attempts: [row] });
  const interactive = {
    ...localTask,
    parent: "parent",
    metadata: {
      "pi.plan": "digest",
      "pi.plan_key": "first",
      "pi.plan_parent": "parent",
      "pi.plan_task": metadata()["studio.task"],
    },
  };
  assert.match(view(interactive), /PR not expected/u);
  assert.match(view({ ...interactive, parent: "another" }), /Unknown.*parent/u);
  assert.match(
    view({
      ...interactive,
      metadata: { ...interactive.metadata, "pi.plan_key": "different" },
    }),
    /Unknown/u,
  );
  assert.match(
    view(localTask),
    /PR not expected.*Local result reference unavailable/su,
  );
  assert.match(
    view({ ...localTask, assignee: `pi:${local.id}` }),
    /Local result · a{40}/u,
  );
  const published = {
    ...local,
    bead: { ...local.bead, metadata: metadata("pull-request") },
    pr: "tracked-pr",
    url: "https://github.com/example/repo/pull/7",
    phase: ExecutionPhase.Delivery,
  };
  const prTask = {
    ...localTask,
    metadata: metadata("pull-request"),
    assignee: `pi:${published.id}`,
  };
  assert.equal(
    taskDelivery(prTask, { ...snapshot, attempts: [published] }).url,
    published.url,
  );
  assert.equal(
    taskDelivery(prTask, {
      ...snapshot,
      attempts: [{ ...published, pr: undefined }],
    }).url,
    undefined,
  );
  assert.match(
    view(prTask, published),
    /PR published.*https:\/\/github.com\/example\/repo\/pull\/7/u,
  );
  assert.match(
    view(prTask, {
      ...published,
      pr: undefined,
      publication: "pending-request",
    }),
    /not yet published.*pending-request.*awaiting confirmation/su,
  );
  assert.match(
    view(prTask, { ...published, pr: undefined, phase: ExecutionPhase.Parked }),
    /Blocked.*No confirmed PR link/su,
  );
  const completed = { ...published, phase: ExecutionPhase.Complete };
  const closed = {
    ...prTask,
    status: "closed",
    assignee: undefined,
    metadata: { ...prTask.metadata, "studio.completed": completed.id },
  };
  assert.match(view(closed, completed), /PR published/u);
  assert.match(
    view(
      { ...closed, status: "open", assignee: `pi:${randomUUID()}` },
      completed,
    ),
    /Unknown/u,
  );
  assert.match(view({ ...closed, status: "open" }, completed), /Unknown/u);
  assert.match(
    view(closed, { ...completed, phase: ExecutionPhase.Parked }),
    /Unknown/u,
  );
  assert.match(
    view({ ...prTask, assignee: `pi:${randomUUID()}` }, published),
    /Unknown.*current owner/u,
  );
  assert.match(view({ ...prTask, metadata: undefined }, published), /Unknown/u);
  assert.match(
    view(
      {
        ...prTask,
        metadata: {
          "studio.approval": "reviewed-digest",
          "studio.task": { key: "first" },
        },
      },
      published,
    ),
    /Unknown/u,
  );
  assert.match(
    view({ ...prTask, metadata: metadata("local") }, published),
    /Unknown/u,
  );
  assert.match(
    view(
      {
        ...prTask,
        metadata: { ...prTask.metadata, "studio.approval": "changed" },
      },
      published,
    ),
    /Unknown.*differs/u,
  );
  assert.match(
    view({ ...prTask, metadata: metadata(), assignee: undefined }, published),
    /PR not expected/u,
  );
  assert.doesNotMatch(
    view({ ...prTask, metadata: metadata(), assignee: undefined }, published),
    /PR published/u,
  );
  assert.match(
    deliveryText(prTask, { ...snapshot, evidenceError: "unreadable" }),
    /Unknown.*unavailable/u,
  );
  assert.match(
    deliveryText({ ...rejected, assignee: undefined }, snapshot),
    /Unknown.*not recorded/u,
  );
  assert.match(
    deliveryText(rejected, snapshot),
    /Unknown.*evidence differs or is unavailable/u,
  );
});

await test("interactive delivery uses readonly scoped receipts and exact current approval binding", () => {
  const directory = mkdtempSync(join(tmpdir(), "studio-interactive-evidence-"));
  const id = randomUUID();
  const metadata = {
    "pi.plan": "approved",
    "pi.plan_key": "child",
    "pi.plan_parent": "parent",
    "pi.plan_task": {
      key: "child",
      title: "Child",
      description: "Bounded",
      acceptance: "Verified",
      delivery: "pull-request",
    },
  };
  const task: Task = {
    id: "child",
    title: "Child",
    status: "in_progress",
    parent: "parent",
    assignee: `pi:${id}`,
    metadata,
  };
  const receipt = attemptSchema.parse({
    id,
    source: { url: "http://localhost:1", projectId: project },
    bead: { ...task, revision: "1" },
    revision: "1",
    check: [],
    profile: "personal",
    model: { provider: "openai-codex", model: "gpt-6.1-sol", reasoning: "off" },
    live: false,
    processStarted: null,
    reservation: {
      primary: "/tmp/project",
      root: "/tmp/checkouts",
      holder: id,
      agent: "pi",
      branch: "task",
      baseRef: "main",
      baseCommit: "a".repeat(40),
      attempted: false,
    },
    checkout: null,
    session: "fixture",
    pane: null,
    pid: null,
    transcript: null,
    phase: Phase.Running,
    verification: null,
    message: "",
    delivery: {
      requestId: "request",
      requestDigest: "digest",
      head: "a".repeat(40),
      octoSubmission: "pending",
    },
  });
  const text = (value: Task, view: TaskSnapshot): string => {
    const result = taskDelivery(value, view);
    return [result.label, ...result.details].join("\n");
  };
  try {
    assert.deepEqual(readTaskEvidence(project, directory), { attempts: [] });
    assert.equal(existsSync(join(directory, "attempts.sqlite")), false);
    const db = new Database(join(directory, "attempts.sqlite"));
    db.run("CREATE TABLE attempts(project TEXT,bead TEXT,record TEXT)");
    const insert = db.query("INSERT INTO attempts VALUES (?,?,?)");
    insert.run(project, task.id, JSON.stringify(receipt));
    insert.run(randomUUID(), task.id, "malformed unrelated receipt");
    const before = readFileSync(join(directory, "attempts.sqlite"));
    const observed = { ...snapshot, ...readTaskEvidence(project, directory) };
    assert.deepEqual(readFileSync(join(directory, "attempts.sqlite")), before);
    assert.equal(observed.interactiveAttempts?.length, 1);
    assert.match(
      text(task, observed),
      /PR not yet published.*Publication request/su,
    );
    const published = attemptSchema.parse({
      ...receipt,
      delivery: {
        ...receipt.delivery,
        pr: "tracked-pr",
        url: "https://github.com/example/studio/pull/7",
      },
    });
    const view = { ...observed, interactiveAttempts: [published] };
    assert.match(
      text(task, {
        ...observed,
        interactiveAttempts: [
          attemptSchema.parse({
            ...receipt,
            delivery: {
              ...receipt.delivery,
              url: "https://github.com/example/studio/pull/7",
            },
          }),
        ],
      }),
      /PR not yet published/u,
    );
    assert.match(
      text(task, {
        ...observed,
        interactiveAttempts: [
          { ...receipt, bead: { ...receipt.bead, metadata: {} } },
        ],
      }),
      /Unknown.*unavailable/su,
    );
    assert.equal(
      taskDelivery(task, view).url,
      "https://github.com/example/studio/pull/7",
    );
    assert.match(
      text(task, { ...view, evidenceError: "runtime unavailable" }),
      /PR published/u,
    );
    assert.match(
      text(task, { ...view, interactiveEvidenceError: "corrupt" }),
      /Unknown.*Interactive evidence unavailable/su,
    );
    assert.match(
      text({ ...task, assignee: `pi:${randomUUID()}` }, view),
      /Unknown.*current owner/su,
    );
    assert.match(
      text({ ...task, parent: "different" }, view),
      /Unknown.*parent/su,
    );
    assert.match(
      text({ ...task, metadata: { ...metadata, "pi.plan": "changed" } }, view),
      /Unknown.*differs/su,
    );
    assert.match(
      text(
        { ...task, metadata: { ...metadata, "pi.plan_key": "wrong" } },
        view,
      ),
      /Unknown/su,
    );
    assert.match(text({ ...task, metadata: {} }, view), /Unknown/su);
    const verification = {
      summary: "Verified",
      check: [],
      exitCode: 0,
      gitHead: "a".repeat(40),
      gitState: "clean",
      output: "passed",
    };
    const finished = { ...published, phase: Phase.Closed, verification };
    const completed = {
      ...task,
      assignee: "",
      status: "closed",
      metadata: {
        ...metadata,
        "pi.result_attempt": id,
        "pi.result": verification,
      },
    };
    assert.match(
      text(completed, { ...view, interactiveAttempts: [finished] }),
      /PR published/u,
    );
    assert.match(
      text(
        { ...completed, status: "open" },
        { ...view, interactiveAttempts: [finished] },
      ),
      /Unknown/su,
    );
    assert.match(
      text(
        { ...completed, assignee: `pi:${randomUUID()}` },
        { ...view, interactiveAttempts: [finished] },
      ),
      /Unknown/su,
    );
    assert.match(
      text(
        {
          ...completed,
          metadata: {
            ...completed.metadata,
            "pi.result": { ...verification, output: "different" },
          },
        },
        { ...view, interactiveAttempts: [finished] },
      ),
      /Unknown/su,
    );
    const localMetadata = {
      ...metadata,
      "pi.plan_task": { ...metadata["pi.plan_task"], delivery: "local" },
    };
    const local = {
      ...receipt,
      bead: { ...receipt.bead, metadata: localMetadata },
    };
    assert.match(
      text(
        { ...task, metadata: localMetadata },
        { ...view, interactiveAttempts: [local] },
      ),
      /PR not expected.*Local result reference unavailable/su,
    );
    assert.match(
      text(task, {
        ...observed,
        interactiveAttempts: [
          { ...receipt, phase: Phase.CheckFailed, message: "Checks failed" },
        ],
      }),
      /Blocked.*Checks failed/su,
    );
    db.run("UPDATE attempts SET record='malformed' WHERE project=?", [project]);
    assert.match(
      readTaskEvidence(project, directory).interactiveEvidenceError ?? "",
      /JSON/u,
    );
    db.run("DELETE FROM attempts WHERE project=?", [project]);
    insert.run(
      project,
      task.id,
      JSON.stringify({
        ...receipt,
        source: { ...receipt.source, projectId: randomUUID() },
      }),
    );
    assert.match(
      readTaskEvidence(project, directory).interactiveEvidenceError ?? "",
      /project differs/u,
    );
    db.run("DELETE FROM attempts WHERE project=?", [project]);
    insert.run(project, "wrong-child", JSON.stringify(receipt));
    assert.match(
      readTaskEvidence(project, directory).interactiveEvidenceError ?? "",
      /task differs/u,
    );
    db.run("DELETE FROM attempts WHERE project=?", [project]);
    insert.run(
      project,
      task.id,
      JSON.stringify({
        ...receipt,
        delivery: { ...receipt.delivery, url: "https://example.com/not-a-pr" },
      }),
    );
    assert.match(
      readTaskEvidence(project, directory).interactiveEvidenceError ?? "",
      /url/u,
    );
    db.close();
    assert.equal(existsSync(join(directory, "attempts.sqlite-journal")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("completed no-command receipts are distinct from unconfirmed verifier exits and review approval", () => {
  assert.ok(attempt.verification !== undefined);
  const noCommand = {
    ...attempt,
    check: [],
    verifier: { phase: VerificationPhase.Complete },
    verification: { ...attempt.verification, check: [], exitCode: null },
    review: undefined,
  };
  const display = (row: Execution) => {
    const view = { ...snapshot, attempts: [row] };
    return `${parkedDetails(rejected, view) ?? ""}\n${taskNarrative(rejected, view)}`;
  };
  const details = display(noCommand);
  assert.match(details, /no executable check was agreed/iu);
  assert.match(details, /acceptance relies on independent review/iu);
  assert.doesNotMatch(
    details,
    /Verification failed|no confirmed exit|verification passed/u,
  );
  for (const row of [
    { ...noCommand, verifier: undefined },
    { ...noCommand, verifier: { phase: VerificationPhase.Running } },
    { ...noCommand, check: ["verify"] },
    {
      ...noCommand,
      verification: { ...noCommand.verification, check: ["verify"] },
    },
  ]) {
    assert.match(display(row), /Verification failed or did not complete/u);
    assert.doesNotMatch(display(row), /no executable check was agreed/iu);
  }
  assert.match(
    display({ ...noCommand, reviewFinding: "Repair criterion" }),
    /Reviewer requested changes: Repair criterion/u,
  );
});
