export const APPLY_PATCH_GRAMMAR: string;
export const MAX_PATCH_BYTES: number;
export const patchSuccess: string;
export function parseApplyPatch(patch: string): {
  kind: "add" | "update" | "delete";
  path: string;
  reason: string;
  moveTo?: string;
}[];
