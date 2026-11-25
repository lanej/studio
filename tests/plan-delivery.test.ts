import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { TaskBeads, beadSchema } from "../task-service.ts";
import { startTask } from "../task-run.ts";
import { StudioProfile } from "../config.ts";
import { expect, test } from "bun:test";
import {
  describePlan,
  draftSchema,
  planDigest,
  reviseDelivery,
} from "../lead-plan.ts";

test("delivery revisions change the approved draft and retain the explicit default", () => {
  const draft = draftSchema.parse({
    summary: "Mixed plan",
    tasks: [
      { key: "one", title: "One", description: "First", acceptance: "Done" },
      {
        key: "two",
        title: "Two",
        description: "Second",
        acceptance: "Done",
        delivery: "pull-request",
      },
    ],
  });
  expect(describePlan(draft)).toContain(
    "Local integration only — no PR (default)",
  );
  expect(describePlan(draft)).toContain("Opens a PR");
  const revised = reviseDelivery(draft, "one pull-request");
  expect(planDigest(revised)).not.toBe(planDigest(draft));
  expect(draft.tasks[0]?.delivery).toBeUndefined();
  expect(() => reviseDelivery(draft, "missing local")).toThrow();
  expect(() => reviseDelivery(draft, "one unknown")).toThrow();
});

test("new child delivery selects existing launch paths and rejects mismatches before effects", async () => {
  const projectId = randomUUID();
  const draft = draftSchema.parse({
    summary: "Approved",
    tasks: [
      {
        key: "one",
        title: "Child",
        description: "Bounded",
        acceptance: "Verified",
      },
    ],
  });
  const task = draft.tasks[0];
  assert.ok(task !== undefined);
  let metadata: Record<string, unknown> = {
    "pi.plan": "digest",
    "pi.plan_key": "one",
    "pi.plan_parent": "parent",
    "pi.plan_task": task,
  };
  let parentDigest = "digest";
  let linked = true;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const reply = (value: unknown) => {
      response.setHeader("Content-Type", "application/json");
      return response.end(JSON.stringify(value));
    };
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(`${request.method ?? "missing"} ${url.pathname}`);
    assert.equal(request.method, "GET");
    if (url.pathname.endsWith("/context"))
      return reply({
        project_id: projectId,
        backend: "dolt",
        dolt_mode: "server",
        capabilities: [
          "project.enforce",
          "issues.get",
          "issues.create",
          "issues.update",
        ],
      });
    if (url.pathname.endsWith("/dependencies"))
      return reply({
        items: linked
          ? [
              {
                issue_id: "child",
                depends_on_id: "parent",
                type: "parent-child",
              },
            ]
          : [],
        missing: [],
      });
    const parent = url.pathname.endsWith("/parent");
    return reply({
      id: parent ? "parent" : "child",
      title: "Child",
      status: "open",
      revision: "r1",
      metadata: parent ? { "pi.plan": parentDigest } : metadata,
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const directory = mkdtempSync(join(tmpdir(), "studio-delivery-start-"));
  const config = join(directory, "config.json");
  const state = join(directory, "state");
  const executed = join(directory, "unexpected-integration");
  const executable = join(directory, "integration");
  writeFileSync(
    executable,
    `#!/bin/sh\nprintf unexpected > '${executed}'\nexit 99\n`,
    { mode: 0o755 },
  );
  const priorConfig = process.env["STUDIO_CONFIG"];
  const priorState = process.env["STUDIO_STATE_DIR"];
  const source = { url: `http://127.0.0.1:${String(address.port)}`, projectId };
  writeFileSync(
    config,
    JSON.stringify({
      beadsService: source,
      integrations: {
        zellij: { enabled: true, executable },
        worktrees: { enabled: true, executable },
      },
    }),
  );
  process.env["STUDIO_CONFIG"] = config;
  process.env["STUDIO_STATE_DIR"] = state;
  try {
    const service = new TaskBeads(source);
    await service.requireDeliveryLaunch(await service.get("child"), false);
    await assert.rejects(
      startTask("child", StudioProfile.Personal, [], undefined, true),
      /local delivery.*--worker/u,
    );
    assert.equal(existsSync(state), false);
    metadata = {
      ...metadata,
      "pi.plan_task": { ...task, delivery: "pull-request" },
    };
    await service.requireDeliveryLaunch(await service.get("child"), true);
    await assert.rejects(
      startTask("child", StudioProfile.Personal, [], undefined, false),
      /PR delivery.*omit --worker/u,
    );
    assert.equal(existsSync(state), false);
    metadata = { ...metadata, "pi.plan_key": "another" };
    await assert.rejects(
      startTask("child", StudioProfile.Personal, [], undefined, true),
      /malformed or mismatched/u,
    );
    metadata = { ...metadata, "pi.plan_key": "one" };
    parentDigest = "another";
    await assert.rejects(
      startTask("child", StudioProfile.Personal, [], undefined, true),
      /does not match its parent/u,
    );
    parentDigest = "digest";
    linked = false;
    await assert.rejects(
      startTask("child", StudioProfile.Personal, [], undefined, true),
      /does not match its parent/u,
    );
    assert.equal(existsSync(state), false);
    await service.requireDeliveryLaunch(
      beadSchema.parse({
        id: "legacy",
        title: "Legacy",
        status: "open",
        revision: "r1",
      }),
      false,
    );
    assert.ok(requests.every((request) => request.startsWith("GET ")));
    assert.equal(existsSync(executed), false);
  } finally {
    if (priorConfig === undefined) delete process.env["STUDIO_CONFIG"];
    else process.env["STUDIO_CONFIG"] = priorConfig;
    if (priorState === undefined) delete process.env["STUDIO_STATE_DIR"];
    else process.env["STUDIO_STATE_DIR"] = priorState;
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    rmSync(directory, { recursive: true, force: true });
  }
});
