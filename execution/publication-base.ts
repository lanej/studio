import { processFailure } from "../process.ts";
import { networkGit, projectObjectGit, safeGit } from "./git.ts";
import { publicationPrerequisites } from "./publication-graph.ts";
import type { Execution, ExecutionStore, RuntimeProject } from "./store.ts";

type Git = (args: string[]) => Promise<string>;
type Proof = NonNullable<Execution["publicationBase"]>;
type Receipt = Proof["prerequisites"][number];

function sha(value: string | undefined): string {
  if (value === undefined || !/^[a-f0-9]{40}$/u.test(value))
    throw new Error("PR publication requires exact Git commit and tree identities");
  return value;
}

export function publicationTarget(project: RuntimeProject): string {
  return project.base.replace(/^origin\//u, "");
}

/** Each allocation owns its fetched ref. Parallel fetches cannot change its readback. */
export async function fetchPublicationTarget(
  project: RuntimeProject,
  attemptId: string,
  git: typeof networkGit = networkGit,
): Promise<string> {
  const source = `refs/heads/${publicationTarget(project)}`;
  const target = `refs/studio/publication-targets/${attemptId}`;
  await git(project.root, ["check-ref-format", source]);
  await git(project.root, ["fetch", "--no-tags", "--no-write-fetch-head", "origin", `+${source}:${target}`]);
  return sha((await git(project.root, ["rev-parse", "--verify", `${target}^{commit}`])).trim());
}

async function isAncestor(git: Git, base: string, head: string): Promise<boolean> {
  try {
    await git(["merge-base", "--is-ancestor", sha(base), sha(head)]);
    return true;
  } catch (error) {
    if (processFailure(error).code === 1) return false;
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function requireAncestor(git: Git, base: string, head: string): Promise<void> {
  if (!(await isAncestor(git, base, head)))
    throw new Error("PR publication ancestry differs from the approved checkout base or remote target");
}

async function checkPaths(git: Git, before: string, after: string, owns: string[]): Promise<void> {
  if (owns.length === 0) return;
  const paths = await git(["diff", "--no-renames", "--name-only", "-z", before, after]);
  requireOwnedPaths(paths, owns);
}

function requireOwnedPaths(output: string, owns: string[]): void {
  const paths = output.split("\0");
  if (paths.some((path) => path !== "" && !owns.some((owned) => path === owned || path.startsWith(`${owned}/`))))
    throw new Error("PR changes exceed accepted path ownership");
}

async function projectBase(
  store: ExecutionStore,
  project: RuntimeProject,
  attempt: Execution,
  remote: string,
  git: Git,
  proof?: Proof,
): Promise<{ base: string; publicationBase: Proof }> {
  let tip = remote;
  const receipts: Receipt[] = [];
  const published = store
    .attempts()
    .filter(
      (record) => record.project === project.id && record.merged !== undefined && record.publicationBase !== undefined,
    );
  for (const task of publicationPrerequisites(store, project, attempt)) {
    if (task.merged !== undefined) {
      await requireAncestor(git, task.merged, remote);
      continue;
    }
    // The completed integration can include a reviewed repair. Subtract the exact
    // frontier it replaced, including concurrent siblings, before replaying it.
    const before = sha(task.integrationExpected ?? task.base);
    const after = sha(task.integration);
    await requireAncestor(git, sha(task.base), before);
    await requireAncestor(git, before, after);
    await requireAncestor(git, sha(task.head), after);
    await checkPaths(git, before, after, task.owns);
    const receipt = proof?.prerequisites[receipts.length];
    if (proof && (receipt?.id !== task.id || receipt.before !== before || receipt.after !== after))
      throw new Error("PR prerequisite provenance differs from the approved graph");

    // A sibling PR may already have squash-merged this exact local prerequisite.
    // Its accepted remote receipt survives later edits and reversions on the target.
    let included = await isAncestor(git, after, remote);
    for (const record of published) {
      if (included) break;
      if (
        record.publicationBase?.prerequisites.some(
          (entry) => entry.id === task.id && entry.before === before && entry.after === after,
        ) === true
      )
        included = await isAncestor(git, sha(record.merged), remote);
    }
    if (!included) {
      const tree = sha(
        (await git(["merge-tree", "--write-tree", "-Xno-renames", `--merge-base=${before}`, tip, after])).trim(),
      );
      const previousTree = sha((await git(["rev-parse", `${tip}^{tree}`])).trim());
      if (tree !== previousTree) {
        await checkPaths(git, previousTree, tree, task.owns);
        if (receipt) {
          const commit = sha(receipt.commit);
          const parents = (await git(["rev-parse", `${commit}^@`])).trim();
          const storedTree = (await git(["rev-parse", `${commit}^{tree}`])).trim();
          if (parents !== tip || storedTree !== tree)
            throw new Error("PR prerequisite commit differs from its authorized tree or parent");
          tip = commit;
        } else {
          tip = sha(
            (
              await git([
                "commit-tree",
                tree,
                "-p",
                tip,
                "-m",
                `Include accepted prerequisite ${task.bead?.id ?? task.id}`,
              ])
            ).trim(),
          );
        }
      }
    }
    if (receipt && receipt.commit !== tip)
      throw new Error("PR prerequisite commit differs from its authorized projection");
    receipts.push({ id: task.id, before, after, commit: tip });
  }
  if (proof && receipts.length !== proof.prerequisites.length)
    throw new Error("PR publication contains prerequisites outside the approved graph");
  return { base: tip, publicationBase: { remote, prerequisites: receipts } };
}

export async function preparePublicationBase(
  store: ExecutionStore,
  project: RuntimeProject,
  attempt: Execution,
): Promise<string> {
  const remote = await fetchPublicationTarget(project, attempt.id);
  const result = await projectBase(store, project, attempt, remote, (args) => projectObjectGit(project.root, args));
  // Keep synthetic commits reachable if allocation is interrupted before the worker branch exists.
  await projectObjectGit(project.root, ["update-ref", `refs/studio/publication-bases/${attempt.id}`, result.base]);
  store.change(attempt.id, (row) => {
    row.base = result.base;
    row.publicationBase = result.publicationBase;
  });
  return result.base;
}

/** Prove the pinned remote, every projected delta, and the worker's linear ancestry before each push. */
export async function assertPublicationHead(
  store: ExecutionStore,
  project: RuntimeProject,
  attempt: Execution,
  head: string,
  adapters = { networkGit, safeGit },
): Promise<void> {
  const checkout = attempt.checkout;
  if (!checkout || attempt.project !== project.id || attempt.head !== sha(head) || attempt.review === undefined)
    throw new Error("PR publication requires the independently reviewed worker head");
  const git: Git = (args) => adapters.safeGit(project.root, checkout.path, args);
  const base = sha(attempt.base);
  const remote = await fetchPublicationTarget(project, attempt.id, adapters.networkGit);
  const proof = attempt.publicationBase;
  if (proof) {
    await requireAncestor(git, proof.remote, remote);
    const result = await projectBase(store, project, attempt, proof.remote, git, proof);
    if (result.base !== base) throw new Error("PR checkout does not descend from the approved prerequisite projection");
  } else {
    // Retained pre-upgrade allocations can resume when all inherited history
    // already belongs to the target. Never publish an unproven local frontier.
    await requireAncestor(git, base, remote);
    for (const task of publicationPrerequisites(store, project, attempt))
      await requireAncestor(git, sha(task.merged ?? task.integration), base);
  }
  await requireAncestor(git, base, head);
  if ((await git(["rev-list", "--min-parents=2", "--max-count=1", `${base}..${head}`])).trim() !== "")
    throw new Error("PR worker history contains an unapproved merge parent");
  if (attempt.owns.length > 0) {
    // Inspect intermediate revisions too. A later deletion cannot retract a blob
    // once a parent commit containing it has been sent to the remote.
    const paths = await git([
      "log",
      "--format=",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--name-only",
      "-z",
      `${base}..${head}`,
    ]);
    requireOwnedPaths(paths, attempt.owns);
  }
}
