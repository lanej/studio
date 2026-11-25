import assert from "node:assert/strict";
import { test } from "node:test";
import { test as gitTest } from "bun:test";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resumeReviewedAssignment } from "../execution/worker.ts";
import {
  deliverAssignment,
  type DeliveryDependencies,
  type OctoCall,
} from "../execution/delivery.ts";
import {
  type Execution,
  ExecutionStore,
  ExecutionPhase,
  VerificationPhase,
  executionSchema,
  projectSchema,
} from "../execution/store.ts";
import { StudioProfile } from "../config.ts";

const firstHead = "1".repeat(40);
const nextHead = "2".repeat(40);
const mergedHead = "3".repeat(40);
const draft = {
  title: "Implement accepted work",
  body: "Reviewed implementation",
  summary: "Agreed check passed",
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "studio-delivery-"));
  const store = new ExecutionStore(directory);
  const id = randomUUID();
  const projectId = randomUUID();
  const project = projectSchema.parse({
    id: projectId,
    root: directory,
    source: { url: "http://127.0.0.1:9", projectId },
    profile: StudioProfile.Personal,
    base: "origin/main",
    beadsWorkspace: directory,
    beadsDatabase: "fixture",
    merge: false,
  });
  const initial = executionSchema.parse({
    id,
    project: projectId,
    profile: StudioProfile.Personal,
    phase: ExecutionPhase.Delivery,
    bead: {
      id: "fixture-task",
      title: "Implement accepted work",
      status: "in_progress",
      revision: "accepted",
      assignee: `pi:${id}`,
    },
    base: "0".repeat(40),
    head: firstHead,
    review: "Independent exact-head approval",
    controllerSession: randomUUID(),
    message: "Ready to publish",
    checkout: {
      primary: directory,
      root: directory,
      path: join(directory, "worker"),
      task_id: id,
      owner_id: id,
      agent: "studio",
      branch: "studio-fixture",
      created_at: new Date().toISOString(),
      base_ref: "main",
    },
  });
  store.saveAttempt(initial);
  const controller = new AbortController();
  const calls: string[][] = [];
  const gitCalls: string[][] = [];
  const actor = randomUUID();
  const prId = randomUUID();
  const publicationId = randomUUID();
  let merged = false;
  let ready = false;
  let waits = 0;
  let stopAfter = 12;
  let enabled = true;
  let manualAuthority = true;
  let onWait: (() => void) | undefined;
  let losePublish = false;
  let loseMerge = false;
  let loseQueuedMerge = false;
  let queueAccepted = false;
  const mergeRequests = new Set<string>();
  const entryId = randomUUID();
  const chainId = randomUUID();
  let disableOnWait = false;
  let feedback = false;
  let failCorrection = false;
  let hasCurrentChecks = true;
  let staleReady = false;
  let pendingCheck = false;
  let correctionCount = 0;
  const url = "https://github.com/fixture/studio/pull/42";
  const actionId = randomUUID();
  const otherPr = randomUUID();
  let readyId = randomUUID();
  let blockMerge = false;
  let refreshReady = false;
  const feedbackId = randomUUID();
  const otherId = randomUUID();
  const action = () => ({
    id: actionId,
    prId,
    ownerAgentId: actor,
    state: "acknowledged",
    summary: "An actionable finding",
    blocker: feedback
      ? {
          case: "reviewFeedback",
          value: {
            source: "inline",
            id: "finding",
            revision: "r1",
            body: "Fix the accepted behavior",
          },
        }
      : {
          case: "checkResults",
          value: {
            headSha: store.attempt(id).head,
            state: 2,
            checks: [
              {
                headSha: store.attempt(id).head,
                name: "verify",
                status: pendingCheck ? "in_progress" : "completed",
                conclusion: hasCurrentChecks ? "success" : "failure",
              },
            ],
          },
        },
  });
  const call: OctoCall = async (cwd, ...args) => {
    await Promise.resolve(); // Preserve the real CLI boundary between intents and receipts.
    assert.equal(
      cwd,
      project.root,
      "Octo must run from trusted source, never mutable checkout",
    );
    calls.push(args);
    const command = args.slice(0, 2).join(" ");
    if (command === "agent register")
      return {
        agent: {
          id: actor,
          target: {
            harness: "pi",
            endpoint: "local",
            sessionId: initial.controllerSession,
          },
        },
      };
    if (command === "pr validate") return { valid: true };
    if (command === "pr publish") {
      assert.equal(args[args.indexOf("--request-id") + 1], id);
      assert.equal(args[args.indexOf("--expected-head") + 1], initial.head);
      if (losePublish) {
        losePublish = false;
        throw new Error("Publication response lost");
      }
      return { id: publicationId, state: "pending" };
    }
    if (command === "publication show")
      return { id: publicationId, state: "published", url, tracking: "active" };
    if (command === "pr show")
      return {
        pr: {
          id: prId,
          url,
          ownerAgentId: actor,
          observation: {
            headSha: store.attempt(id).head,
            lifecycle: merged ? "merged" : "open",
            feedback: { state: "complete", value: feedback ? ["finding"] : [] },
            reviews: { state: "complete", value: [] },
          },
        },
      };
    if (command === "pr auto-merge") {
      assert.ok(args.includes("--off"));
      return { enabled: false };
    }
    if (command === "agent inbox") {
      assert.ok(
        args.includes("--include-acknowledged"),
        "Restart must recover between read receipt and assessment",
      );
      const after = Number(args[args.indexOf("--after") + 1]);
      if (after === 0)
        return {
          messages: [
            {
              id: otherId,
              recipientAgentId: actor,
              applicable: true,
              workflowPrId: otherPr,
            },
            {
              id: feedbackId,
              recipientAgentId: actor,
              applicable: true,
              actionId,
            },
          ],
          hasMore: true,
          nextSequence: 2,
        };
      return {
        messages:
          ready && hasCurrentChecks && !pendingCheck
            ? [
                {
                  id: readyId,
                  recipientAgentId: actor,
                  applicable: true,
                  workflowPrId: prId,
                  readyHead: staleReady ? firstHead : store.attempt(id).head,
                },
              ]
            : [],
        hasMore: false,
        nextSequence: 3,
      };
    }
    if (args[0] === "read")
      return {
        message: {
          id: args[1],
          items:
            args[1] === feedbackId
              ? [
                  {
                    id: feedbackId,
                    applicable: true,
                    action: { action: { id: actionId } },
                  },
                ]
              : [],
        },
      };
    if (command === "action list") return { actions: [{ id: actionId }] };
    if (command === "action show") {
      assert.ok(args.includes("--full"));
      return { action: action() };
    }
    if (command === "action ack")
      return { action: { ...action(), state: "acknowledged" } };
    if (command === "pr ready") {
      ready = true;
      return { state: "waiting_checks" };
    }
    if (command === "chain show")
      return {
        entries: [{ id: entryId, prId, state: "merging" }],
        operations: [{ entryId, kind: "merge", state: "running" }],
      };
    if (args[0] === "merge") {
      assert.equal(
        args[1],
        readyId,
        "Pi merges use native inbox receipt identity",
      );
      assert.equal(
        args[args.indexOf("--expected-head") + 1],
        store.attempt(id).head,
      );
      assert.equal(store.attempt(id).review, "Independent exact-head approval");
      const attempt = store.attempt(id);
      if (attempt.bead?.metadata["studio.pullRequestMerge"] === "manual") {
        const approval = attempt.manualMergeApproval;
        assert.ok(approval !== undefined);
        assert.equal(approval.notice, args[1]);
        assert.equal(approval.head, attempt.head);
        assert.ok(manualAuthority);
      } else assert.ok(enabled);
      if (blockMerge) {
        blockMerge = false;
        refreshReady = true;
        return { state: "blocked", pr: url, reason: "Target base changed" };
      }
      mergeRequests.add(`${args[1]}:${store.attempt(id).head ?? ""}`);
      if (loseQueuedMerge && !queueAccepted) {
        queueAccepted = true;
        throw new Error("Queued merge response lost");
      }
      merged = true;
      if (loseMerge) {
        loseMerge = false;
        throw new Error("Merge response lost");
      }
      return {
        state: "queued",
        pr: url,
        entry: entryId,
        chain: chainId,
      };
    }
    throw new Error(`Unsupported fixture call: ${args.join(" ")}`);
  };
  const dependencies: DeliveryDependencies = {
    networkGit: (root, args) => {
      assert.equal(root, project.root);
      gitCalls.push(args);
      return Promise.resolve(
        args[0] === "remote"
          ? "git@github.com:fixture/studio.git\n"
          : args[0] === "rev-parse"
            ? mergedHead
            : "",
      );
    },
    safeGit: (root, cwd, args) => {
      assert.equal(root, project.root);
      assert.equal(cwd, initial.checkout?.path);
      gitCalls.push(args);
      return Promise.resolve(
        args.includes("--name-only") ? "accepted.txt\0" : "",
      );
    },
    mergePolicy: () => Promise.resolve({ enabled }),
    requireManualMergeAuthority: () => {
      if (!manualAuthority)
        throw new Error("Manual merge project authority disabled");
      return Promise.resolve();
    },
    wait: () => {
      onWait?.();
      if (disableOnWait) enabled = false;
      if (refreshReady) {
        refreshReady = false;
        readyId = randomUUID();
      }
      if (++waits >= stopAfter) controller.abort();
      return Promise.resolve();
    },
  };
  const correct = async (evidence: string) => {
    const evidenceFiles = await readdir(join(directory, "delivery", id));
    assert.ok(
      evidenceFiles.some((file) => /^[a-f0-9]{64}\.json$/u.test(file)),
      "Full evidence must precede corrective effects",
    );
    correctionCount++;
    assert.ok(evidence.includes(actionId));
    if (failCorrection) throw new Error("Unresolved accepted-scope feedback");
    store.change(id, (row) => {
      row.head = nextHead;
      row.review = "Independent exact-head approval";
    });
    return { ...draft, head: nextHead };
  };
  return {
    directory,
    store,
    initial,
    project,
    controller,
    calls,
    gitCalls,
    mergeRequests,
    call,
    dependencies,
    correct,
    actionId,
    otherId,
    get corrections() {
      return correctionCount;
    },
    configure(options: {
      merge?: boolean;
      planMerge?: "manual" | "project-policy";
      manualAuthority?: boolean;
      onWait?: () => void;
      externallyMerged?: boolean;
      lostPublish?: boolean;
      lostMerge?: boolean;
      disableBeforeMerge?: boolean;
      changedBase?: boolean;
      lostQueuedMerge?: boolean;
      inFlightMerge?: boolean;
      finding?: boolean;
      failedCorrection?: boolean;
      failedChecks?: boolean;
      stale?: boolean;
      pending?: boolean;
      maxWaits?: number;
    }) {
      enabled = options.merge ?? enabled;
      manualAuthority = options.manualAuthority ?? manualAuthority;
      onWait = options.onWait ?? onWait;
      merged = options.externallyMerged ?? merged;
      if (options.planMerge !== undefined) {
        const merge = options.planMerge;
        store.change(id, (row) => {
          row.bead = {
            id: "bd-publish",
            title: "Publish",
            description: "Deliver the reviewed change",
            acceptance_criteria: "A PR is opened",
            status: "in_progress",
            assignee: `pi:${id}`,
            revision: "accepted",
            metadata: { "studio.pullRequestMerge": merge },
          };
        });
      }
      losePublish = options.lostPublish ?? losePublish;
      loseMerge = options.lostMerge ?? loseMerge;
      disableOnWait = options.disableBeforeMerge ?? disableOnWait;
      blockMerge = options.changedBase ?? blockMerge;
      loseQueuedMerge = options.lostQueuedMerge ?? loseQueuedMerge;
      if (options.inFlightMerge === true)
        store.change(id, (row) => {
          row.agent = actor;
          row.publication = publicationId;
          row.url = url;
          row.mergeReceipt = JSON.stringify({
            state: "queued",
            pr: url,
            entry: entryId,
            chain: chainId,
            notice: readyId,
            head: row.head,
          });
        });
      feedback = options.finding ?? feedback;
      failCorrection = options.failedCorrection ?? failCorrection;
      hasCurrentChecks = !(options.failedChecks ?? !hasCurrentChecks);
      staleReady = options.stale ?? staleReady;
      pendingCheck = options.pending ?? pendingCheck;
      stopAfter = options.maxWaits ?? stopAfter;
    },
    async run(fence: () => Promise<void> = () => Promise.resolve()) {
      return deliverAssignment(
        store,
        project,
        store.attempt(initial.id),
        draft,
        controller.signal,
        correct,
        fence,
        call,
        dependencies,
      );
    },
    async close() {
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

await test("unattended delivery corrects acknowledged feedback once, independently reviews, and merges the native current-head receipt", async () => {
  const f = await fixture();
  try {
    f.configure({ finding: true });
    await f.run();
    assert.equal(
      f.corrections,
      1,
      "A duplicate notice/ACK state cannot repeat the same assessment",
    );
    assert.equal(f.calls.filter((call) => call[0] === "merge").length, 1);
    assert.equal(
      f.calls.filter((call) => call[0] === "read" && call[1] === f.otherId)
        .length,
      0,
      "Other PR delivery must not be consumed",
    );
    assert.equal(f.store.attempt(f.initial.id).merged, mergedHead);
    const evidenceFiles = await readdir(
      join(f.directory, "delivery", f.initial.id),
    );
    assert.ok(evidenceFiles.some((file) => /^[a-f0-9]{64}\.json$/u.test(file)));
    const ack = f.calls.findIndex(
      (call) => call[0] === "action" && call[1] === "ack",
    );
    const correctionPush = f.gitCalls.findIndex(
      (call) => call[0] === "push" && call[2]?.startsWith(nextHead) === true,
    );
    assert.ok(ack > 0 && correctionPush > 0);
  } finally {
    await f.close();
  }
});

await test("a manual plan publishes and processes readiness but never sends or replays an automatic merge", async () => {
  for (const replay of [false, true]) {
    const f = await fixture();
    try {
      if (replay) {
        // Simulate a retained merge intent across process restart; replay can also submit an external effect.
        f.store.change(f.initial.id, (row) => {
          row.mergeReceipt = JSON.stringify({
            state: "requested",
            notice: "retained",
            head: firstHead,
          });
        });
      }
      f.configure({ planMerge: "manual", merge: true, maxWaits: 4 });
      await assert.rejects(f.run(), /Delivery interrupted/u);
      assert.ok(
        f.calls.some((call) => call[0] === "pr" && call[1] === "publish"),
      );
      if (!replay) {
        assert.ok(
          f.calls.some((call) => call[0] === "pr" && call[1] === "ready"),
        );
        assert.equal(
          f.store.attempt(f.initial.id).readyNotice?.head,
          firstHead,
        );
      }
      assert.equal(
        f.calls.some((call) => call[0] === "merge"),
        false,
      );
      assert.equal(f.store.attempt(f.initial.id).merged, undefined);
      assert.equal(
        f.store.attempt(f.initial.id).phase,
        ExecutionPhase.Delivery,
      );
    } finally {
      await f.close();
    }
  }
});

// The CLI's guarded write and remote ownership checks are exercised by the command tests.
function consentToReady(row: Execution): void {
  const target = row.readyNotice;
  assert.ok(
    target !== undefined && row.pr !== undefined && row.agent !== undefined,
  );
  assert.match(
    row.message,
    new RegExp(
      `studio runtime approve-merge ${row.id} --head ${target.head}`,
      "u",
    ),
  );
  row.manualMergeApproval = {
    head: target.head,
    notice: target.id,
    pr: row.pr,
    agent: row.agent,
    actor: "operator",
    at: new Date().toISOString(),
  };
}

await test("one manual approval can merge with automatic merging off and survives an unknown queued response", async () => {
  const f = await fixture();
  try {
    f.configure({
      planMerge: "manual",
      merge: false,
      lostQueuedMerge: true,
      onWait() {
        const row = f.store.attempt(f.initial.id);
        if (
          row.readyNotice !== undefined &&
          row.manualMergeApproval === undefined
        )
          f.store.change(row.id, consentToReady);
      },
    });
    await assert.rejects(f.run(), /Queued merge response lost/u);
    assert.match(
      f.store.attempt(f.initial.id).mergeReceipt ?? "",
      /requested/u,
    );
    f.configure({ manualAuthority: false });
    await assert.rejects(f.run(), /Manual merge project authority disabled/u);
    assert.equal(f.calls.filter((call) => call[0] === "merge").length, 1);
    f.configure({ manualAuthority: true });
    await f.run();
    const merges = f.calls.filter((call) => call[0] === "merge");
    assert.equal(merges.length, 2);
    assert.deepEqual(merges[0], merges[1]);
    assert.equal(f.mergeRequests.size, 1);
    assert.equal(f.store.attempt(f.initial.id).merged, mergedHead);
  } finally {
    await f.close();
  }
});

await test("manual approval does not carry over to a fresh corrected head or a replacement Ready notice", async () => {
  for (const correction of [true, false]) {
    const f = await fixture();
    try {
      let approved = false;
      f.configure({
        planMerge: "manual",
        merge: true,
        changedBase: !correction,
        maxWaits: 8,
        onWait() {
          const row = f.store.attempt(f.initial.id);
          if (row.readyNotice !== undefined && !approved) {
            f.store.change(row.id, consentToReady);
            approved = true;
            if (correction) f.configure({ finding: true });
          }
        },
      });
      await assert.rejects(f.run(), /Delivery interrupted/u);
      const row = f.store.attempt(f.initial.id);
      assert.equal(row.manualMergeApproval, undefined);
      assert.equal(row.readyNotice?.head, correction ? nextHead : firstHead);
      assert.match(row.message, /studio runtime approve-merge/u);
      assert.equal(
        f.calls.filter((call) => call[0] === "merge").length,
        correction ? 0 : 1,
      );
      assert.equal(row.merged, undefined);
    } finally {
      await f.close();
    }
  }
});

await test("a merge outside the tracked manual approval flow still requires reconciliation", async () => {
  const f = await fixture();
  try {
    f.configure({ planMerge: "manual", externallyMerged: true });
    await assert.rejects(f.run(), /merged outside the retained exact-head/u);
    assert.equal(f.store.attempt(f.initial.id).merged, undefined);
  } finally {
    await f.close();
  }
});

await test("policy-off retains the reviewed PR, and unfinished checks never attest readiness or merge", async () => {
  for (const pending of [false, true]) {
    const f = await fixture();
    try {
      f.configure({ merge: false, pending, maxWaits: 3 });
      await assert.rejects(f.run(), /Delivery interrupted/u);
      assert.equal(f.calls.filter((call) => call[0] === "merge").length, 0);
      assert.equal(
        f.calls.filter((call) => call[0] === "action" && call[1] === "ack")
          .length,
        pending ? 0 : 1,
      );
      if (pending)
        assert.equal(
          f.calls.filter((call) => call[0] === "pr" && call[1] === "ready")
            .length,
          0,
        );
      assert.equal(
        f.store.attempt(f.initial.id).phase,
        ExecutionPhase.Delivery,
      );
    } finally {
      await f.close();
    }
  }
});

await test("failed corrective assessment preserves full evidence without ACK, owner readiness, or merge", async () => {
  const f = await fixture();
  try {
    f.configure({ finding: true, failedCorrection: true });
    await assert.rejects(f.run(), /Unresolved accepted-scope feedback/u);
    assert.equal(
      f.calls.filter((call) =>
        ["ack", "ready", "merge"].includes(call[1] ?? call[0] ?? ""),
      ).length,
      0,
    );
    assert.equal(f.store.attempt(f.initial.id).mergeReceipt, undefined);
  } finally {
    await f.close();
  }
});

await test("a lost publication response replays its durable request and exact caller draft", async () => {
  const f = await fixture();
  try {
    f.configure({ lostPublish: true });
    await assert.rejects(f.run(), /Publication response lost/u);
    const input = await readFile(
      join(f.directory, "delivery", f.initial.id, "publication.json"),
      "utf8",
    );
    await f.run();
    assert.equal(
      f.calls.filter((call) => call[0] === "pr" && call[1] === "publish")
        .length,
      2,
    );
    assert.equal(
      await readFile(
        join(f.directory, "delivery", f.initial.id, "publication.json"),
        "utf8",
      ),
      input,
    );
    assert.equal(f.calls.filter((call) => call[0] === "merge").length, 1);
  } finally {
    await f.close();
  }
});

await test("a stale Ready receipt cannot merge a corrected head", async () => {
  const f = await fixture();
  try {
    f.configure({ finding: true, stale: true, maxWaits: 4 });
    await assert.rejects(f.run(), /Delivery interrupted/u);
    assert.equal(f.calls.filter((call) => call[0] === "merge").length, 0);
    assert.equal(f.corrections, 1);
  } finally {
    await f.close();
  }
});

await test("a project policy disabled after readiness prevents the future pinned request", async () => {
  const f = await fixture();
  try {
    f.configure({
      planMerge: "project-policy",
      disableBeforeMerge: true,
      maxWaits: 3,
    });
    await assert.rejects(f.run(), /Delivery interrupted/u);
    assert.equal(f.calls.filter((call) => call[0] === "merge").length, 0);
    assert.ok(f.calls.some((call) => call[0] === "pr" && call[1] === "ready"));
  } finally {
    await f.close();
  }
});

await test("a lost merge response reconciles remote acceptance without a second merge request", async () => {
  const f = await fixture();
  try {
    f.configure({ lostMerge: true });
    await assert.rejects(f.run(), /Merge response lost/u);
    assert.match(
      f.store.attempt(f.initial.id).mergeReceipt ?? "",
      /"state":"requested"/u,
    );
    await f.run();
    assert.equal(f.calls.filter((call) => call[0] === "merge").length, 1);
    assert.equal(f.store.attempt(f.initial.id).merged, mergedHead);
  } finally {
    await f.close();
  }
});

await test("failing current-head CI retains delivery pending until fresh passing evidence", async () => {
  const f = await fixture();
  try {
    f.configure({ failedChecks: true, maxWaits: 4 });
    await assert.rejects(f.run(), /Delivery interrupted/u);
    assert.equal(f.calls.filter((call) => call[0] === "merge").length, 0);
    assert.equal(f.store.attempt(f.initial.id).merged, undefined);
  } finally {
    await f.close();
  }
});

await test("a changed-base rejection is retained and only a fresh Ready offer can request another merge", async () => {
  const f = await fixture();
  try {
    f.configure({ changedBase: true });
    await f.run();
    const merges = f.calls.filter((call) => call[0] === "merge");
    assert.equal(merges.length, 2);
    assert.notEqual(merges[0]?.[1], merges[1]?.[1]);
    assert.equal(f.store.attempt(f.initial.id).merged, mergedHead);
    assert.ok(
      (await readdir(join(f.directory, "delivery", f.initial.id))).some(
        (file) => file.startsWith("merge-blocked-"),
      ),
    );
  } finally {
    await f.close();
  }
});

await test("an already published branch with unproven ancestry cannot merge or replay a lost merge request", async () => {
  for (const replay of [false, true]) {
    const f = await fixture();
    try {
      const suppliedGit = f.dependencies.safeGit;
      const blockAncestry = () => {
        f.dependencies.safeGit = (...args) =>
          args[2][0] === "merge-base"
            ? Promise.reject(
                Object.assign(new Error("Not an ancestor"), { code: 1 }),
              )
            : suppliedGit(...args);
      };
      if (replay) {
        f.configure({ lostQueuedMerge: true });
        await assert.rejects(f.run(), /Queued merge response lost/u);
        blockAncestry();
      } else {
        f.configure({ onWait: blockAncestry });
      }
      await assert.rejects(f.run(), /PR publication ancestry/u);
      assert.ok(f.store.attempt(f.initial.id).publication);
      assert.equal(
        f.calls.filter((call) => call[0] === "merge").length,
        replay ? 1 : 0,
      );
    } finally {
      await f.close();
    }
  }
});

await test("an unknown queued merge reconciles the same native receipt identity before any correction", async () => {
  const f = await fixture();
  try {
    f.configure({ lostQueuedMerge: true });
    await assert.rejects(f.run(), /Queued merge response lost/u);
    await f.run();
    const requests = f.calls.filter((call) => call[0] === "merge");
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], requests[1]);
    assert.equal(
      f.mergeRequests.size,
      1,
      "Native receipt replay cannot create a second merge identity",
    );
    assert.equal(f.store.attempt(f.initial.id).merged, mergedHead);
  } finally {
    await f.close();
  }
});

await test("a possibly running merge fences new worker corrections even when feedback arrives", async () => {
  const f = await fixture();
  try {
    f.configure({ inFlightMerge: true, finding: true, maxWaits: 3 });
    await assert.rejects(f.run(), /Delivery interrupted/u);
    assert.equal(f.corrections, 0);
    assert.equal(f.calls.filter((call) => call[0] === "merge").length, 0);
    assert.ok(
      f.calls.some((call) => call[0] === "chain" && call[1] === "show"),
    );
    assert.equal(f.store.attempt(f.initial.id).head, firstHead);
  } finally {
    await f.close();
  }
});

await test("delivery cannot submit effects after the accepted task authority is retired", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.run(() => Promise.reject(new Error("Accepted task authority retired"))),
      /authority retired/u,
    );
    assert.equal(f.calls.length, 0);
    assert.equal(f.gitCalls.length, 0);
  } finally {
    await f.close();
  }
});

gitTest(
  "approved no-command worker resume replays a lost publication without another commit",
  async () => {
    const f = await fixture();
    try {
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
      );
      const git = (...args: string[]) => {
        const result = spawnSync(
          "/usr/bin/git",
          ["-c", "core.hooksPath=/dev/null", ...args],
          {
            cwd: f.directory,
            encoding: "utf8",
            timeout: process.env["CI"] === "true" ? 10_000 : 2_000,
            env: {
              ...environment,
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_AUTHOR_NAME: "Fixture",
              GIT_AUTHOR_EMAIL: "fixture@example.invalid",
              GIT_COMMITTER_NAME: "Fixture",
              GIT_COMMITTER_EMAIL: "fixture@example.invalid",
            },
          },
        );
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
      };
      git("init", "--quiet");
      git(
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--allow-empty",
        "-m",
        "Approved work",
      );
      const head = git("rev-parse", "HEAD");
      const tree = git("rev-parse", "HEAD^{tree}");
      f.initial.head = head;
      f.store.change(f.initial.id, (row) => {
        row.head = head;
        row.check = [];
        row.verifier = { phase: VerificationPhase.Complete };
        row.verification = {
          summary: "Controller verification",
          check: [],
          exitCode: null,
          gitHead: "precommit-head",
          gitState: tree,
          output: "",
        };
      });
      let implementations = 0;
      let resumes = 0;
      const resume = () =>
        resumeReviewedAssignment(
          f.store.attempt(f.initial.id),
          () => {
            implementations++;
            git(
              "-c",
              "core.hooksPath=/dev/null",
              "commit",
              "--allow-empty",
              "-m",
              "Unnecessary new implementation",
            );
            f.store.change(f.initial.id, (row) => {
              row.head = git("rev-parse", "HEAD");
            });
            return Promise.resolve();
          },
          () => {
            resumes++;
          },
        );
      f.configure({ lostPublish: true });
      await assert.rejects(f.run(), /Publication response lost/u);
      const path = join(
        f.directory,
        "delivery",
        f.initial.id,
        "publication.json",
      );
      const retained = await readFile(path, "utf8");
      await resume();
      await f.run();
      assert.equal(implementations, 0);
      assert.equal(resumes, 1);
      assert.equal(git("rev-parse", "HEAD"), head);
      assert.equal(git("rev-list", "--count", "HEAD"), "1");
      assert.equal(await readFile(path, "utf8"), retained);
      assert.equal(f.store.attempt(f.initial.id).head, head);
      assert.equal(
        f.calls.filter((call) => call[0] === "pr" && call[1] === "publish")
          .length,
        2,
      );
      assert.equal(f.calls.filter((call) => call[0] === "merge").length, 1);
    } finally {
      await f.close();
    }
  },
  process.env["CI"] === "true" ? 30_000 : 5_000,
);

await test("worker resume requires matching completed verification and independent approval", async () => {
  const f = await fixture();
  try {
    const accepted = executionSchema.parse({
      ...f.initial,
      check: ["verify"],
      verifier: { phase: VerificationPhase.Complete },
      verification: {
        summary: "Verified",
        check: ["verify"],
        exitCode: 0,
        gitHead: "precommit-head",
        gitState: "tree",
        output: "",
      },
    });
    const verification = accepted.verification;
    assert.ok(verification !== undefined);
    const invalid = [
      { ...accepted, verification: undefined },
      { ...accepted, verifier: undefined },
      { ...accepted, verifier: { phase: VerificationPhase.Running } },
      { ...accepted, verification: { ...verification, exitCode: 42 } },
      { ...accepted, verification: { ...verification, exitCode: null } },
      { ...accepted, verification: { ...verification, check: [] } },
      {
        ...accepted,
        check: [],
        verification: { ...verification, check: [], exitCode: 0 },
      },
      { ...accepted, review: undefined },
      { ...accepted, reviewFinding: "Change required" },
      { ...accepted, head: undefined },
    ];
    for (const attempt of [accepted, ...invalid]) {
      let implemented = false;
      let resumed = false;
      await resumeReviewedAssignment(
        attempt,
        () => {
          implemented = true;
          return Promise.resolve();
        },
        () => {
          resumed = true;
        },
      );
      assert.equal(implemented, attempt !== accepted);
      assert.equal(resumed, attempt === accepted);
    }
  } finally {
    await f.close();
  }
});
