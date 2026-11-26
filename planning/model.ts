import { isAbsolute } from "node:path";
import { z } from "zod";
import type { LeadDraft } from "./plan.ts";
import type { LeadSpecification, assessedSpecDraft } from "../socrates/spec.ts";

export enum DocumentKind {
  Specification = "specification",
  Plan = "plan",
}

export enum DocumentOwnerKind {
  Discovery = "discovery",
  Attempt = "attempt",
}

export const documentRefSchema = z.strictObject({
  ownerKind: z.enum(DocumentOwnerKind),
  ownerId: z.string().min(1),
  conversationId: z.string().min(1),
  project: z
    .string()
    .refine(isAbsolute, "Use a canonical absolute project path"),
  kind: z.enum(DocumentKind),
});
export type DocumentRef = z.infer<typeof documentRefSchema>;
export type SpecificationDraft = NonNullable<LeadSpecification["draft"]>;
export type WritableSpecificationDraft = z.infer<typeof assessedSpecDraft>;
export type PlanDraft = LeadDraft;

export type EditableDocument =
  | { kind: DocumentKind.Specification; draft: SpecificationDraft }
  | { kind: DocumentKind.Plan; draft: PlanDraft };

export const documentSnapshotSchema = z.strictObject({
  ref: documentRefSchema,
  revision: z.string().regex(/^[a-f0-9]{64}$/u),
  markdown: z.string(),
  writable: z.boolean(),
  reason: z.string().optional(),
});
export type DocumentSnapshot = z.infer<typeof documentSnapshotSchema>;
