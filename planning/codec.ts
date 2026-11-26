import { createHash } from "node:crypto";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { z } from "zod";
import { draftSchema } from "./plan.ts";
import { savedCoverageSchema } from "../socrates/assessment.ts";
import { deliveryPolicySchema } from "../socrates/delivery-policy.ts";
import { isTrackedDecision, specDraft, specRecord } from "../socrates/spec.ts";
import { DocumentKind, type EditableDocument, type PlanDraft, type SpecificationDraft } from "./model.ts";

const specificationSchema = specRecord.shape.draft.unwrap();
const requirementMetadata = specDraft.shape.requirements.element.pick({
  id: true,
});
const decisionMetadata = specDraft.shape.decisions.element.omit({
  decision: true,
  evidence: true,
  uncertainty: true,
});
const legacyDecisionMetadata = decisionMetadata.pick({ basis: true });
const coverageMetadata = z.strictObject({
  domains: savedCoverageSchema.shape.domains,
  focus: savedCoverageSchema.shape.focus,
});
const assessmentMetadata = z.strictObject({
  propertyId: savedCoverageSchema.shape.assessments.element.shape.propertyId,
  status: savedCoverageSchema.shape.assessments.element.shape.status,
});
const planMergeMetadata = z.strictObject({
  pullRequestMerge: draftSchema.shape.pullRequestMerge.unwrap(),
});
const taskMetadata = draftSchema.shape.tasks.element.omit({
  title: true,
  description: true,
  acceptance: true,
});
const fence = String.fromCharCode(96).repeat(3);
const limit = 1024 * 1024;
type Field = { path: string; heading: string; body: string };

function heading(path: string, table?: Record<string, unknown>): string {
  const [group, number, field] = path.split("/");
  const id = z.string().optional().parse(table?.["id"]);
  const propertyId = z.string().optional().parse(table?.["propertyId"]);
  switch (group ?? "") {
    case "objective":
      return "## Objective";
    case "summary":
      return "## Summary";
    case "scope":
      return `## Scope ${number ?? ""}`;
    case "questions":
      return `## Open question ${number ?? ""}`;
    case "coverage":
      return "## Property assessment scope";
    case "delivery-policy":
      return "## Delivery policy";
    case "merge-policy":
      return "## Pull request merge policy";
    case "requirements":
      if (field === "metadata") return `## Requirement ${id ?? ""}`;
      break;
    case "decisions":
      if (field === "metadata") return `## Decision ${id ?? number ?? ""}`;
      break;
    case "assessments":
      if (field === "metadata") return `## Assessment ${propertyId ?? ""}`;
      break;
    case "tasks":
      if (field === "metadata") return `## Task ${number ?? ""}`;
      break;
    default:
      throw new Error(`Unknown document field: ${path}`);
  }
  const labels: Record<string, string> = {
    outcome: "Outcome",
    acceptance: "Acceptance",
    decision: "Decision",
    evidence: "Evidence",
    uncertainty: "Remaining uncertainty",
    reason: "Evidence or rationale",
    title: "Title",
    description: "Description",
  };
  const label = labels[field ?? ""];
  if (label === undefined) throw new Error(`Unknown document field: ${path}`);
  return `### ${label}`;
}

function checkHeading(field: Field, table?: Record<string, unknown>): void {
  const expected = heading(field.path, table);
  if (field.heading !== expected) throw new Error(`Keep the field heading ${expected} for ${field.path}`);
}

function metadata(value: unknown): string {
  return `${fence}toml\n${stringifyToml(value).trimEnd()}\n${fence}`;
}

function render(kind: DocumentKind, fields: Field[]): string {
  const content = fields.map(({ body }) => body).join("\n");
  let token = createHash("sha256").update(`studio-document:v1:${kind}`).digest("hex").slice(0, 16);
  while (content.includes(`studio:${token}`)) token = createHash("sha256").update(token).digest("hex").slice(0, 16);
  const title = kind === DocumentKind.Specification ? "Specification" : "Implementation plan";
  return [
    `# ${title}`,
    `<!-- studio-document:v1:${kind}:${token} -->`,
    "",
    ...fields.flatMap(({ path, heading, body }) => [
      `<!-- studio:${token}:${path} -->`,
      heading,
      "",
      body,
      `<!-- /studio:${token} -->`,
      "",
    ]),
  ].join("\n");
}

/** Boundaries keep headings and fenced examples inside prose from becoming fields. */
class Fields {
  private readonly values = new Map<string, Field>();
  constructor(markdown: string, kind: DocumentKind) {
    if (Buffer.byteLength(markdown) > limit) throw new Error("The document exceeds the 1 MiB editing limit");
    const lines = markdown.replaceAll("\r\n", "\n").split("\n");
    const title = kind === DocumentKind.Specification ? "# Specification" : "# Implementation plan";
    if (lines.shift() !== title) throw new Error(`Keep the document title: ${title}`);
    const header = /^<!-- studio-document:v1:(specification|plan):([a-f0-9]{16}) -->$/u.exec(lines.shift() ?? "");
    const token = header?.[2];
    if (header?.[1] !== kind || token === undefined)
      throw new Error("The Studio document format marker is missing or invalid");
    const start = `<!-- studio:${token}:`;
    const end = `<!-- /studio:${token} -->`;
    let index = 0;
    while (index < lines.length) {
      const line = lines[index] ?? "";
      if (line === "") {
        index += 1;
        continue;
      }
      if (!line.startsWith(start) || !line.endsWith(" -->"))
        throw new Error(`Text outside a document field at line ${String(index + 3)}`);
      const path = line.slice(start.length, -" -->".length);
      if (!/^[a-zA-Z0-9/-]+$/u.test(path) || this.values.has(path))
        throw new Error(`Invalid or repeated document field: ${path}`);
      const heading = lines[index + 1];
      if (heading === undefined || !/^#{2,4} /u.test(heading) || lines[index + 2] !== "")
        throw new Error(`Keep the heading and blank line for ${path}`);
      const close = lines.indexOf(end, index + 3);
      if (close === -1) throw new Error(`Missing closing boundary for ${path}`);
      const body = lines.slice(index + 3, close);
      if (body.some((entry) => entry.startsWith(start)))
        throw new Error(`Missing closing boundary before another field in ${path}`);
      this.values.set(path, {
        path,
        heading,
        body: body.join("\n"),
      });
      index = close + 1;
    }
  }

  private take(path: string): Field {
    const field = this.values.get(path);
    if (!field) throw new Error(`Missing document field: ${path}`);
    this.values.delete(path);
    return field;
  }

  text(path: string): string {
    const field = this.take(path);
    checkHeading(field);
    return field.body;
  }

  optionalText(path: string): string | undefined {
    return this.values.has(path) ? this.text(path) : undefined;
  }

  table(path: string): Record<string, unknown> {
    const field = this.take(path);
    const body = field.body;
    const open = `${fence}toml\n`;
    const close = `\n${fence}`;
    if (!body.startsWith(open) || !body.endsWith(close)) throw new Error(`Keep the TOML block for ${path}`);
    try {
      const table = parseToml(body.slice(open.length, -close.length));
      checkHeading(field, table);
      return table;
    } catch (cause) {
      throw new Error(`Invalid ${path} metadata`, { cause });
    }
  }

  optionalTable(path: string): Record<string, unknown> | undefined {
    return this.values.has(path) ? this.table(path) : undefined;
  }

  entries(prefix: string, suffix: string): string[] {
    const keys = [...this.values.keys()]
      .filter((key) => key.startsWith(`${prefix}/`) && key.endsWith(suffix))
      .map((key) => key.slice(prefix.length + 1, suffix.length === 0 ? undefined : -suffix.length));
    if (keys.some((key) => key.includes("/") || !/^[1-9]\d*$/u.test(key)))
      throw new Error(`Use numbered ${prefix} fields starting at 1`);
    keys.sort((left, right) => Number(left) - Number(right));
    if (keys.some((key, index) => Number(key) !== index + 1))
      throw new Error(`Keep ${prefix} field numbering consecutive`);
    return keys;
  }

  finish(): void {
    if (this.values.size !== 0) throw new Error(`Unknown document fields: ${[...this.values.keys()].join(", ")}`);
  }
}

function add(fields: Field[], path: string, heading: string, body: string): void {
  fields.push({ path, heading, body });
}

export function renderSpecification(value: SpecificationDraft): string {
  const draft = specificationSchema.parse(value);
  const fields: Field[] = [{ path: "objective", heading: "## Objective", body: draft.objective }];
  draft.scope.forEach((scope, index) => {
    add(fields, `scope/${String(index + 1)}`, `## Scope ${String(index + 1)}`, scope);
  });
  draft.requirements.forEach((requirement, index) => {
    const path = `requirements/${String(index + 1)}`;
    add(fields, `${path}/metadata`, `## Requirement ${requirement.id}`, metadata({ id: requirement.id }));
    add(fields, `${path}/outcome`, "### Outcome", requirement.outcome);
    add(fields, `${path}/acceptance`, "### Acceptance", requirement.acceptance);
  });
  draft.decisions.forEach((decision, index) => {
    const path = `decisions/${String(index + 1)}`;
    const tracked = isTrackedDecision(decision);
    add(
      fields,
      `${path}/metadata`,
      `## Decision ${tracked ? decision.id : String(index + 1)}`,
      metadata({
        basis: decision.basis,
        ...(tracked
          ? {
              id: decision.id,
              disposition: decision.disposition,
              ...(decision.supersedes === undefined ? {} : { supersedes: decision.supersedes }),
            }
          : {}),
      }),
    );
    add(fields, `${path}/decision`, "### Decision", decision.decision);
    add(fields, `${path}/evidence`, "### Evidence", decision.evidence);
    if (tracked) add(fields, `${path}/uncertainty`, "### Remaining uncertainty", decision.uncertainty);
  });
  if ("deliveryPolicy" in draft && draft.deliveryPolicy)
    add(fields, "delivery-policy", "## Delivery policy", metadata(draft.deliveryPolicy));
  draft.blockingQuestions.forEach((question, index) => {
    add(fields, `questions/${String(index + 1)}`, `## Open question ${String(index + 1)}`, question);
  });
  if ("coverage" in draft && draft.coverage) {
    const coverage = draft.coverage;
    add(
      fields,
      "coverage",
      "## Property assessment scope",
      metadata({
        domains: coverage.domains,
        ...(coverage.focus === undefined ? {} : { focus: coverage.focus }),
      }),
    );
    coverage.assessments.forEach((assessment, index) => {
      const path = `assessments/${String(index + 1)}`;
      add(
        fields,
        `${path}/metadata`,
        `## Assessment ${assessment.propertyId}`,
        metadata({
          propertyId: assessment.propertyId,
          status: assessment.status,
        }),
      );
      if (assessment.reason !== undefined)
        add(fields, `${path}/reason`, "### Evidence or rationale", assessment.reason);
    });
  }
  return render(DocumentKind.Specification, fields);
}

export function parseSpecification(markdown: string): SpecificationDraft {
  const fields = new Fields(markdown, DocumentKind.Specification);
  const objective = fields.text("objective");
  const scope = fields.entries("scope", "").map((index) => fields.text(`scope/${index}`));
  const requirements = fields.entries("requirements", "/metadata").map((index) => {
    const path = `requirements/${index}`;
    return {
      ...requirementMetadata.parse(fields.table(`${path}/metadata`)),
      outcome: fields.text(`${path}/outcome`),
      acceptance: fields.text(`${path}/acceptance`),
    };
  });
  const decisions = fields.entries("decisions", "/metadata").map((index) => {
    const path = `decisions/${index}`;
    const uncertainty = fields.optionalText(`${path}/uncertainty`);
    const table = fields.table(`${path}/metadata`);
    return {
      ...("id" in table ? decisionMetadata.parse(table) : legacyDecisionMetadata.parse(table)),
      decision: fields.text(`${path}/decision`),
      evidence: fields.text(`${path}/evidence`),
      ...(uncertainty === undefined ? {} : { uncertainty }),
    };
  });
  const blockingQuestions = fields.entries("questions", "").map((index) => fields.text(`questions/${index}`));
  const deliveryTable = fields.optionalTable("delivery-policy");
  const deliveryPolicy = !deliveryTable ? undefined : deliveryPolicySchema.parse(deliveryTable);
  const coverageTable = fields.optionalTable("coverage");
  let coverage: unknown;
  if (coverageTable) {
    coverage = {
      ...coverageMetadata.parse(coverageTable),
      assessments: fields.entries("assessments", "/metadata").map((index) => {
        const path = `assessments/${index}`;
        const reason = fields.optionalText(`${path}/reason`);
        return {
          ...assessmentMetadata.parse(fields.table(`${path}/metadata`)),
          ...(reason === undefined ? {} : { reason }),
        };
      }),
    };
  }
  fields.finish();
  return specificationSchema.parse({
    objective,
    scope,
    requirements,
    decisions,
    blockingQuestions,
    ...(!deliveryPolicy ? {} : { deliveryPolicy }),
    ...(coverage === undefined ? {} : { coverage }),
  });
}

export function renderPlan(value: PlanDraft): string {
  const draft = draftSchema.parse(value);
  const fields: Field[] = [{ path: "summary", heading: "## Summary", body: draft.summary }];
  if (draft.pullRequestMerge !== undefined)
    add(fields, "merge-policy", "## Pull request merge policy", metadata({ pullRequestMerge: draft.pullRequestMerge }));
  draft.tasks.forEach((task, index) => {
    const path = `tasks/${String(index + 1)}`;
    const { title, description, acceptance, ...options } = task;
    add(fields, `${path}/metadata`, `## Task ${String(index + 1)}`, metadata(options));
    add(fields, `${path}/title`, "### Title", title);
    add(fields, `${path}/description`, "### Description", description);
    add(fields, `${path}/acceptance`, "### Acceptance", acceptance);
  });
  return render(DocumentKind.Plan, fields);
}

export function parsePlan(markdown: string): PlanDraft {
  const fields = new Fields(markdown, DocumentKind.Plan);
  const summary = fields.text("summary");
  const mergeTable = fields.optionalTable("merge-policy");
  const mergePolicy = !mergeTable ? {} : planMergeMetadata.parse(mergeTable);
  const tasks = fields.entries("tasks", "/metadata").map((index) => {
    const path = `tasks/${index}`;
    return {
      ...taskMetadata.parse(fields.table(`${path}/metadata`)),
      title: fields.text(`${path}/title`),
      description: fields.text(`${path}/description`),
      acceptance: fields.text(`${path}/acceptance`),
    };
  });
  fields.finish();
  return draftSchema.parse({ summary, ...mergePolicy, tasks });
}

export function renderDocument(document: EditableDocument): string {
  switch (document.kind) {
    case DocumentKind.Specification:
      return renderSpecification(document.draft);
    case DocumentKind.Plan:
      return renderPlan(document.draft);
  }
}

export function parseDocument(kind: DocumentKind, markdown: string): EditableDocument {
  switch (kind) {
    case DocumentKind.Specification:
      return { kind, draft: parseSpecification(markdown) };
    case DocumentKind.Plan:
      return { kind, draft: parsePlan(markdown) };
  }
}
