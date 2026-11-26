import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { ExecutionBeads, requireUnattendedTask } from "../execution/beads.ts";
import { retainClaim, reconcileAttempt } from "../execution/recovery.ts";
import { ExecutionStore, ExecutionPhase, executionSchema } from "../execution/store.ts";
import { beadSchema, owner } from "../task-service.ts";
import { StudioProfile, runtimeProjectSchema } from "../config.ts";

await test("unattended admission skips interactive children before claim and fences retained claims", async () => {
  const projectId = randomUUID();
  const id = randomUUID();
  const interactive = beadSchema.parse({
    id: "interactive",
    title: "Interactive PR",
    status: "open",
    revision: "1",
    metadata: { "pi.plan_task": null },
  });
  const ordinary = beadSchema.parse({
    id: "ordinary",
    title: "Legacy ready work",
    status: "open",
    revision: "1",
  });
  const last = beadSchema.parse({ ...ordinary, id: "last" });
  let rows = [interactive, ordinary, last];
  let race = false;
  let competing = false;
  let truncated = false;
  const writes: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const reply = (value: unknown, status = 200) => {
        response.writeHead(status, {
          "Content-Type": status === 200 ? "application/json" : "application/problem+json",
        });
        return response.end(JSON.stringify(value));
      };
      if (url.pathname === "/v0/beads/context")
        return reply({
          project_id: projectId,
          backend: "dolt",
          dolt_mode: "server",
          capabilities: ["project.enforce", "issues.get", "issues.create", "issues.update"],
        });
      if (url.pathname === "/v0/beads/ready:count") return reply({ total: rows.length });
      if (url.pathname === "/v0/beads/ready") {
        const ready = rows.filter((row) => row.status === "open");
        return reply({
          items: url.searchParams.get("limit") === "1000" ? ready.slice(0, 1) : ready,
          has_more: truncated || (url.searchParams.get("limit") === "1000" && ready.length > 1),
        });
      }
      if (url.pathname === "/v0/beads/issues:claimNext") {
        writes.push(interactive.id);
        interactive.status = "in_progress";
        interactive.assignee = owner(id);
        return reply({ claimed: interactive });
      }
      const current = rows.find((row) => url.pathname === `/v0/beads/issues/${row.id}`);
      if (!current) return reply({}, 404);
      if (request.method === "GET") return reply(current);
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.from(z.union([z.string(), z.instanceof(Buffer)]).parse(chunk)));
      const body = z
        .object({
          actor: z.string(),
          expected_version: z.string(),
          expected_status: z.string(),
          expected_assignee: z.string(),
        })
        .parse(JSON.parse(Buffer.concat(chunks).toString()));
      writes.push(current.id);
      if (race && current.id === ordinary.id) {
        current.revision = "2";
        current.metadata["pi.plan_task"] = { delivery: "pull-request" };
        race = false;
      }
      if (competing && current.id === ordinary.id) {
        current.assignee = "other";
        current.status = "in_progress";
        competing = false;
      }
      if (
        body.expected_version !== current.revision ||
        body.expected_status !== current.status ||
        body.expected_assignee !== current.assignee
      )
        return reply(
          {
            title: "Conflict",
            status: 409,
            code: "version_conflict",
            detail: "revision changed",
          },
          409,
        );
      current.status = "in_progress";
      current.assignee = body.actor;
      current.revision = "claimed";
      current.metadata["pi.attempt"] = id;
      return reply({ revision: current.revision });
    })().catch((error: unknown) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  const source = { url: `http://127.0.0.1:${String(address.port)}`, projectId };
  const service = new ExecutionBeads(source);
  const directory = await mkdtemp(join(tmpdir(), "studio-admission-"));
  const store = new ExecutionStore(directory);
  try {
    for (const marker of [undefined, null, {}, "invalid"]) {
      assert.throws(() => {
        requireUnattendedTask(
          beadSchema.parse({
            ...ordinary,
            metadata: { "pi.plan_task": marker },
          }),
        );
      }, /interactive children/u);
    }
    assert.equal((await service.claimNext(id))?.id, ordinary.id);
    assert.equal(interactive.status, "open");
    assert.equal(interactive.assignee, "");
    assert.deepEqual(writes, [ordinary.id]);
    rows = [interactive];
    writes.length = 0;
    assert.equal(await service.claimNext(id), undefined);
    assert.deepEqual(writes, []);
    rows = [
      interactive,
      beadSchema.parse({
        ...ordinary,
        status: "open",
        assignee: "",
        revision: "1",
        metadata: {},
      }),
      beadSchema.parse({
        ...last,
        status: "open",
        assignee: "",
        revision: "1",
        metadata: {},
      }),
    ];
    // The selected row acquires interactive authority after selection, before the CAS.
    ordinary.metadata = {};
    ordinary.revision = "1";
    ordinary.status = "open";
    ordinary.assignee = "";
    rows[1] = ordinary;
    race = true;
    assert.equal((await service.claimNext(id))?.id, last.id);
    assert.equal(ordinary.assignee, "");
    ordinary.metadata = {};
    ordinary.revision = "1";
    ordinary.status = "open";
    ordinary.assignee = "";
    last.metadata = {};
    last.revision = "1";
    last.status = "open";
    last.assignee = "";
    rows = [interactive, ordinary, last];
    competing = true;
    assert.equal((await service.claimNext(id))?.id, last.id);
    assert.equal(ordinary.assignee, "other");
    truncated = true;
    writes.length = 0;
    await assert.rejects(service.claimNext(id), /truncated/u);
    assert.deepEqual(writes, []);
    const retained = beadSchema.parse({
      ...interactive,
      status: "in_progress",
      assignee: owner(id),
    });
    store.saveAttempt(
      executionSchema.parse({
        id,
        project: projectId,
        profile: StudioProfile.Personal,
        phase: ExecutionPhase.Claiming,
        message: "",
      }),
    );
    writes.length = 0;
    await retainClaim(store, service, id, retained);
    assert.equal(store.attempt(id).phase, ExecutionPhase.Parked);
    assert.deepEqual(writes, []);
    assert.equal(store.attempt(id).checkout, undefined);
    store.change(id, (row) => {
      row.phase = ExecutionPhase.Queued;
    });
    const project = {
      ...runtimeProjectSchema.parse({
        root: directory,
        source,
        profile: StudioProfile.Personal,
        base: "main",
        beadsWorkspace: directory,
        beadsDatabase: "fixture",
      }),
      id: projectId,
    };
    await reconcileAttempt(store, project, id);
    assert.equal(store.attempt(id).phase, ExecutionPhase.Parked);
    assert.equal(store.attempt(id).launchToken, undefined);
    assert.equal(store.attempt(id).checkout, undefined);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
    server.close();
    await once(server, "close");
  }
});
