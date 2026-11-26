import { minimatch } from "minimatch";
import { parse } from "yaml";
import { readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";

const matrix = z.union([
  z.strictObject({ include: z.array(z.record(z.string(), z.string())) }),
  z.strictObject({ os: z.array(z.string()) }),
]);
const jobs = z.record(z.string(), z.object({ name: z.never().optional(), strategy: z.object({ matrix }) }));
const workflow = z.object({
  on: z.strictObject({
    push: z.object({
      branches: z.array(z.string()),
      paths: z.array(z.string()),
    }),
    pull_request: z.object({ paths: z.array(z.string()) }),
    workflow_dispatch: z.null(),
  }),
  jobs,
});
export const workflowFiles = ["check.yml", "lsp.yml", "beads.yml"] as const;
export type WorkflowFile = (typeof workflowFiles)[number];
const root = fileURLToPath(new URL("../", import.meta.url));

export async function readWorkflow(file: WorkflowFile) {
  return workflow.parse(parse(await readFile(resolve(root, ".github/workflows", file), "utf8")));
}

// The authored filters use only GitHub's literal, *, and ** path syntax.
// Reject extensions here rather than silently misreporting an Octo check policy.
export function matchesPaths(patterns: string[], paths: string[]): boolean {
  for (const path of paths) {
    if (path.length === 0 || path.startsWith("/") || path.includes("\\") || path.split("/").includes(".."))
      throw new Error(`CI input must be repository-relative: ${path}`);
  }
  const globs = patterns.map((pattern) => {
    if (!/^[a-zA-Z0-9_./*-]+$/u.test(pattern)) throw new Error(`Unsupported CI selection pattern: ${pattern}`);
    return pattern;
  });
  return globs.some((glob) =>
    paths.some((path) =>
      minimatch(path, glob, {
        dot: true,
        nonegate: true,
        nocomment: true,
        nobrace: true,
        noext: true,
      }),
    ),
  );
}

type Definition = { paths: string[] | null; jobs: z.infer<typeof jobs> };

function selection(paths: string[], head: Map<WorkflowFile, Definition>, base = new Map<WorkflowFile, Definition>()) {
  return [...head].flatMap(([file, definition]) => {
    const previous = base.get(file);
    if (
      definition.paths !== null &&
      !matchesPaths(definition.paths, paths) &&
      (!previous || (previous.paths !== null && !matchesPaths(previous.paths, paths)))
    )
      return [];
    const checks = Object.entries(definition.jobs).flatMap(([name, job]) => {
      const rows =
        "include" in job.strategy.matrix ? job.strategy.matrix.include : job.strategy.matrix.os.map((os) => ({ os }));
      return rows.map((row) => `${name} (${Object.values(row).join(", ")})`);
    });
    return [{ workflow: file, checks }];
  });
}

export async function selectedChecks(paths: string[]) {
  const files = await readdir(resolve(root, ".github/workflows"));
  requireManaged(files);
  const head = new Map<WorkflowFile, Definition>();
  for (const file of workflowFiles) {
    const value = await readWorkflow(file);
    head.set(file, { paths: value.on.pull_request.paths, jobs: value.jobs });
  }
  return selection(paths, head);
}

function requireManaged(files: string[]) {
  const unknown = files.find((file) => /\.ya?ml$/u.test(file) && !workflowFiles.some((managed) => managed === file));
  if (unknown !== undefined) throw new Error(`Unmapped CI workflow: ${unknown}`);
}

function revisionWorkflows(ref: string, cwd: string): Map<WorkflowFile, Definition> {
  // Resolve first: unknown refs/failed Git reads must never become a no-CI result.
  const sha = execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], {
    cwd,
    encoding: "utf8",
  }).trim();
  const present = execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", sha, "--", ".github/workflows"], {
    cwd,
    encoding: "utf8",
  }).split("\0");
  requireManaged(present.filter(Boolean).map((file) => file.replace(".github/workflows/", "")));
  const result = new Map<WorkflowFile, Definition>();
  for (const file of workflowFiles) {
    if (!present.includes(`.github/workflows/${file}`)) continue;
    const raw: unknown = parse(
      execFileSync("git", ["show", `${sha}:.github/workflows/${file}`], {
        cwd,
        encoding: "utf8",
      }),
    );
    const value = z
      .object({
        on: z.union([z.array(z.string()), z.record(z.string(), z.unknown())]),
        jobs,
      })
      .parse(raw);
    let paths: string[] | null = [];
    if (Array.isArray(value.on)) paths = value.on.includes("pull_request") ? null : [];
    else if ("pull_request" in value.on)
      paths =
        value.on["pull_request"] === null
          ? null
          : (z.object({ paths: z.array(z.string()).optional() }).parse(value.on["pull_request"]).paths ?? null);
    result.set(file, { paths, jobs: value.jobs });
  }
  return result;
}

export function revisionChecks(
  base: string,
  head: string,
  cwd = root,
  event: "pull_request" | "push" = "pull_request",
) {
  const commit = (ref: string) =>
    execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  base = commit(base);
  head = commit(head);
  let comparison = base;
  if (event === "pull_request") {
    comparison = execFileSync("git", ["merge-base", base, head], {
      cwd,
      encoding: "utf8",
    }).trim();
    const changedOnBase = changedPaths(comparison, base, cwd).filter(
      (file) => (file.startsWith(".github/workflows/") && /\.ya?ml$/u.test(file)) || file === "scripts/ci-selection.ts",
    );
    for (const file of changedOnBase) {
      const objectAt = (ref: string) =>
        execFileSync("git", ["ls-tree", "--format=%(objectname)", ref, "--", file], { cwd, encoding: "utf8" }).trim();
      if (objectAt(base) !== objectAt(head))
        throw new Error(`Sync current CI definitions before deriving check policy: ${file}`);
    }
  }
  const after = revisionWorkflows(head, cwd);
  if (after.size === 0) throw new Error("No managed CI workflows exist at the requested head");
  return selection(changedPaths(comparison, head, cwd), after, revisionWorkflows(base, cwd));
}

export function changedPaths(base: string, head: string, cwd = root): string[] {
  // Treat a rename as delete + add, preserving both old and new owners.
  return execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", base, head, "--"], {
    cwd,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

if (import.meta.main) {
  let args = process.argv.slice(2);
  let event: "pull_request" | "push" = "pull_request";
  if (args[0] === "--event") {
    event = z.enum(["pull_request", "push"]).parse(args[1]);
    args = args.slice(2);
  }
  let paths: string[];
  if (args[0] === "--base" && args[2] === "--head" && args.length === 4) {
    const base = args[1];
    const head = args[3];
    if (base === undefined || head === undefined) throw new Error("Both revisions are required");
    console.log(JSON.stringify(revisionChecks(base, head, root, event), null, 2));
    process.exit(0);
  } else if (args.length > 0 && args.every((path) => !path.startsWith("--"))) paths = args;
  else
    throw new Error("Usage: bun scripts/ci-selection.ts PATH... | [--event pull_request|push] --base BASE --head HEAD");
  console.log(JSON.stringify(await selectedChecks(paths), null, 2));
}
