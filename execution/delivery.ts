import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { octo } from "../delivery.ts";
import { draftSchema } from "../lead-plan.ts";
import { safeGit, networkGit } from "./git.ts";
import { mergePolicy } from "./policy.ts";
import {
  hasManualMergeApproval,
  requireManualMergeAuthority,
} from "./manual-merge.ts";
import {
  type ExecutionStore,
  ExecutionPhase,
  type Execution,
  type RuntimeProject,
} from "./store.ts";

const publication = z.looseObject({
  id: z.string(),
  state: z.string(),
  url: z.string().optional(),
  tracking: z.string().optional(),
});
const notice = z.looseObject({
  message: z.looseObject({
    id: z.string(),
    mergeTarget: z
      .looseObject({ head: z.string(), prId: z.string(), ownerId: z.string() })
      .optional(),
    items: z.array(
      z.looseObject({
        id: z.string(),
        applicable: z.boolean().optional(),
        action: z
          .looseObject({ action: z.looseObject({ id: z.string() }) })
          .optional(),
      }),
    ),
  }),
});
const shown = z.looseObject({
  action: z.looseObject({
    id: z.string(),
    prId: z.string(),
    ownerAgentId: z.string(),
    state: z.string(),
    evidenceHeadSha: z.string().optional(),
    summary: z.string(),
    blocker: z.looseObject({ case: z.string(), value: z.unknown() }).optional(),
  }),
});
const checks = z.object({
  headSha: z.string(),
  state: z.union([z.number(), z.string()]),
  checks: z.array(
    z.looseObject({
      headSha: z.string(),
      status: z.string(),
      conclusion: z.string(),
      name: z.string(),
    }),
  ),
});
const tracked = z.looseObject({
  pr: z.looseObject({
    id: z.string(),
    url: z.string(),
    ownerAgentId: z.string(),
    observation: z
      .looseObject({
        headSha: z.string(),
        lifecycle: z.string(),
        feedback: z
          .object({ state: z.string(), value: z.array(z.unknown()).optional() })
          .optional(),
        reviews: z
          .object({ state: z.string(), value: z.array(z.unknown()).optional() })
          .optional(),
      })
      .optional(),
  }),
});
export interface DeliveryDraft {
  summary: string;
  title: string;
  body: string;
}
export type OctoCall = (cwd: string, ...args: string[]) => Promise<unknown>;

export interface DeliveryDependencies {
  networkGit: typeof networkGit;
  safeGit: typeof safeGit;
  mergePolicy(project: string): Promise<{ enabled: boolean }>;
  requireManualMergeAuthority: typeof requireManualMergeAuthority;
  wait(signal: AbortSignal): Promise<void>;
}
const deliveryDependencies: DeliveryDependencies = {
  networkGit,
  safeGit,
  mergePolicy,
  requireManualMergeAuthority,
  wait: (signal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, 15000);
      signal.addEventListener("abort", done, { once: true });
    }),
};

export async function deliverAssignment(
  store: ExecutionStore,
  project: RuntimeProject,
  initial: Execution,
  draft: DeliveryDraft,
  signal: AbortSignal,
  correct: (feedback: string) => Promise<DeliveryDraft & { head: string }>,
  authorityFence: () => Promise<void>,
  octoCall: OctoCall = octo,
  adapters: DeliveryDependencies = deliveryDependencies,
): Promise<void> {
  // The claimed brief is retained across restarts. An older graph has no per-plan restriction.
  const mergeMode = draftSchema.shape.pullRequestMerge.parse(
    initial.bead?.metadata["studio.pullRequestMerge"],
  );
  const mayRequestMerge = async (target: { id: string; head: string }) => {
    if (mergeMode !== "manual")
      return (await adapters.mergePolicy(project.id)).enabled;
    if (!hasManualMergeApproval(store.attempt(initial.id), target))
      return false;
    await adapters.requireManualMergeAuthority(project);
    return true;
  };
  const cwd = initial.checkout?.path;
  if (
    cwd === undefined ||
    initial.head === undefined ||
    initial.review === undefined ||
    initial.controllerSession === undefined
  )
    throw new Error(
      "Delivery needs an owned checkout, exact-head independent review, and native control session",
    );
  // Octo reads its contract from the trusted enrolled source, never worker-writable policy files.
  const authority = project.root;
  const directory = join(store.directory, "delivery", initial.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const call: OctoCall = async (location, ...args) => {
    await authorityFence();
    const value = await octoCall(location, ...args);
    // Preserve mutation receipts even when authority is revoked during the request.
    if (
      args[0] === "merge" ||
      (args[0] === "pr" &&
        ["publish", "ready", "auto-merge"].includes(args[1] ?? "")) ||
      (args[0] === "action" && args[1] === "ack") ||
      (args[0] === "agent" && args[1] === "register")
    ) {
      const evidence = JSON.stringify({ args, value });
      await writeFile(
        join(
          directory,
          `effect-${createHash("sha256").update(evidence).digest("hex")}.json`,
        ),
        evidence,
        { mode: 0o600 },
      );
    }
    await authorityFence();
    return value;
  };
  const dependencies: DeliveryDependencies = {
    ...adapters,
    networkGit: async (...args) => {
      await authorityFence();
      const value = await adapters.networkGit(...args);
      await authorityFence();
      return value;
    },
    safeGit: async (...args) => {
      await authorityFence();
      const value = await adapters.safeGit(...args);
      await authorityFence();
      return value;
    },
  };

  let attempt = store.attempt(initial.id);
  if (attempt.agent === undefined) {
    const registration = z
      .object({
        agent: z.looseObject({
          id: z.string(),
          target: z.object({
            harness: z.literal("pi"),
            endpoint: z.literal("local"),
            sessionId: z.string(),
          }),
        }),
      })
      .parse(
        await call(
          authority,
          "agent",
          "register",
          "--harness",
          "pi",
          "--endpoint",
          "local",
          "--thread-id",
          initial.controllerSession,
        ),
      );
    if (registration.agent.target.sessionId !== initial.controllerSession)
      throw new Error("Octo registered another native controller session");
    attempt = store.change(initial.id, (row) => {
      row.agent = registration.agent.id;
    });
  }
  const agent = z.string().parse(attempt.agent);
  const identity = [
    "--agent-id",
    agent,
    "--harness",
    "pi",
    "--endpoint",
    "local",
    "--thread-id",
    initial.controllerSession,
  ];
  if (attempt.publication === undefined) {
    const remote = (
      await dependencies.networkGit(project.root, [
        "remote",
        "get-url",
        "origin",
      ])
    ).trim();
    const match =
      /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(
        remote,
      );
    const repo = match?.[1];
    if (repo === undefined)
      throw new Error(
        "PR delivery requires an explicit GitHub origin repository",
      );
    const inputPath = join(directory, "publication.json");
    const inputSchema = z.object({
      head: z.string(),
      title: z.string(),
      body: z.string(),
    });
    const input = { head: initial.head, title: draft.title, body: draft.body };
    // Lost responses replay the exact retained input and request identity, including after host restart.
    await writeFile(inputPath, JSON.stringify(input), {
      mode: 0o600,
      flag: "wx",
    }).catch((error: unknown) => {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
    });
    const saved = inputSchema.parse(
      JSON.parse(await readFile(inputPath, "utf8")),
    );
    if (saved.head !== initial.head)
      throw new Error(
        "Reconcile the retained publication before publishing another head",
      );
    const body = join(directory, "body.md");
    await writeFile(body, saved.body, { mode: 0o600 });
    await dependencies.networkGit(project.root, [
      "push",
      "origin",
      `${initial.head}:refs/heads/${initial.checkout?.branch ?? ""}`,
    ]);
    await call(
      authority,
      "pr",
      "validate",
      "--title",
      saved.title,
      "--body-file",
      body,
      "--repo",
      repo,
      "--head",
      initial.checkout?.branch ?? "",
      "--base",
      project.base.replace(/^origin\//u, ""),
    );
    store.change(initial.id, (row) => {
      row.phase = ExecutionPhase.Delivery;
      row.message =
        "Publication intent persisted; request identity is the admitted attempt ID";
    });
    const result = publication.parse(
      await call(
        authority,
        "pr",
        "publish",
        "--expected-head",
        initial.head,
        "--title",
        saved.title,
        "--body-file",
        body,
        "--repo",
        repo,
        "--head",
        initial.checkout?.branch ?? "",
        "--base",
        project.base.replace(/^origin\//u, ""),
        "--request-id",
        initial.id,
        "--track",
        ...identity,
      ),
    );
    attempt = store.change(initial.id, (row) => {
      row.publication = result.id;
      row.url = result.url;
    });
  }
  while (!signal.aborted) {
    attempt = store.attempt(initial.id);
    const submitted = publication.parse(
      await call(
        authority,
        "publication",
        "show",
        z.string().parse(attempt.publication),
      ),
    );
    if (submitted.id !== attempt.publication)
      throw new Error("Octo returned another publication receipt");
    if (submitted.state === "failed" || submitted.state === "uncertain")
      throw new Error(
        `Octo publication ${submitted.id} is ${submitted.state}; reconcile its receipt before retrying`,
      );
    if (
      submitted.state === "published" &&
      submitted.url !== undefined &&
      submitted.tracking === "active"
    ) {
      const observed = tracked.parse(
        await call(
          authority,
          "pr",
          "show",
          submitted.url,
          "--full",
          ...identity,
        ),
      );
      if (
        observed.pr.ownerAgentId !== agent ||
        observed.pr.url !== submitted.url ||
        (attempt.pr !== undefined && attempt.pr !== observed.pr.id) ||
        (attempt.url !== undefined && attempt.url !== observed.pr.url)
      )
        throw new Error(
          "Octo delivery ownership differs from the admitted controller",
        );
      store.change(initial.id, (row) => {
        row.pr = observed.pr.id;
        row.url = observed.pr.url;
        row.phase = ExecutionPhase.Delivery;
        row.message =
          mergeMode === "manual"
            ? "Published; the approved plan reserves merging for the operator"
            : "Published; processing durable Octo inbox independently of the lead";
      });
      if (
        observed.pr.observation?.lifecycle !== "merged" &&
        !attempt.events.includes("receipt-policy")
      ) {
        await call(
          authority,
          "pr",
          "auto-merge",
          observed.pr.id,
          "--off",
          "--request-id",
          `${initial.id}:receipt-policy`,
          ...identity,
        );
        store.change(initial.id, (row) => {
          row.events.push("receipt-policy");
        });
      }
      if (observed.pr.observation?.lifecycle === "merged") {
        if (
          attempt.mergeReceipt === undefined ||
          observed.pr.observation.headSha !== attempt.head
        )
          throw new Error(
            "PR merged outside the retained exact-head delivery intent; assess task criteria before completion",
          );
        const mergedIntent = z
          .object({
            state: z.string(),
            notice: z.string(),
            head: z.string(),
          })
          .parse(JSON.parse(attempt.mergeReceipt));
        if (
          mergedIntent.state === "blocked" ||
          mergedIntent.head !== attempt.head ||
          (mergeMode === "manual" &&
            !hasManualMergeApproval(attempt, {
              id: mergedIntent.notice,
              head: mergedIntent.head,
            }))
        )
          throw new Error(
            "The merged PR has no matching authorized exact-head intent; assess task criteria before completion",
          );
        await dependencies.networkGit(project.root, [
          "fetch",
          "origin",
          project.base.replace(/^origin\//u, ""),
        ]);
        const merged = (
          await dependencies.networkGit(project.root, [
            "rev-parse",
            "FETCH_HEAD",
          ])
        ).trim();
        const paths = (
          await dependencies.safeGit(project.root, cwd, [
            "diff",
            "--name-only",
            "-z",
            z.string().parse(attempt.base),
            z.string().parse(attempt.head),
          ])
        )
          .split("\0")
          .filter(Boolean);
        if (paths.length > 0)
          await dependencies.safeGit(project.root, cwd, [
            "diff",
            "--exit-code",
            z.string().parse(attempt.head),
            merged,
            "--",
            ...paths,
          ]);
        store.change(initial.id, (row) => {
          row.merged = merged;
          row.message =
            "Octo confirms the pinned PR merged; accepted changed paths are present in the fetched base";
        });
        return;
      }
      if (attempt.mergeReceipt !== undefined) {
        const retained = z
          .looseObject({
            state: z.string(),
            notice: z.string().optional(),
            head: z.string().optional(),
            entry: z.string().optional(),
            chain: z.string().optional(),
          })
          .parse(JSON.parse(attempt.mergeReceipt));
        if (retained.state === "requested") {
          const target = {
            id: z.string().parse(retained.notice),
            head: z.string().parse(retained.head),
          };
          if (
            target.head === attempt.head &&
            observed.pr.observation?.headSha === target.head &&
            (await mayRequestMerge(target))
          ) {
            await requestMerge(
              store,
              initial.id,
              directory,
              authority,
              observed.pr.url,
              target,
              identity,
              call,
            );
          }
        } else {
          const chain = z
            .object({
              entries: z.array(
                z.looseObject({
                  id: z.string(),
                  prId: z.string(),
                  state: z.string(),
                }),
              ),
              operations: z.array(
                z.looseObject({
                  entryId: z.string(),
                  kind: z.enum(["merge", "prepare"]),
                  state: z.enum([
                    "planned",
                    "running",
                    "succeeded",
                    "failed",
                    "uncertain",
                  ]),
                }),
              ),
            })
            .parse(
              await call(
                authority,
                "chain",
                "show",
                z.string().parse(retained.chain),
                "--full",
              ),
            );
          const entries = chain.entries.filter((entry) =>
            entry.id.startsWith(z.string().parse(retained.entry)),
          );
          const entry = entries[0];
          if (entries.length !== 1 || entry?.prId !== observed.pr.id)
            throw new Error("Merge-chain receipt no longer identifies this PR");
          const unresolved = chain.operations.some(
            (operation) =>
              operation.entryId === entry.id &&
              operation.kind === "merge" &&
              operation.state !== "failed",
          );
          if (
            !unresolved &&
            ["blocked", "waiting_owner", "cancelled"].includes(entry.state)
          ) {
            await writeFile(
              join(
                directory,
                `merge-settled-${createHash("sha256").update(attempt.mergeReceipt).digest("hex")}.json`,
              ),
              JSON.stringify(chain),
              { mode: 0o600 },
            );
            store.change(initial.id, (row) => {
              row.mergeReceipt = undefined;
              clearReadiness(row);
              row.message =
                "Octo confirms no active merge; retained assignment can assess new feedback";
            });
          }
        }
        // Never mutate a worker head while a merge may already be in flight.
        await dependencies.wait(signal);
        continue;
      }
      // Include delivered notices: read is a transport receipt, not proof of owner assessment.
      // A restart between read and assessment must see the same item again.
      let currentReady: Execution["readyNotice"];
      let after = 0;
      for (;;) {
        const inbox = z
          .object({
            messages: z.array(
              z.looseObject({
                id: z.string(),
                recipientAgentId: z.string(),
                applicable: z.boolean(),
                actionId: z.string().optional(),
                workflowPrId: z.string().optional(),
                readyHead: z.string().optional(),
              }),
            ),
            hasMore: z.boolean(),
            nextSequence: z.number().int().nonnegative(),
          })
          .parse(
            await call(
              authority,
              "agent",
              "inbox",
              "--applicable-only",
              "--include-acknowledged",
              "--after",
              String(after),
              ...identity,
            ),
          );
        for (const entry of inbox.messages) {
          if (
            !entry.applicable ||
            entry.recipientAgentId !== agent ||
            (entry.readyHead === undefined &&
              store.attempt(initial.id).events.includes(entry.id))
          )
            continue;
          // An agent can own multiple PRs. Inspect action subjects before consuming their delivery.
          if (
            entry.workflowPrId !== undefined &&
            entry.workflowPrId !== observed.pr.id
          )
            continue;
          if (entry.workflowPrId === undefined) {
            if (entry.actionId === undefined || entry.actionId === "") continue;
            const subject = shown.parse(
              await call(
                authority,
                "action",
                "show",
                entry.actionId,
                "--full",
                ...identity,
              ),
            ).action;
            if (
              subject.prId !== observed.pr.id ||
              subject.ownerAgentId !== agent
            )
              continue;
          }
          const message = notice.parse(
            await call(authority, "read", entry.id, ...identity),
          );
          let belongs = entry.workflowPrId === observed.pr.id;
          for (const item of message.message.items) {
            if (item.applicable === false || item.action === undefined)
              continue;
            const action = shown.parse(
              await call(
                authority,
                "action",
                "show",
                item.action.action.id,
                "--full",
                ...identity,
              ),
            ).action;
            if (action.prId === observed.pr.id && action.ownerAgentId === agent)
              belongs = true;
          }
          if (!belongs) continue;
          const current = store.attempt(initial.id);
          // Pi uses the native inbox receipt, whose readyHead is revalidated by mergeAgentMessage.
          if (
            entry.workflowPrId === observed.pr.id &&
            entry.readyHead !== undefined &&
            entry.readyHead === current.head &&
            !current.events.includes(`blocked:${entry.id}:${entry.readyHead}`)
          ) {
            currentReady = { id: entry.id, head: entry.readyHead };
          }
          store.change(initial.id, (row) => {
            if (!row.events.includes(entry.id)) row.events.push(entry.id);
          });
        }
        if (!inbox.hasMore) break;
        if (inbox.nextSequence <= after)
          throw new Error("Octo inbox cursor did not advance");
        after = inbox.nextSequence;
      }
      // Assess every current action before attesting owner readiness, including feedback whose
      // delivery has not reached the inbox yet. ACK alone never counts as assessment.
      const actions = z
        .object({ actions: z.array(z.looseObject({ id: z.string() })) })
        .parse(await call(authority, "action", "list", observed.pr.id));
      let corrected = false;
      let awaitingEvidence = false;
      for (const candidate of actions.actions) {
        const action = shown.parse(
          await call(
            authority,
            "action",
            "show",
            candidate.id,
            "--full",
            ...identity,
          ),
        ).action;
        if (action.prId !== observed.pr.id || action.ownerAgentId !== agent)
          throw new Error(
            "Octo returned an action outside this delivery owner/PR",
          );
        if (["resolved", "superseded"].includes(action.state)) continue;
        const evidence = JSON.stringify(action);
        const digest = createHash("sha256")
          .update(JSON.stringify([action.id, action.blocker]))
          .digest("hex");
        const assessed = `action:${action.id}:${digest}`;
        if (store.attempt(initial.id).events.includes(assessed)) continue;
        await writeFile(join(directory, `${digest}.json`), evidence, {
          mode: 0o600,
          flag: "wx",
        }).catch((error: unknown) => {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "EEXIST"
            )
          )
            throw error;
        });
        const current = store.attempt(initial.id);
        const blocker = action.blocker;
        if (blocker === undefined)
          throw new Error(
            "Full action evidence is missing; retain pending feedback",
          );
        let needsCorrection = true;
        if (blocker.case === "checkResults") {
          const result = checks.parse(blocker.value);
          if (result.headSha !== current.head) continue;
          if (result.checks.some((check) => check.headSha !== current.head))
            throw new Error("Mixed-head check evidence cannot be assessed");
          needsCorrection = result.checks.some(
            (check) =>
              check.status === "completed" &&
              !["success", "skipped", "neutral"].includes(check.conclusion),
          );
          if (result.checks.some((check) => check.status !== "completed")) {
            awaitingEvidence = true;
            continue;
          }
        } else if (["conflict", "checkFailed"].includes(blocker.case)) {
          const head = z
            .object({ headSha: z.string() })
            .parse(blocker.value).headSha;
          if (head !== current.head) continue;
        } else if (
          !["changesRequested", "reviewFeedback"].includes(blocker.case)
        ) {
          throw new Error(
            "Unsupported Octo action requires explicit assessment",
          );
        }
        if (needsCorrection) {
          const correction = `correction:${digest}`;
          if (!store.attempt(initial.id).events.includes(correction)) {
            if (
              store
                .attempt(initial.id)
                .events.filter((event) => event.startsWith("correction:"))
                .length >= 3
            )
              throw new Error(
                "Feedback correction budget exhausted; retained assignment needs review",
              );
            store.change(initial.id, (row) => {
              row.events.push(correction);
            });
          }
          const update = await correct(evidence);
          await pushCorrection(
            store,
            initial.id,
            project,
            update,
            dependencies,
          );
          corrected = true;
        }
        // Persist the actual assessment before acknowledging delivery/progress. A changed
        // feedback revision has a fresh source/action identity and cannot inherit this result.
        store.change(initial.id, (row) => {
          row.events.push(assessed);
        });
        await call(authority, "action", "ack", action.id, ...identity);
        if (corrected) break;
      }
      if (corrected) {
        await dependencies.wait(signal);
        continue;
      }
      attempt = store.attempt(initial.id);
      if (attempt.review === undefined)
        throw new Error("The current PR revision lacks independent review");
      const observation = observed.pr.observation;
      if (
        awaitingEvidence ||
        observation === undefined ||
        observation.headSha !== attempt.head ||
        observation.feedback?.state !== "complete" ||
        observation.reviews?.state !== "complete"
      ) {
        if (attempt.readyNotice !== undefined)
          store.change(initial.id, clearReadiness);
        await dependencies.wait(signal);
        continue;
      }
      // Re-attest when feedback changes on the same head. The full action sweep above
      // must precede readiness, which attests to Octo's complete feedback snapshot.
      const assessment = `assessed:${createHash("sha256")
        .update(
          JSON.stringify([
            attempt.head,
            observation.feedback,
            observation.reviews,
          ]),
        )
        .digest("hex")}`;
      if (!attempt.events.includes(assessment)) {
        await call(
          authority,
          "pr",
          "ready",
          observed.pr.id,
          "--head",
          z.string().parse(attempt.head),
          ...identity,
        );
        store.change(initial.id, (row) => {
          row.events.push(assessment);
          clearReadiness(row);
        });
        await dependencies.wait(signal);
        continue;
      }
      // Expose an operator prompt only after assessing this poll's applicable Ready receipt.
      const target = currentReady;
      store.change(initial.id, (row) => {
        if (
          target?.id !== row.readyNotice?.id ||
          target?.head !== row.readyNotice?.head
        )
          clearReadiness(row);
        row.readyNotice = target;
        if (
          mergeMode === "manual" &&
          target !== undefined &&
          !hasManualMergeApproval(row, target)
        )
          row.message = `Ready for operator approval: studio runtime approve-merge ${row.id} --head ${target.head}`;
      });
      if (
        target !== undefined &&
        target.head === attempt.head &&
        (await mayRequestMerge(target))
      ) {
        await requestMerge(
          store,
          initial.id,
          directory,
          authority,
          observed.pr.url,
          target,
          identity,
          call,
        );
      }
    }
    await dependencies.wait(signal);
  }
  throw new Error(
    "Delivery interrupted; retained receipts must be reconciled before retry",
  );
}
function clearReadiness(row: Execution): void {
  row.readyNotice = undefined;
  row.manualMergeApproval = undefined;
}

async function requestMerge(
  store: ExecutionStore,
  id: string,
  directory: string,
  authority: string,
  url: string,
  target: { id: string; head: string },
  identity: string[],
  call: OctoCall,
): Promise<void> {
  store.change(id, (row) => {
    row.mergeReceipt = JSON.stringify({
      notice: target.id,
      head: target.head,
      state: "requested",
    });
    row.message = "Pinned merge intent persisted before Octo submission";
  });
  // The native Pi request identity is exactly (inbox receipt ID, expected head).
  const receipt = await call(
    authority,
    "merge",
    target.id,
    "--expected-pr",
    url,
    "--expected-head",
    target.head,
    ...identity,
  );
  const evidence = JSON.stringify({ receipt });
  await writeFile(
    join(
      directory,
      `merge-response-${createHash("sha256").update(evidence).digest("hex")}.json`,
    ),
    evidence,
    { mode: 0o600 },
  );
  const accepted = z
    .looseObject({
      state: z.string(),
      pr: z.string(),
      entry: z.string().optional(),
      chain: z.string().optional(),
    })
    .parse(receipt);
  store.change(id, (row) => {
    row.mergeReceipt = JSON.stringify({
      ...accepted,
      notice: target.id,
      head: target.head,
    });
  });
  if (accepted.pr !== url)
    throw new Error(
      "Octo returned another merge subject; inspect the retained receipt",
    );
  if (accepted.state === "blocked") {
    await writeFile(
      join(
        directory,
        `merge-blocked-${createHash("sha256").update(target.id).digest("hex")}.json`,
      ),
      JSON.stringify(receipt),
      { mode: 0o600 },
    );
    store.change(id, (row) => {
      row.events.push(`blocked:${target.id}:${target.head}`);
      row.mergeReceipt = undefined;
      clearReadiness(row);
      row.message =
        "Pinned merge rejected; waiting for fresh Octo readiness evidence";
    });
  } else if (accepted.entry === undefined || accepted.chain === undefined)
    throw new Error(
      "Octo did not accept the pinned merge; inspect the retained receipt",
    );
}

async function pushCorrection(
  store: ExecutionStore,
  id: string,
  project: RuntimeProject,
  draft: DeliveryDraft & { head: string },
  dependencies: DeliveryDependencies,
): Promise<void> {
  const record = store.attempt(id);
  if (
    record.checkout === undefined ||
    record.head !== draft.head ||
    record.review === undefined
  )
    throw new Error(
      "Correction is not independently reviewed at the reported head",
    );
  await dependencies.networkGit(project.root, [
    "push",
    "origin",
    `${draft.head}:refs/heads/${record.checkout.branch}`,
  ]);
  store.change(id, (row) => {
    clearReadiness(row);
    row.mergeReceipt = undefined;
    row.message =
      "Reviewed correction pushed on the same PR; waiting for fresh check evidence";
  });
}
