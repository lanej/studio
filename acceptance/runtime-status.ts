import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { BeadsError } from "@lanej/task-runtime/beads";
import { z } from "zod";
import { ExecutionBeads } from "../execution/beads.ts";
import { ExecutionStore, executionSchema, ExecutionPhase } from "../execution/store.ts";
import type { NativeBeads } from "./beads-fixture.ts";
import type { BeadsHttpSource } from "./beads-http-fixture.ts";

export async function checkRuntimeStatus(fixture: NativeBeads, source: BeadsHttpSource): Promise<void> {
  const state = join(fixture.directory, "status-state");
  const config = join(fixture.directory, "status-config.json");
  const project = {
    root: fixture.workspace,
    source,
    base: "main",
    beadsWorkspace: fixture.workspace,
    beadsDatabase: "fixture",
  };
  await writeFile(config, JSON.stringify({ runtime: { projects: [project] } }));
  const title = "Publish the operator handbook";
  const created = await fixture.command([
    "create",
    "--title",
    title,
    "--type",
    "task",
    "--priority",
    "2",
    "--description",
    "Publish the reviewed handbook in the agreed window.",
    "--acceptance",
    "The index links to the new handbook.",
    "--json",
  ]);
  assert.equal(created.code, 0, created.stderr);
  const { id } = z.object({ id: z.string() }).parse(JSON.parse(created.stdout));
  const service = new ExecutionBeads(source);
  const retained = await service.get(id);
  const attempt = randomUUID();
  const store = new ExecutionStore(state);
  try {
    store.enroll({
      ...project,
      id: source.projectId,
      merge: false,
      beadsExecutable: "bd",
      verificationReadPaths: [],
    });
    store.saveAttempt(
      executionSchema.parse({
        id: attempt,
        project: source.projectId,
        phase: ExecutionPhase.Complete,
        bead: retained,
        message: "Previous Studio run settled",
        summary: "Handbook draft validated",
        verification: {
          summary: "Handbook links checked",
          check: ["bun", "test"],
          gitHead: "fixture-head",
          gitState: "clean",
          exitCode: 0,
          output: "",
        },
        publication: "fixture-publication",
        mergeReceipt: JSON.stringify({ state: "requested" }),
        sessions: ["/retained/worker.jsonl"],
      }),
    );
  } finally {
    store.close();
  }
  const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
  const env = {
    ...process.env,
    STUDIO_CONFIG: config,
    STUDIO_STATE_DIR: state,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  };
  const operator = (action: string, target: string, ...flags: string[]) =>
    Bun.spawnSync([process.execPath, cli, "runtime", "bead", action, source.projectId, target, ...flags], {
      env,
      stderr: "pipe",
    });
  const wrong = operator("delete", id, "--confirm", "other-id");
  assert.equal(wrong.exitCode, 1);
  assert.match(wrong.stderr.toString(), /exact bead ID/u);
  const database = new Database(join(state, "runtime.sqlite"));
  try {
    database.run("UPDATE records SET record=json_set(record, '$.claimLabel', ?) WHERE kind='project' AND id=?", [
      "legacy-scope",
      source.projectId,
    ]);
    const retainedStatus = Bun.spawnSync([process.execPath, cli, "runtime", "status", "--json"], { env });
    assert.equal(retainedStatus.exitCode, 0, retainedStatus.stderr.toString());
    const refused = operator("delete", id, "--confirm", id);
    assert.equal(refused.exitCode, 1);
    assert.match(refused.stderr.toString(), /retained claim label/u);
    assert.equal((await service.get(id)).revision, retained.revision);
    database.run("UPDATE records SET record=json_remove(record, '$.claimLabel') WHERE kind='project' AND id=?", [
      source.projectId,
    ]);
  } finally {
    database.close();
  }

  let output = "";
  let transcript = "";
  const artifacts = process.env["STUDIO_ACCEPTANCE_OUTPUT"];
  const decoder = new TextDecoder();
  const child = Bun.spawn([process.execPath, cli, "runtime", "status"], {
    env,
    terminal: {
      cols: 100,
      rows: 26,
      data(_terminal, data) {
        const text = decoder.decode(data, { stream: true });
        output += text;
        if (artifacts !== undefined) transcript += text;
      },
    },
  });
  const terminal = child.terminal;
  assert(terminal !== undefined);
  const see = async (expected: string) => {
    const deadline = Date.now() + 10_000;
    while (!stripTerminalSequences(output).includes(expected) && Date.now() < deadline && child.exitCode === null)
      await Bun.sleep(20);
    assert(
      stripTerminalSequences(output).includes(expected),
      `Missing ${expected} in PTY output:\n${output.slice(-4000)}`,
    );
  };
  const send = (value: string) => {
    output = "";
    terminal.write(value);
  };
  const capture = async (name: string) => {
    if (artifacts === undefined) return;
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, `${name}.ansi`), transcript);
  };
  try {
    await see("Completed");
    send("\r");
    await see(id);
    await capture("runtime-dashboard");
    send("j\r");
    await see("Status matrix");
    await see(`${id} · ${title}`);
    await see("Live record");
    await see("Retained attempt");
    await see("Acceptance criteria");
    await see("[e] Edit");
    await see("[c] Close");
    await see("[d] Delete");
    assert(output.includes("\x1b[48;2;13;21;19m"), "Sage Midnight surface");
    assert(output.includes("\x1b[38;2;140;197;204mLive record"), "Live record uses Sage info");
    assert(output.includes("\x1b[38;2;196;178;217mP2"), "P2 uses Sage numeric emphasis");
    assert(output.includes("\x1b[38;2;221;167;131mUnassigned"), "Unassigned uses Sage attention");
    assert(output.includes("\x1b[38;2;144;159;149mNone pending"), "Idle decisions use Sage off");
    assert(output.includes("\x1b[38;2;166;205;130mAvailable"), "Available actions use Sage success");
    await capture("runtime-task");
    output = "";
    terminal.resize(58, 26);
    await see("State / evidence");
    await see("Retained attempt");
    await see("Esc back");
    await see("The index links to the new handbook.");
    assert.doesNotMatch(stripTerminalSequences(output), /Unassigned\s*·/u);
    await capture("runtime-task-narrow");
    output = "";
    terminal.resize(100, 26);
    await see("Acceptance criteria");
    send("e");
    await see("Edit bead");
    await see("Ctrl+S save");
    await capture("runtime-edit");
    send(" draft");
    send("\x1b");
    await see("Status matrix");
    assert.equal((await service.get(id)).title, title);
    send("e");
    await see("Edit bead");
    send("\x15\x13");
    await see("Enter a nonempty title on one line");
    send(`${title} revised\t\rRetain the publication receipt.\t\rRecord the link check.\t\x15P1\x13`);
    await see("updated in Beads");
    const edited = await service.get(id);
    assert.equal(edited.title, `${title} revised`);
    assert.equal(
      edited.description,
      "Publish the reviewed handbook in the agreed window.\nRetain the publication receipt.",
    );
    assert.equal(edited.acceptance_criteria, "The index links to the new handbook.\nRecord the link check.");
    assert.equal(edited["priority"], 1);
    send("e");
    await see("Edit bead");
    send(" unsaved");
    await see("unsaved");
    const concurrent = await fixture.command(["update", id, "--priority", "0"]);
    assert.equal(concurrent.code, 0, concurrent.stderr);
    send("\x13");
    await see("authority changed");
    assert.equal((await service.get(id)).title, edited.title);
    send(" more");
    await see("unsaved more");
    send("\x1b");
    await see("Status matrix");
    send("r");
    await see("Live record");
    send("\t");
    await see("Execution matrix");
    await see("No PID recorded");
    await see("Execution identity");
    await see(attempt);
    await capture("runtime-execution");
    send("\t");
    await see("Evidence matrix");
    await see("Passed");
    await see("Exit 0");
    await see("Record retained");
    await see("/retained/worker.jsonl");
    await capture("runtime-evidence-matrix");
    send("c");
    await see("Close bead");
    const changed = await fixture.command(["update", id, "--description", "Changed after the preview loaded"]);
    assert.equal(changed.code, 0, changed.stderr);
    send("Superseded by the published handbook\r");
    await see("authority changed");
    assert.equal((await service.get(id)).status, "open");
    send("\tr");
    await see("Changed after the preview loaded");
    send("c");
    await see("Close bead");
    send("Superseded by the published handbook\r");
    await see("closed in Beads");
    assert.equal((await service.get(id))["close_reason"], "Superseded by the published handbook");
    const dependent = await fixture.command([
      "create",
      "--title",
      "Publish the handbook index",
      "--type",
      "task",
      "--json",
    ]);
    assert.equal(dependent.code, 0, dependent.stderr);
    const dependentId = z.object({ id: z.string() }).parse(JSON.parse(dependent.stdout)).id;
    const linked = await fixture.command(["dep", "add", dependentId, id]);
    assert.equal(linked.code, 0, linked.stderr);
    send("r");
    await see("Live record");
    send("d");
    await see("Delete bead");
    await capture("runtime-delete");
    send("wrong-id\r");
    await see("Enter the exact bead ID");
    assert.equal((await service.get(id)).status, "closed");
    send("\x1b");
    await see("Tab sections");
    send("d");
    await see("Delete bead");
    send(`${id}\r`);
    await see("Beads HTTP 400");
    assert.equal((await service.get(id)).status, "closed");
    const unlinked = await fixture.command(["dep", "remove", dependentId, id]);
    assert.equal(unlinked.code, 0, unlinked.stderr);
    send("r");
    await see("Live record");
    send("d");
    await see("Delete bead");
    send(`${id}\r`);
    await see("deleted in Beads");
    await assert.rejects(service.get(id), (cause) => cause instanceof BeadsError && cause.status === 404);
    send("\x1b");
    await see("Studio runtime");
    send("q");
    assert.equal(await Promise.race([child.exited, Bun.sleep(5000).then(() => undefined)]), 0);
    const close = operator("close", dependentId, "--reason", "Index published");
    assert.equal(close.exitCode, 0, close.stderr.toString());
    assert.equal((await service.get(dependentId))["close_reason"], "Index published");
    const deleted = operator("delete", dependentId, "--confirm", dependentId);
    assert.equal(deleted.exitCode, 0, deleted.stderr.toString());
    await assert.rejects(service.get(dependentId), (cause) => cause instanceof BeadsError && cause.status === 404);
    const history = new ExecutionStore(state, true);
    try {
      assert.equal(history.attempt(attempt).bead?.id, id);
    } finally {
      history.close();
    }
  } finally {
    if (child.exitCode === null) child.kill();
    terminal.close();
    await child.exited;
  }
}
