import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { StudioProfile } from "../config.ts";
import { deliverAssignment } from "../execution/delivery.ts";
import { networkGit, safeGit } from "../execution/git.ts";
import { assertPublicationHead, preparePublicationBase } from "../execution/publication-base.ts";
import { ExecutionPhase, ExecutionStore, executionSchema } from "../execution/store.ts";
import { projectSchema } from "../execution/target.ts";
import { TaskDelivery, draftSchema, planDigest } from "../planning/plan.ts";

const git = async (cwd: string, ...args: string[]) => (await networkGit(cwd, args)).trim();

async function commit(cwd: string, message: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) await writeFile(join(cwd, path), content);
  await git(cwd, "add", "--", ...Object.keys(files));
  await git(cwd, "commit", "--quiet", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

async function createPublishingFixture(directory: string, store: ExecutionStore) {
  const root = join(directory, "project");
  const remote = join(directory, "origin.git");
  await mkdir(root);
  await git(directory, "init", "--bare", "--initial-branch=main", remote);
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "user.name", "Studio test");
  await git(root, "config", "user.email", "studio@example.invalid");
  await git(root, "remote", "add", "origin", remote);
  const shared = (first: string, last: string) =>
    [first, ...Array.from({ length: 12 }, (_, i) => `line ${String(i + 1)}`), last, ""].join("\n");
  await commit(root, "Upstream", {
    "shared.txt": shared("upstream", "before"),
  });
  await git(root, "push", "origin", "main");
  await git(root, "switch", "-c", "local-work");
  const previous = await commit(root, "Previous discovery", {
    "private.txt": "Prior discovery only\n",
    "shared.txt": shared("private prior edit", "before"),
  });
  const sibling = await commit(root, "Independent local-only bead", {
    "sibling.txt": "Sibling only\n",
  });
  const prerequisite = await commit(root, "Reviewed prerequisite", {
    "shared.txt": shared("private prior edit", "approved"),
  });
  const projectId = randomUUID();
  const project = projectSchema.parse({
    id: projectId,
    root,
    source: { url: "http://127.0.0.1:9", projectId },
    profile: StudioProfile.Personal,
    base: "origin/main",
    beadsWorkspace: root,
    beadsDatabase: "fixture",
    merge: false,
  });
  const frontier = `refs/studio/projects/${project.id}`;
  await git(root, "update-ref", frontier, prerequisite);
  const graph = randomUUID();
  const draft = draftSchema.parse({
    summary: "Approved delivery graph",
    pullRequestMerge: "manual",
    tasks: [
      {
        key: "sibling",
        title: "Independent work",
        description: "Local-only file",
        acceptance: "Local result",
        owns: ["sibling.txt"],
      },
      {
        key: "prerequisite",
        title: "Prerequisite",
        description: "Update shared file",
        acceptance: "Approved last line",
        owns: ["shared.txt"],
      },
      {
        key: "publisher",
        title: "Publish result",
        description: "Ship the dependent file",
        acceptance: "PR includes the prerequisite",
        owns: ["publisher.txt"],
        blockedBy: ["prerequisite"],
        delivery: TaskDelivery.PullRequest,
      },
      {
        key: "follow-up",
        title: "Publish another result",
        description: "Ship the other dependent file",
        acceptance: "Use the current upstream prerequisite",
        owns: ["follow-up.txt"],
        blockedBy: ["prerequisite"],
        delivery: TaskDelivery.PullRequest,
      },
    ],
  });
  const digest = planDigest(draft);
  const rootId = "fixture-plan";
  const ids = Object.fromEntries(draft.tasks.map((task) => [task.key, `${rootId}.${task.key}`]));
  store.saveIntent(graph, {
    project: project.id,
    target: project,
    draft,
    digest,
    ids: { ...ids, root: rootId },
  });
  for (const task of draft.tasks) {
    const id = randomUUID();
    const publisher = task.delivery === TaskDelivery.PullRequest;
    const base = task.key === "prerequisite" ? sibling : previous;
    const head = task.key === "prerequisite" ? prerequisite : sibling;
    store.saveAttempt(
      executionSchema.parse({
        id,
        project: project.id,
        profile: project.profile,
        phase: publisher ? ExecutionPhase.Allocating : ExecutionPhase.Complete,
        bead: {
          id: ids[task.key],
          title: task.title,
          description: task.description,
          acceptance_criteria: task.acceptance,
          status: "in_progress",
          assignee: `pi:${id}`,
          revision: "accepted",
          metadata: {
            "studio.graph": graph,
            "studio.approval": digest,
            "studio.root": rootId,
            "studio.task": task,
            "studio.pullRequestMerge": draft.pullRequestMerge,
          },
        },
        revision: "accepted",
        owns: task.owns,
        controllerSession: randomUUID(),
        agent: randomUUID(),
        message: task.title,
        ...(publisher
          ? {}
          : {
              base,
              head,
              integration: head,
              integrationExpected: base,
              integrationReview: "Integration passed",
              review: "Independent review passed",
              resultRef: frontier,
            }),
      }),
    );
  }
  const reviewPublisher = async (key: string, branch: string, files: Record<string, string>) => {
    const attempt = store.attempts().find((row) => row.bead?.id === ids[key]);
    assert.ok(attempt !== undefined);
    const base = await preparePublicationBase(store, project, attempt);
    const checkout = join(directory, branch);
    await git(root, "worktree", "add", "-b", branch, checkout, base);
    const head = await commit(checkout, `Publishing ${key}`, files);
    const reviewed = store.change(attempt.id, (row) => {
      row.head = head;
      row.phase = ExecutionPhase.Delivery;
      row.review = "Independent review passed";
      row.checkout = {
        primary: root,
        root: directory,
        path: checkout,
        task_id: row.id,
        owner_id: row.id,
        agent: "studio",
        branch,
        created_at: new Date().toISOString(),
        base_ref: base,
      };
    });
    return { reviewed, head, checkout, base, branch };
  };
  const first = await reviewPublisher("publisher", "publish-selected-bead", {
    "publisher.txt": "Public result\n",
  });
  const reachedOcto = new Error("Stopped after real Git push");
  const publish = (candidate = first.reviewed) =>
    deliverAssignment(
      store,
      project,
      candidate,
      {
        title: "Publish accepted work",
        body: "Approved scope",
        summary: "Reviewed",
      },
      new AbortController().signal,
      () => assert.fail("Unexpected correction"),
      () => Promise.resolve(),
      (_, ...args) => {
        if (args[0] === "pr" && args[1] === "validate") return Promise.resolve({ valid: true });
        assert.deepEqual(args.slice(0, 2), ["pr", "publish"]);
        assert.equal(args[args.indexOf("--expected-head") + 1], candidate.head);
        throw reachedOcto;
      },
      {
        networkGit: (cwd, args) =>
          args[0] === "remote" && args[1] === "get-url"
            ? Promise.resolve("https://github.com/fixture/studio.git")
            : networkGit(cwd, args),
        safeGit,
        mergePolicy: () => assert.fail("Unexpected merge"),
        requireManualMergeAuthority: () => assert.fail("Unexpected merge"),
        wait: () => assert.fail("Unexpected poll"),
      },
    );
  await assert.rejects(publish(), (error: unknown) => error === reachedOcto);
  return {
    directory,
    root,
    remote,
    store,
    project,
    shared,
    previous,
    sibling,
    prerequisite,
    first,
    publish,
    reviewPublisher,
    reachedOcto,
  };
}

async function withPublishedBead(
  check: (fixture: Awaited<ReturnType<typeof createPublishingFixture>>) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "studio-publication-"));
  const store = new ExecutionStore(join(directory, "state"));
  try {
    await check(await createPublishingFixture(directory, store));
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test(
  "the published Git branch includes only approved prerequisites and the publishing bead",
  () =>
    withPublishedBead(
      async ({ directory, root, remote, store, project, shared, previous, sibling, prerequisite, first, publish }) => {
        const { reviewed, branch, checkout, head } = first;
        const published = `refs/heads/${branch}`;
        assert.equal(await git(remote, "rev-parse", published), head);
        assert.deepEqual((await git(remote, "diff", "--name-only", `main...${published}`)).split("\n"), [
          "publisher.txt",
          "shared.txt",
        ]);
        assert.equal(await git(remote, "show", `${published}:shared.txt`), shared("upstream", "approved").trimEnd());
        const commits = (await git(remote, "rev-list", `main..${published}`)).split("\n");
        for (const excluded of [previous, sibling, prerequisite])
          assert.ok(
            !commits.includes(excluded),
            "Raw project history must stay local even when an approved change touches the same path",
          );
        // A correction can have the expected reviewed tree while bringing in a private merge parent.
        const unrelatedParent = await git(
          checkout,
          "commit-tree",
          `${head}^{tree}`,
          "-p",
          head,
          "-p",
          sibling,
          "-m",
          "Retained correction",
        );
        assert.equal(await git(checkout, "diff", "--name-only", head, unrelatedParent), "");
        const corrected = store.change(reviewed.id, (row) => {
          row.head = unrelatedParent;
        });
        await assert.rejects(
          assertPublicationHead(store, project, corrected, unrelatedParent),
          /merge|history|parent/iu,
        );
        // A clean final tree alone also misses a private file committed and removed during correction.
        await commit(checkout, "Unowned work", { "unowned.txt": "Private\n" });
        await git(checkout, "rm", "unowned.txt");
        await git(checkout, "commit", "--quiet", "-m", "Restore approved tree");
        const linearHead = await git(checkout, "rev-parse", "HEAD");
        assert.equal(await git(checkout, "diff", "--name-only", head, linearHead), "");
        const linear = store.change(reviewed.id, (row) => {
          row.head = linearHead;
        });
        await assert.rejects(
          assertPublicationHead(store, project, linear, linearHead),
          /ownership|scope|unapproved|unreviewed/iu,
        );
        // A retained allocation created before scope isolation can still have an approved worker-only diff.
        const oldBranch = "retained-publisher";
        const oldCheckout = join(directory, "retained-worker");
        await git(root, "worktree", "add", "-b", oldBranch, oldCheckout, prerequisite);
        const oldHead = await commit(oldCheckout, "Retained publishing bead", {
          "publisher.txt": "Public result\n",
        });
        assert.equal(await git(root, "diff", "--name-only", prerequisite, oldHead), "publisher.txt");
        assert.ok(reviewed.checkout !== undefined);
        const oldId = randomUUID();
        const retained = executionSchema.parse({
          ...reviewed,
          id: oldId,
          base: prerequisite,
          head: oldHead,
          publicationBase: undefined,
          checkout: {
            ...reviewed.checkout,
            task_id: oldId,
            owner_id: oldId,
            branch: oldBranch,
            path: oldCheckout,
            base_ref: prerequisite,
          },
        });
        store.saveAttempt(retained);
        await assert.rejects(publish(retained), /PR publication ancestry/u);
        assert.equal(await git(remote, "for-each-ref", "--format=%(refname)", `refs/heads/${oldBranch}`), "");
      },
    ),
  30_000,
);

test(
  "a later publisher preserves upstream edits to a prerequisite squash-merged through a sibling PR",
  () =>
    withPublishedBead(async ({ root, remote, store, shared, first, reviewPublisher, publish, reachedOcto }) => {
      await git(root, "switch", "main");
      await git(root, "merge", "--squash", first.branch);
      await git(root, "commit", "--quiet", "-m", "Squash first publisher");
      const merged = await git(root, "rev-parse", "HEAD");
      assert.notEqual(merged, first.head);
      store.change(first.reviewed.id, (row) => {
        row.phase = ExecutionPhase.Complete;
        row.merged = merged;
      });
      const upstreamEdit = shared("upstream", "changed after squash merge");
      const target = await commit(root, "Revise the shipped prerequisite", {
        "shared.txt": upstreamEdit,
      });
      await git(root, "push", "origin", "main");
      const later = await reviewPublisher("follow-up", "publish-follow-up", {
        "follow-up.txt": "Follow-up result\n",
      });
      assert.equal(later.base, target);
      await assert.rejects(publish(later.reviewed), (error: unknown) => error === reachedOcto);
      const published = `refs/heads/${later.branch}`;
      assert.equal(await git(remote, "rev-parse", published), later.head);
      assert.equal(await git(remote, "show", `${published}:shared.txt`), upstreamEdit.trimEnd());
      assert.equal(await git(remote, "diff", "--name-only", `main...${published}`), "follow-up.txt");
    }),
  30_000,
);
