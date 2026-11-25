import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseDocument,
  parsePlan,
  parseSpecification,
  renderDocument,
  renderPlan,
  renderSpecification,
} from "../documents/codec.ts";
import {
  DocumentKind,
  DocumentOwnerKind,
  documentRefSchema,
  type DocumentRef,
} from "../documents/model.ts";
import { documentRevision } from "../documents/revisions.ts";
import { TaskDelivery, draftSchema } from "../lead-plan.ts";
import {
  DecisionDisposition,
  specDraft,
  specRecord,
} from "../socrates/spec.ts";

const prose = [
  "Preserve **unsaved** work.",
  "",
  "## A heading inside the actual document",
  "",
  "~~~toml",
  'message = "This is an example, not task metadata"',
  "~~~",
].join("\n");

const specification = specDraft.parse({
  objective: "Review detailed documents in Neovim",
  scope: [prose, "Keep Studio as the owner"],
  requirements: [
    { id: "R1", outcome: "Save operator edits", acceptance: prose },
    {
      id: "R2",
      outcome: "Keep comments attributable",
      acceptance: "Return to the changed section",
    },
  ],
  decisions: [
    {
      id: "D1",
      decision: "Preview changes",
      basis: "decided",
      evidence: "Original instruction",
      disposition: DecisionDisposition.Superseded,
      uncertainty: "None",
    },
    {
      id: "D2",
      decision: "Update clean buffers directly",
      basis: "decided",
      evidence: "The operator selected direct updates",
      disposition: DecisionDisposition.Resolved,
      uncertainty: "Preserve dirty buffers",
      supersedes: "D1",
    },
  ],
  blockingQuestions: ["Which integration should ship first?", prose],
  coverage: {
    domains: ["engineering", "writing"],
    focus: "robustness",
    assessments: [
      { propertyId: "robustness", status: "partial", reason: prose },
      { propertyId: "audience", status: "unknown" },
    ],
  },
});

const plan = draftSchema.parse({
  summary: "Ship the real editor path",
  tasks: [
    {
      key: "documents",
      title: "Define the documents",
      description: prose,
      acceptance: "Saving changes the correct Studio record",
      blockedBy: [],
      requirements: ["R1"],
      owns: ["documents", "socrates/controls.ts"],
      check: ["bun", "test", "tests/documents-model.test.ts"],
      hold: false,
      delivery: TaskDelivery.PullRequest,
    },
    {
      key: "feedback",
      title: "Send anchored comments",
      description: "Keep the active conversation",
      acceptance: prose,
      blockedBy: ["documents"],
      requirements: ["R2"],
      owns: [],
      check: [],
      hold: true,
      delivery: TaskDelivery.Local,
    },
  ],
});

await test("the complete specification remains readable and round-trips embedded Markdown", () => {
  const markdown = renderSpecification(specification);
  assert.match(markdown, /## Objective\n\nReview detailed documents/u);
  assert.match(
    markdown,
    /### Evidence\n\nThe operator selected direct updates/u,
  );
  assert.match(markdown, /## Assessment robustness/u);
  assert.deepEqual(parseSpecification(markdown), specification);
  const edited = markdown.replace(
    "Save operator edits",
    "Save the latest operator edits",
  );
  assert.equal(
    parseSpecification(edited).requirements[0]?.outcome,
    "Save the latest operator edits",
  );
  assert.equal(
    renderSpecification({
      ...specification,
      objective: "A revised objective",
    }).split("\n")[1],
    markdown.split("\n")[1],
    "Ordinary content changes must not rewrite every field boundary",
  );
});

await test("plan prose edits and task metadata preserve every supported plan field", () => {
  const markdown = renderPlan(plan);
  assert.deepEqual(parsePlan(markdown), plan);
  assert.match(markdown, /blockedBy = \[ "documents" \]/u);
  const edited = markdown.replace(
    "Define the documents",
    "Implement editable documents",
  );
  const decoded = parsePlan(edited);
  assert.equal(decoded.tasks[0]?.title, "Implement editable documents");
  assert.deepEqual(decoded.tasks[0].check, [
    "bun",
    "test",
    "tests/documents-model.test.ts",
  ]);
  assert.deepEqual(decoded.tasks[1]?.blockedBy, ["documents"]);
});

await test("legacy specifications and empty optional collections do not acquire invented state", () => {
  const legacy = specRecord.shape.draft.unwrap().parse({
    objective: "Keep the original brief",
    scope: ["One document"],
    requirements: [
      { id: "R1", outcome: "Keep the brief", acceptance: "Same fields" },
    ],
    decisions: [
      { decision: "Use an editor", basis: "decided", evidence: "Operator" },
    ],
    blockingQuestions: [],
  });
  assert.deepEqual(parseSpecification(renderSpecification(legacy)), legacy);
  const empty = draftSchema.parse({ summary: "No tasks drafted", tasks: [] });
  assert.deepEqual(
    parseDocument(
      DocumentKind.Plan,
      renderDocument({ kind: DocumentKind.Plan, draft: empty }),
    ),
    {
      kind: DocumentKind.Plan,
      draft: empty,
    },
  );
});

await test("invalid metadata, unknown prose, and broken field boundaries are rejected", () => {
  const markdown = renderPlan(plan);
  assert.throws(
    () =>
      parsePlan(
        markdown.replace(
          'key = "documents"',
          'key = "documents"\napproved = true',
        ),
      ),
    /Unrecognized key/u,
  );
  assert.throws(
    () => parsePlan(`${markdown}\nNotes that would otherwise disappear`),
    /outside a document field/u,
  );
  assert.throws(
    () => parsePlan(markdown.replace(/<!-- \/studio:[a-f0-9]+ -->/u, "")),
    /Missing|Unknown|metadata/u,
  );
  assert.throws(
    () =>
      parsePlan(
        markdown.replace(
          'blockedBy = [ "documents" ]',
          'blockedBy = [ "missing" ]',
        ),
      ),
    /unknown|Unknown|missing/u,
  );
  assert.throws(
    () =>
      parseSpecification(
        renderSpecification(specification).replace(
          'supersedes = "D1"',
          'supersedes = "D7"',
        ),
      ),
    /superseded decisions/u,
  );
});

await test("edited metadata cannot silently replace prose or introduce approval fields", () => {
  const markdown = renderSpecification(specification);
  assert.throws(
    () =>
      parseSpecification(
        markdown.replace(
          'id = "R1"',
          'id = "R1"\noutcome = "Hidden replacement"',
        ),
      ),
    /Unrecognized key/u,
  );
  assert.throws(
    () =>
      parseSpecification(
        markdown.replace("## Objective", "## A new objective"),
      ),
    /Keep the field heading/u,
  );
  assert.throws(
    () =>
      parseSpecification(
        markdown.replace("domains = [", 'approvalAt = "now"\ndomains = ['),
      ),
    /Unrecognized key/u,
  );
});

const ref: DocumentRef = {
  ownerKind: DocumentOwnerKind.Discovery,
  ownerId: "discovery-a",
  conversationId: "conversation-a",
  project: "/workspace/project",
  kind: DocumentKind.Specification,
};

await test("revisions bind content and workflow state to the full owner identity", () => {
  const base = documentRevision(ref, specification, {
    frozen: false,
    revision: "brief-a",
  });
  assert.equal(
    base,
    documentRevision(
      { ...ref },
      { ...specification },
      { revision: "brief-a", frozen: false },
    ),
  );
  assert.notEqual(
    base,
    documentRevision(
      ref,
      { ...specification, objective: "A changed brief" },
      { frozen: false, revision: "brief-a" },
    ),
  );
  assert.notEqual(
    base,
    documentRevision(ref, specification, { frozen: true, revision: "brief-a" }),
  );
  assert.notEqual(
    base,
    documentRevision({ ...ref, ownerId: "discovery-b" }, specification, {
      frozen: false,
      revision: "brief-a",
    }),
  );
  assert.notEqual(
    base,
    documentRevision(
      { ...ref, conversationId: "conversation-b" },
      specification,
      { frozen: false, revision: "brief-a" },
    ),
  );
  assert.notEqual(
    base,
    documentRevision({ ...ref, project: "/workspace/other" }, specification, {
      frozen: false,
      revision: "brief-a",
    }),
  );
  assert.equal(
    documentRefSchema.safeParse({ ...ref, project: "relative" }).success,
    false,
  );
  assert.throws(() =>
    documentRevision(ref, specification, { count: Number.NaN }),
  );
});
