import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { reviewRevision } from "../execution/review.ts";

const input = {
  task: "Preserve the eligibility rule at both limits",
  base: "base-revision",
  head: "worker-revision",
  changedPaths: ["rules.ts"],
  verification: {
    summary: "Controller verification",
    check: ["bun", "test"],
    gitHead: "worktree-parent",
    gitState: "verified-tree",
    output: "Observed both boundary cases passing",
    exitCode: 0,
  },
  workerReport: {
    summary: "author-summary",
    title: "author-title",
    body: "author-body",
  },
  feedback: ["prior reviewer interpretation"],
};

await test("a verdict cannot approve or reject a revision before the independent reading", async () => {
  for (const approved of [true, false]) {
    await assert.rejects(
      reviewRevision(input, () =>
        Promise.resolve({ approved, summary: "No independent evidence yet" }),
      ),
      /without recording an independent reading/u,
    );
  }
});

await test("each reviewer records one independent account before seeing author evidence", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "studio-review-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    sessionManager: SessionManager.inMemory(dir),
    settingsManager: SettingsManager.inMemory(),
  });
  t.after(() => {
    session.dispose();
  });
  const context = session.extensionRunner.createToolContext(
    "review",
    undefined,
  );
  const reading = {
    behavior: "rules.ts eligible() checks the upper bound first",
    changeSite:
      "rules.ts eligible() owns the threshold; keep equality inclusive",
  };

  for (const approved of [false, true]) {
    const verification = approved
      ? input.verification
      : {
          ...input.verification,
          check: [],
          exitCode: null,
          output: "",
          reason: "No executable check agreed",
        };
    const finalSummary = approved
      ? "Both boundary cases are explicit in eligible()"
      : "The lower bound is duplicated at both call sites";
    const review = await reviewRevision(
      { ...input, verification },
      async (prompt, tool) => {
        for (const clue of [
          ...Object.values(input.workerReport),
          ...input.feedback,
        ])
          assert(!prompt.includes(clue));
        for (const evidence of [
          input.task,
          input.base,
          input.head,
          ...input.changedPaths,
          JSON.stringify(verification),
        ])
          assert(prompt.includes(evidence));
        assert.equal(tool.name, "review_context");
        const record = (answers: typeof reading) =>
          tool.execute("reading", answers, undefined, undefined, context);
        for (const field of ["behavior", "changeSite"]) {
          await assert.rejects(
            async () => await record({ ...reading, [field]: "  " }),
          );
        }
        const released = await record(reading);
        assert.deepEqual(
          released.content.map((part) =>
            part.type === "text"
              ? (JSON.parse(part.text) as unknown)
              : undefined,
          ),
          [{ workerReport: input.workerReport, feedback: input.feedback }],
        );
        await assert.rejects(
          async () =>
            await record({ ...reading, behavior: input.workerReport.summary }),
          /already recorded/u,
        );
        return { approved, summary: finalSummary };
      },
    );
    assert.equal(review.approved, approved);
    assert.equal(review.summary, finalSummary);
    for (const answer of Object.values(reading))
      assert(review.readback.includes(answer));
  }
});
