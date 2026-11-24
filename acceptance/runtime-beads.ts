import assert from "node:assert/strict";
import { Command } from "commander";
import { join } from "node:path";
import { z } from "zod";
import { withBeadsHttp } from "./beads-http-fixture.ts";
import {
  ExecutionBeads,
  heartbeat,
  verifyHeartbeatAuthority,
} from "../execution/beads.ts";
import { StudioProfile, exampleConfig } from "../config.ts";
import {
  ExecutionStore,
  executionSchema,
  ExecutionPhase,
} from "../execution/store.ts";
import { reconcileAttempt, retainClaim } from "../execution/recovery.ts";
import { maintainAttempt } from "../execution/supervisor.ts";
import { writeFile } from "node:fs/promises";
import { draftSchema, planDigest } from "../lead-plan.ts";
import { beadSchema, owner } from "../task-service.ts";
import { randomUUID } from "node:crypto";

const program = new Command()
  .requiredOption("--bd <path>")
  .requiredOption("--dolt <path>");
program.parse();
const options = program.opts<{ bd: string; dolt: string }>();
await withBeadsHttp(options.bd, options.dolt, async (fixture, source) => {
  const context = await fixture.command(["context", "--json"]);
  assert.equal(context.code, 0, context.stderr);
  const service = new ExecutionBeads(source);
  const prefix = await service.prefix();
  const graph = randomUUID();
  const root = `${prefix}-${graph.replaceAll("-", "")}`;
  const draft = draftSchema.parse({
    summary: "Approved fixture graph",
    tasks: [
      {
        key: "first",
        title: "First",
        description: "Produce a prerequisite",
        acceptance: "Result retained",
        owns: ["first.txt"],
      },
      {
        key: "second",
        title: "Second",
        description: "Consume first",
        acceptance: "Reads prerequisite",
        blockedBy: ["first"],
        owns: ["second.txt"],
      },
      {
        key: "held",
        title: "Held",
        description: "Wait",
        acceptance: "Not dispatched",
        hold: true,
        owns: ["held.txt"],
      },
    ],
  });
  const ids = {
    root,
    first: `${root}.first`,
    second: `${root}.second`,
    held: `${root}.held`,
  };
  await service.createGraph(
    graph,
    planDigest(draft),
    "Runtime fixture",
    draft,
    ids,
  );
  await service.createGraph(
    graph,
    planDigest(draft),
    "Runtime fixture",
    draft,
    ids,
  );
  const replay = () =>
    service.createGraph(
      graph,
      planDigest(draft),
      "Runtime fixture",
      draft,
      ids,
    );
  let mutation = await fixture.command([
    "update",
    ids.first,
    "--description",
    "Changed after approval",
  ]);
  assert.equal(mutation.code, 0, mutation.stderr);
  await assert.rejects(replay, /reviewed brief/u);
  mutation = await fixture.command([
    "update",
    ids.first,
    "--description",
    "Produce a prerequisite",
  ]);
  assert.equal(mutation.code, 0, mutation.stderr);
  mutation = await fixture.command(["dep", "remove", ids.second, ids.first]);
  assert.equal(mutation.code, 0, mutation.stderr);
  await assert.rejects(replay, /dependency edges/u);
  mutation = await fixture.command(["dep", "add", ids.second, ids.first]);
  assert.equal(mutation.code, 0, mutation.stderr);
  await replay();
  assert.equal((await service.get(ids.held)).status, "deferred");
  const interactiveCreated = await fixture.command([
    "create",
    "--title",
    "Interactive PR child",
    "--type",
    "task",
    "--priority",
    "0",
    "--metadata",
    JSON.stringify({
      "pi.plan": "interactive-approval",
      "pi.plan_parent": root,
      "pi.plan_key": "interactive",
      "pi.plan_task": {
        key: "interactive",
        title: "Interactive PR child",
        description: "Use the interactive lead",
        acceptance: "PR published",
        delivery: "pull-request",
      },
    }),
    "--json",
  ]);
  assert.equal(interactiveCreated.code, 0, interactiveCreated.stderr);
  const interactiveId = z
    .object({ id: z.string() })
    .parse(JSON.parse(interactiveCreated.stdout)).id;
  const untouchedInteractive = await service.get(interactiveId);
  const firstAttempt = randomUUID();
  const first = await service.claimNext(firstAttempt);
  assert.equal(first?.id, ids.first);
  assert.equal(
    await service.claimNext(randomUUID()),
    undefined,
    "Dependencies, holds, and container must not enter ready admission",
  );
  const raced = await fixture.command([
    "create",
    "--title",
    "Ready race",
    "--type",
    "task",
    "--json",
  ]);
  assert.equal(raced.code, 0, raced.stderr);
  const racedId = z
    .object({ id: z.string() })
    .parse(JSON.parse(raced.stdout)).id;
  const ready = await fixture.command(["ready", "--json"]);
  assert.equal(ready.code, 0, ready.stderr);
  assert(
    z
      .array(z.looseObject({ id: z.string() }))
      .parse(JSON.parse(ready.stdout))
      .some((row) => row.id === racedId),
  );
  const defer = await fixture.command([
    "update",
    racedId,
    "--status",
    "deferred",
  ]);
  assert.equal(defer.code, 0, defer.stderr);
  assert.equal(
    await service.claimNext(randomUUID()),
    undefined,
    "Atomic admission must re-evaluate readiness after a stale ready read",
  );
  const bound = await service.bind(beadSchema.parse(first), firstAttempt);
  const project = {
    id: source.projectId,
    root: fixture.workspace,
    source,
    profile: StudioProfile.Personal,
    base: "main",
    merge: false,
    verificationReadPaths: [],
    beadsWorkspace: fixture.workspace,
    beadsExecutable: options.bd,
    beadsDatabase: "studio_native",
  };
  // The fixture uses its own unique database; take the authoritative CLI context rather than a user database.
  const identity = z
    .looseObject({
      database: z.string().optional(),
      dolt_database: z.string().optional(),
    })
    .parse(JSON.parse(context.stdout));
  project.beadsDatabase =
    identity.database ?? identity.dolt_database ?? "studio_native";
  const caller = process.cwd();
  process.chdir(fixture.directory);
  try {
    await verifyHeartbeatAuthority(project);
    await heartbeat(project, firstAttempt, bound.id);
  } finally {
    process.chdir(caller);
  }
  const configFile = join(fixture.directory, "reconcile-config.json");
  await writeFile(configFile, JSON.stringify(exampleConfig));
  const previousConfig = process.env["STUDIO_CONFIG"];
  process.env["STUDIO_CONFIG"] = configFile;
  const store = new ExecutionStore(join(fixture.directory, "claim-state"));
  try {
    store.enroll(project);
    store.saveAttempt(
      executionSchema.parse({
        id: firstAttempt,
        project: project.id,
        profile: project.profile,
        phase: ExecutionPhase.Uncertain,
        bead: bound,
        message: "Lost claim receipt; ownership lookup found the bead",
      }),
    );
    await reconcileAttempt(store, project, firstAttempt);
    const recovered = store.attempt(firstAttempt);
    assert.equal(recovered.phase, ExecutionPhase.Queued);
    assert.equal(recovered.revision, bound.revision);
    assert(
      recovered.worker !== undefined && recovered.controller !== undefined,
    );
    await heartbeat(project, firstAttempt, bound.id);

    // Close the task after the supervisor selects it but before the real CLI renews it.
    let lateRenewal: Promise<void> | undefined;
    await maintainAttempt(store, project, firstAttempt, {
      reconcile: reconcileAttempt,
      heartbeat: async (...args) => {
        await service.finishAccepted(
          bound,
          firstAttempt,
          "Verified fixture result",
        );
        store.change(firstAttempt, (row) => {
          row.phase = ExecutionPhase.Complete;
        });
        lateRenewal = heartbeat(...args);
        await lateRenewal;
      },
    });
    assert(lateRenewal !== undefined);
    await assert.rejects(lateRenewal, /closed/u);
    assert.equal(store.attempt(firstAttempt).phase, ExecutionPhase.Complete);
  } finally {
    store.close();
    if (previousConfig === undefined) delete process.env["STUDIO_CONFIG"];
    else process.env["STUDIO_CONFIG"] = previousConfig;
  }

  await assert.rejects(
    () =>
      heartbeat(
        { ...project, source: { ...source, reviewOnly: true } },
        firstAttempt,
        bound.id,
      ),
    /review-only/u,
  );
  await assert.rejects(
    heartbeat(project, randomUUID(), bound.id),
    /claimed by/u,
  );
  const secondAttempt = randomUUID();
  const next = await service.claimNext(secondAttempt);
  assert.equal(next?.id, ids.second);
  await service.bind(beadSchema.parse(next), secondAttempt);
  const externalClosure = await fixture.command(
    ["close", ids.second],
    owner(secondAttempt),
  );
  assert.equal(externalClosure.code, 0, externalClosure.stderr);
  await assert.rejects(
    heartbeat(project, secondAttempt, ids.second),
    /closed/u,
  );
  const release = await fixture.command([
    "update",
    ids.held,
    "--status",
    "open",
  ]);
  assert.equal(release.code, 0, release.stderr);
  assert.equal(
    (await service.claimNext(randomUUID()))?.id,
    ids.held,
    "Releasing a native hold makes approved queue work eligible without another lead approval",
  );
  assert.deepEqual(
    await service.get(interactiveId),
    untouchedInteractive,
    "The higher-priority interactive child remains unclaimed while unattended ready work progresses",
  );
  // Reconcile a claim left by an older broad dispatcher without binding or allocating it.
  const badAttempt = randomUUID();
  await service.claim(untouchedInteractive, badAttempt);
  const oldClaim = await service.get(interactiveId);
  const blockedStore = new ExecutionStore(
    join(fixture.directory, "interactive-claim-state"),
  );
  try {
    blockedStore.saveAttempt(
      executionSchema.parse({
        id: badAttempt,
        project: source.projectId,
        profile: StudioProfile.Personal,
        phase: ExecutionPhase.Claiming,
        message: "Old broad claim",
      }),
    );
    await retainClaim(blockedStore, service, badAttempt, oldClaim);
    assert.equal(blockedStore.attempt(badAttempt).phase, ExecutionPhase.Parked);
    assert.equal(blockedStore.attempt(badAttempt).checkout, undefined);
    assert.equal(blockedStore.attempt(badAttempt).launchToken, undefined);
    assert.deepEqual(
      await service.get(interactiveId),
      oldClaim,
      "Retaining an old interactive claim cannot rewrite its authority",
    );
  } finally {
    blockedStore.close();
  }
  console.log(
    `Native Beads graph, hold, atomic admission, heartbeat, and completion passed (${join(fixture.workspace, ".beads")}).`,
  );
});
