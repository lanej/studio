import { worktreePathsOverlap } from "../worktree-path.ts";
import { ExecutionPhase } from "./phase.ts";

interface PathOwner {
  readonly project: string;
  readonly owns: readonly string[];
}

interface AdmissionAttempt extends PathOwner {
  readonly id: string;
  readonly phase: ExecutionPhase;
  readonly bead?: unknown;
}

type OwnershipConflict =
  | { kind: "whole-checkout" }
  | { kind: "paths"; paths(): Iterable<PathMatch> };

interface PathMatch {
  readonly retained: string;
  readonly candidate: string;
}

function* matchingPaths(
  retained: readonly string[],
  candidate: readonly string[],
): Generator<PathMatch, void, unknown> {
  for (const left of retained)
    for (const right of candidate)
      if (worktreePathsOverlap(left, right))
        yield { retained: left, candidate: right };
}

/** An unspecified runtime scope reserves the whole checkout in its project. */
export function ownershipConflict(
  retained: PathOwner,
  candidate: PathOwner,
): OwnershipConflict | undefined {
  if (retained.project !== candidate.project) return undefined;
  const retainedPaths = retained.owns;
  const candidatePaths = candidate.owns;
  if (retainedPaths.length === 0 || candidatePaths.length === 0)
    return { kind: "whole-checkout" };
  const paths = () => matchingPaths(retainedPaths, candidatePaths);
  return paths().next().done === true ? undefined : { kind: "paths", paths };
}

/** Yield in queue order so scheduling can stop at the first retained path fence. */
export function* retainedConflicts<T extends AdmissionAttempt>(
  candidate: AdmissionAttempt,
  attempts: readonly T[],
): Generator<{ blocker: T; ownership: OwnershipConflict }, void, unknown> {
  const position = attempts.findIndex((row) => row.id === candidate.id);
  for (const [index, blocker] of attempts.entries()) {
    if (
      blocker.id === candidate.id ||
      blocker.bead === undefined ||
      blocker.phase === ExecutionPhase.Complete ||
      (blocker.phase === ExecutionPhase.Queued && index >= position)
    )
      continue;
    const ownership = ownershipConflict(blocker, candidate);
    if (ownership !== undefined) yield { blocker, ownership };
  }
}
