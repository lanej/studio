import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Command } from "commander";
import { runtimeProjectSchema } from "../config.ts";
import { approveManualMerge, registerRuntimeCommands } from "../execution/cli.ts";
import { ExecutionPhase, ExecutionStore, executionSchema, type Execution } from "../execution/store.ts";
import { beadSchema } from "../task-service.ts";

const head = "a".repeat(40);
const changedHead = "b".repeat(40);

async function manualDelivery(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "studio-manual-merge-")));
  const config = join(root, "config.json");
  const previousState = process.env["STUDIO_STATE_DIR"];
  const previousConfig = process.env["STUDIO_CONFIG"];
  process.env["STUDIO_STATE_DIR"] = root;
  process.env["STUDIO_CONFIG"] = config;
  const store = new ExecutionStore();
  const projectId = randomUUID();
  const id = randomUUID();
  const bead = beadSchema.parse({
    id: "bd-publish",
    title: "Publish the accepted change",
    status: "in_progress",
    assignee: `pi:${id}`,
    revision: "accepted",
    metadata: { "pi.attempt": id, "studio.pullRequestMerge": "manual" },
  });
  const service = { current: bead, onRead() {} };
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method ?? ""} ${request.url ?? ""}`);
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/v0/beads/context") {
      response.end(
        JSON.stringify({
          project_id: projectId,
          backend: "dolt",
          dolt_mode: "server",
          capabilities: ["project.enforce", "issues.get", "issues.create", "issues.update"],
        }),
      );
    } else if (request.method === "GET" && request.url === "/v0/beads/issues/bd-publish") {
      service.onRead();
      response.end(JSON.stringify(service.current));
    } else {
      response.writeHead(405);
      response.end();
    }
  });
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    store.close();
    if (previousState === undefined) delete process.env["STUDIO_STATE_DIR"];
    else process.env["STUDIO_STATE_DIR"] = previousState;
    if (previousConfig === undefined) delete process.env["STUDIO_CONFIG"];
    else process.env["STUDIO_CONFIG"] = previousConfig;
    rmSync(root, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  const project = runtimeProjectSchema.parse({
    root,
    source: { url: `http://127.0.0.1:${String(address.port)}`, projectId },
    base: "main",
    beadsWorkspace: root,
    beadsDatabase: "fixture",
  });
  const settings = {
    runtime: { enabled: true, projects: [project] },
    integrations: { octo: { enabled: true, executable: process.execPath } },
  };
  writeFileSync(config, JSON.stringify(settings));
  store.enroll({ ...project, id: projectId });
  const delivery = executionSchema.parse({
    id,
    project: projectId,
    profile: "personal",
    phase: ExecutionPhase.Delivery,
    revision: bead.revision,
    bead,
    head,
    review: "Reviewed this head",
    readyNotice: { id: randomUUID(), head },
    publication: randomUUID(),
    pr: randomUUID(),
    agent: randomUUID(),
    url: "https://github.com/example/project/pull/3",
    message: "Waiting for explicit merge approval",
  });
  store.saveAttempt(delivery);
  return {
    config,
    settings,
    store,
    id,
    bead,
    service,
    delivery,
    requests,
    project,
  };
}

await test("manual consent records the ready PR and head once despite an unrelated heartbeat", async (t) => {
  const f = await manualDelivery(t);
  f.service.onRead = () => {
    f.store.change(f.id, (row) => {
      row.heartbeatAt += 1;
      row.message = "Still waiting";
    });
  };
  const cli = new Command();
  registerRuntimeCommands(cli);
  await cli.parseAsync(["runtime", "approve-merge", f.id, "--head", head], {
    from: "user",
  });
  const approved = f.store.attempt(f.id);
  const receipt = approved.manualMergeApproval;
  assert.ok(receipt !== undefined);
  assert.equal(receipt.head, head);
  assert.equal(receipt.notice, f.delivery.readyNotice?.id);
  assert.equal(receipt.pr, f.delivery.pr);
  assert.equal(receipt.agent, f.delivery.agent);
  assert.ok(receipt.actor.length > 0);
  assert.ok(Number.isFinite(Date.parse(receipt.at)));
  assert.ok(approved.heartbeatAt > 0);
  assert.equal(approved.mergeReceipt, undefined);
  assert.equal(approved.phase, ExecutionPhase.Delivery);
  assert.ok(f.requests.includes("GET /v0/beads/issues/bd-publish"));
  await approveManualMerge(f.id, head);
  assert.deepEqual(f.store.attempt(f.id).manualMergeApproval, receipt);
  assert.ok(f.requests.every((request) => request.startsWith("GET ")));
});

await test("manual consent requires a published PR with current readiness and independent review", async (t) => {
  const f = await manualDelivery(t);
  const invalid: Partial<Execution>[] = [
    { phase: ExecutionPhase.Running },
    { head: changedHead },
    { readyNotice: undefined },
    { readyNotice: { id: randomUUID(), head: changedHead } },
    { review: undefined },
    { review: " " },
    { reviewFinding: "The revised head needs another review" },
    {
      mergeReceipt: JSON.stringify({
        state: "requested",
        head: changedHead,
        notice: randomUUID(),
      }),
    },
    { pr: undefined },
    { agent: undefined },
    { publication: undefined },
    { url: undefined },
    {
      bead: {
        ...f.bead,
        metadata: {
          ...f.bead.metadata,
          "studio.pullRequestMerge": "project-policy",
        },
      },
    },
  ];
  for (const changes of invalid) {
    f.store.saveAttempt({ ...f.delivery, ...changes });
    await assert.rejects(approveManualMerge(f.id, head));
    assert.equal(f.store.attempt(f.id).manualMergeApproval, undefined);
  }
});

await test("manual consent requires the same writable configured project and current Beads owner", async (t) => {
  const f = await manualDelivery(t);
  const invalid = [
    { ...f.settings, runtime: { ...f.settings.runtime, enabled: false } },
    { ...f.settings, integrations: { octo: { enabled: false } } },
    { ...f.settings, runtime: { enabled: true, projects: [] } },
    ...[
      {
        ...f.project,
        source: { ...f.project.source, url: "http://127.0.0.1:1" },
      },
      { ...f.project, source: { ...f.project.source, reviewOnly: true } },
      { ...f.project, root: tmpdir() },
    ].map((project) => ({
      ...f.settings,
      runtime: { enabled: true, projects: [project] },
    })),
  ];
  for (const settings of invalid) {
    writeFileSync(f.config, JSON.stringify(settings));
    await assert.rejects(approveManualMerge(f.id, head));
    assert.equal(f.store.attempt(f.id).manualMergeApproval, undefined);
  }
  writeFileSync(f.config, JSON.stringify(f.settings));
  for (const changed of [
    { ...f.bead, assignee: "pi:another" },
    { ...f.bead, revision: "newer" },
    { ...f.bead, metadata: { ...f.bead.metadata, "pi.attempt": randomUUID() } },
    {
      ...f.bead,
      metadata: {
        ...f.bead.metadata,
        "studio.pullRequestMerge": "project-policy",
      },
    },
  ]) {
    f.service.current = changed;
    await assert.rejects(approveManualMerge(f.id, head));
    assert.equal(f.store.attempt(f.id).manualMergeApproval, undefined);
  }
});

await test("manual consent rechecks the attempt and project after the remote read", async (t) => {
  const f = await manualDelivery(t);
  for (const changes of [
    { phase: ExecutionPhase.Parked },
    { head: changedHead },
    { pr: randomUUID() },
    { readyNotice: { id: randomUUID(), head } },
    { bead: { ...f.bead, assignee: "pi:another" } },
  ]) {
    f.store.saveAttempt(f.delivery);
    f.service.onRead = () => {
      f.store.saveAttempt({ ...f.delivery, ...changes });
    };
    await assert.rejects(approveManualMerge(f.id, head));
    assert.equal(f.store.attempt(f.id).manualMergeApproval, undefined);
  }
  f.store.saveAttempt(f.delivery);
  f.service.onRead = () => {
    writeFileSync(
      f.config,
      JSON.stringify({
        ...f.settings,
        runtime: { enabled: false, projects: [f.project] },
      }),
    );
  };
  await assert.rejects(approveManualMerge(f.id, head));
  assert.equal(f.store.attempt(f.id).manualMergeApproval, undefined);
});
