import { createHash } from "node:crypto";
import { z } from "zod";
import { documentRefSchema, type DocumentRef } from "./model.ts";

type JsonValue = z.infer<ReturnType<typeof z.json>>;

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key] ?? null)}`)
    .join(",")}}`;
}

/** Include lifecycle guards: freezing can invalidate a save without changing prose. */
export function documentRevision(
  ref: DocumentRef,
  editableDraft: unknown,
  guardState: unknown,
): string {
  return createHash("sha256")
    .update(
      canonical(
        z.json().parse({
          ref: documentRefSchema.parse(ref),
          draft: editableDraft,
          guards: guardState,
        }),
      ),
    )
    .digest("hex");
}
