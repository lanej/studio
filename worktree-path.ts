import { z } from "zod";

export function worktreePathsOverlap(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

export const worktreeRelativePath = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      path
        .split("/")
        .every(
          (part) =>
            part !== "" && part !== ".." && part !== "." && part !== ".git",
        ) && !/[\\*?\p{Cc}]/u.test(path),
    "Use normalized worktree-relative paths",
  );
