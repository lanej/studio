import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Attempt } from "../attempts.ts";
import type { OperationWitness } from "../operation-witness.ts";
import type { DocumentKind, DocumentOwnerKind } from "./model.ts";

export const documentReadTool = "read_studio_documents";
export const documentOutcomeTool = "document_feedback_outcome";

export interface DocumentState {
  id: string;
  revision: string | null;
  specification?: Attempt["specification"];
  leadPlan?: Attempt["leadPlan"];
  planSpecificationRevision?: string | undefined;
  approved?: string | undefined;
  handoff?: { phase: string } | undefined;
}
export interface DocumentOwner {
  kind: DocumentOwnerKind;
  id: string;
  project: string;
  conversationId: string;
  read(): DocumentState;
  changeWithWitness(
    operationId: string,
    command: string,
    update: (record: DocumentState) => void,
    result: (record: DocumentState) => string,
  ): OperationWitness;
  validate(ctx: ExtensionContext): Promise<void>;
}
export interface PlanningDocumentAuthority {
  current(ctx: ExtensionContext): DocumentOwner | undefined;
  changed?(ctx: ExtensionContext): void;
}
export interface DocumentPromptAdmission {
  prompt: string;
  feedback: boolean;
  admitted: boolean;
}

/** Planning policy remains available regardless of the optional editor integration. */
export interface PlanningDocumentHooks {
  bind(authority: PlanningDocumentAuthority): void;
  capture(ctx: ExtensionContext): void;
  pending(): boolean;
  assertAgent(kind: DocumentKind, record: DocumentState, ctx: ExtensionContext, expectedRevision?: string): void;
  committed(kind: DocumentKind, ctx: ExtensionContext): void;
  onPromptAdmission(listener: (admission: DocumentPromptAdmission, ctx: ExtensionContext) => void): () => void;
}
const hooks = new WeakMap<ExtensionAPI, PlanningDocumentHooks>();

export function installPlanningDocumentHooks(pi: ExtensionAPI, value: PlanningDocumentHooks): void {
  hooks.set(pi, value);
}

export function getPlanningDocumentHooks(pi: ExtensionAPI): PlanningDocumentHooks | undefined {
  return hooks.get(pi);
}

export function requirePlanningDocumentHooks(pi: ExtensionAPI): PlanningDocumentHooks {
  const value = hooks.get(pi);
  if (!value) throw new Error("Initialize Studio planning authority before its controls");
  return value;
}
