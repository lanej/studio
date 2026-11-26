import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Database } from "bun:sqlite";
import { HOST_CONFORMANCE_CASES } from "@lanej/copydesk/testing";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { registerDiscovery } from "../discovery/extension.ts";
import { ModelCapability, ReasoningLevel } from "../config.ts";
import { Discoveries, handoffDraft } from "../discovery/store.ts";
import { draftSchema, TaskDelivery } from "../lead-plan.ts";
import { registerPlanningDocuments, getPlanningDocuments } from "../planning/documents.ts";
import { renderPlan, renderSpecification } from "../planning/codec.ts";
import { DocumentKind, type DocumentSnapshot } from "../planning/model.ts";
import { coverageFresh, specificationToken } from "../socrates/assessment.ts";
import { readySpecification } from "./fixtures/socrates.ts";
import { SpecStatus } from "../socrates/spec.ts";
import { DocumentJournal, FeedbackState } from "../planning/feedback.ts";

const expectation = (id: keyof typeof HOST_CONFORMANCE_CASES) => `${id}: ${HOST_CONFORMANCE_CASES[id]}`;

await test(
  "native discovery document host guards both writers, save receipts, and queued owner identity",
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "studio-documents-host-"));
    const state = join(directory, "state");
    const project = join(directory, "project");
    const previous = process.env["STUDIO_STATE_DIR"];
    const store = new Discoveries(state);
    let api: ExtensionAPI | undefined;
    try {
      await mkdir(project);
      process.env["STUDIO_STATE_DIR"] = state;
      const session = SessionManager.inMemory(project);
      const agentDir = join(directory, "agent");
      const loader = new DefaultResourceLoader({
        cwd: project,
        agentDir,
        settingsManager: SettingsManager.inMemory(),
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
          (pi) => {
            registerPlanningDocuments(pi);
            api = pi;
            registerDiscovery(pi, () => undefined);
          },
        ],
      });
      await loader.reload();
      const { errors, extensions, runtime } = loader.getExtensions();
      assert.deepEqual(errors, []);
      const model = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
      });
      const runner = new ExtensionRunner(extensions, runtime, project, session, new ModelRegistry(model));
      runtime.appendEntry = (type, data) => {
        session.appendCustomEntry(type, data);
      };
      runtime.getThinkingLevel = () => "off";
      const ctx = runner.createToolContext("draft", undefined);
      const busy = { ...ctx, isIdle: () => false };
      const draftTool = runner.getToolDefinition("draft_implementation_plan");
      assert.ok(draftTool !== undefined && api !== undefined);
      const host = getPlanningDocuments(api);
      assert.ok(host !== undefined);
      const original = draftSchema.parse({
        summary: "Original proposal",
        tasks: [
          {
            key: "change",
            title: "Change",
            description: "A bounded change",
            acceptance: "Observe the result",
            assignment: {
              capability: ModelCapability.Standard,
              reasoning: ReasoningLevel.Low,
            },
          },
        ],
      });
      await draftTool.execute("initial", original, undefined, undefined, busy);
      host.capture(busy);
      const snapshot = (await host.sync()).documents[0];
      assert.ok(snapshot !== undefined);

      const operator = { ...original, summary: "Operator's accepted change" };
      const request = {
        operationId: randomUUID(),
        ref: snapshot.ref,
        expectedRevision: snapshot.revision,
        markdown: renderPlan(operator),
      };
      const authority = new Database(join(state, "discoveries.sqlite"));
      const journal = new Database(join(state, "documents.sqlite"));
      let accepted: DocumentSnapshot;
      try {
        journal.run(
          "CREATE TRIGGER reject_reservation BEFORE INSERT ON document_saves BEGIN SELECT RAISE(ABORT, 'simulated reservation failure'); END",
        );
        await assert.rejects(host.save(request), /simulated reservation failure/u);
        assert.equal(journal.query("SELECT record FROM document_saves WHERE id=?").get(request.operationId), null);
        assert.equal(
          store.get(snapshot.ref.ownerId).leadPlan.draft?.summary,
          original.summary,
          expectation("save.rollback_before_commit"),
        );
        journal.run("DROP TRIGGER reject_reservation");
        authority.run(
          "CREATE TRIGGER reject_witness BEFORE INSERT ON operation_witnesses BEGIN SELECT RAISE(ABORT, 'simulated witness write failure'); END",
        );
        await assert.rejects(host.save(request), /simulated witness write failure/u);
        assert.equal(
          store.get(snapshot.ref.ownerId).leadPlan.draft?.summary,
          original.summary,
          expectation("save.rollback_before_commit"),
        );
        assert.equal(
          authority.query("SELECT record FROM operation_witnesses WHERE operation_id=?").get(request.operationId),
          null,
        );
        authority.run("DROP TRIGGER reject_witness");
        journal.run(
          "CREATE TRIGGER lose_receipt BEFORE UPDATE ON document_saves BEGIN SELECT RAISE(ABORT, 'simulated lost receipt'); END",
        );
        await assert.rejects(host.save(request), /simulated lost receipt/u);
        assert.equal(
          store.get(snapshot.ref.ownerId).leadPlan.draft?.summary,
          operator.summary,
          expectation("save.lost_reply_after_commit"),
        );
        journal.run("DROP TRIGGER lose_receipt");
        accepted = await host.save(request);
        const incomplete = { ...request, operationId: randomUUID() };
        journal
          .query("INSERT INTO document_saves VALUES (?,?)")
          .run(incomplete.operationId, JSON.stringify({ request: incomplete }));
        await assert.rejects(
          host.save(incomplete),
          /historical receipt has no authoritative commit witness/u,
          expectation("save.incomplete_evidence"),
        );
        await assert.rejects(host.save({ ...request, operationId: randomUUID() }), /draft changed/u);
        assert.equal(store.get(snapshot.ref.ownerId).leadPlan.draft?.summary, operator.summary);
      } finally {
        authority.close();
        journal.close();
      }
      const reservations = new DocumentJournal(state);
      try {
        assert.throws(
          () =>
            reservations.save({
              ...request,
              ref: { ...request.ref, ownerId: randomUUID() },
            }),
          /operation ID already belongs/u,
        );
      } finally {
        reservations.close();
      }
      assert.equal(store.get(snapshot.ref.ownerId).leadPlan.draft?.summary, operator.summary);
      await assert.rejects(
        draftTool.execute(
          "stale",
          {
            ...original,
            summary: "Stale agent replacement",
            expectedRevision: snapshot.revision,
          },
          undefined,
          undefined,
          busy,
        ),
        /changed after the agent read/u,
      );
      assert.equal(store.get(snapshot.ref.ownerId).leadPlan.draft?.summary, operator.summary);
      assert.deepEqual(await host.save(request), accepted, "lost save reply reconciles to the original acceptance");
      await assert.rejects(host.save({ ...request, markdown: renderPlan(original) }), /operation ID already belongs/u);

      const read = runner.getToolDefinition("read_studio_documents");
      assert.ok(read !== undefined);
      // A single model batch can read B before trying to save a candidate prepared from A.
      // Executing its read must not silently retoken that already prepared candidate.
      await read.execute("read-before-stale-write", {}, undefined, undefined, busy);
      await assert.rejects(
        draftTool.execute(
          "stale-same-batch",
          {
            ...original,
            summary: "Candidate prepared before the read",
            expectedRevision: snapshot.revision,
          },
          undefined,
          undefined,
          busy,
        ),
        /changed after the agent read/u,
      );
      const agent = { ...original, summary: "Agent's recomputed proposal" };
      await draftTool.execute("fresh", { ...agent, expectedRevision: accepted.revision }, undefined, undefined, busy);
      assert.deepEqual(
        await host.save(request),
        accepted,
        "recovery returns the original witness after another writer advances the document",
      );
      assert.equal(store.get(snapshot.ref.ownerId).leadPlan.draft?.summary, agent.summary);
      await assert.rejects(
        host.save({
          ...request,
          operationId: randomUUID(),
          markdown: renderPlan({
            ...original,
            summary: "Old editor candidate",
          }),
        }),
        /draft changed/u,
      );
      assert.equal(store.get(snapshot.ref.ownerId).leadPlan.draft?.summary, agent.summary);
      host.capture(busy);
      const feedback = {
        requestId: randomUUID(),
        ref: snapshot.ref,
        baseRevision: accepted.revision,
        bufferIdentity: "unsaved-local-content",
        range: { startLine: 2, endLine: 3 },
        selectedText: "An unsaved selection",
        message: "Should this stay?",
      };
      const queued = await host.feedback(feedback);
      assert.equal(queued.state, FeedbackState.Queued);
      assert.equal((await host.feedback(feedback)).requestId, queued.requestId);
      await assert.rejects(host.feedback({ ...feedback, message: "Different message" }), /request ID already belongs/u);

      const other = store.create(project, session.getSessionId(), "Other discovery");
      session.appendCustomEntry("studio:discovery", {
        id: other.id,
        project: snapshot.ref.project,
        session: session.getSessionId(),
      });
      host.capture(busy);
      assert.equal((await host.sync()).feedback[0]?.state, FeedbackState.Parked);
      assert.equal(store.get(other.id).leadPlan.draft, null);
      await assert.rejects(host.save({ ...request, operationId: randomUUID() }), /no longer selected/u);
      session.appendCustomEntry("studio:discovery", {
        id: snapshot.ref.ownerId,
        project: snapshot.ref.project,
        session: session.getSessionId(),
      });
      host.capture(busy);
      assert.equal((await host.sync()).feedback[0]?.state, FeedbackState.Queued);
      await runner.emit({ type: "session_start", reason: "resume" });
      host.capture(busy);
      assert.equal(
        (await host.sync()).feedback[0]?.state,
        FeedbackState.Uncertain,
        "a restored activation must not silently resend queued work",
      );

      let delivered: string | undefined;
      runtime.sendUserMessage = (content) => {
        assert.equal(typeof content, "string");
        if (typeof content === "string") delivered = content;
      };
      const idle = {
        ...ctx,
        isIdle: () => true,
        hasPendingMessages: () => false,
      };
      host.capture(idle);
      const live = await host.feedback({
        ...feedback,
        requestId: randomUUID(),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.ok(delivered !== undefined);
      assert.equal(
        (await host.sync()).feedback.find((item) => item.requestId === live.requestId)?.state,
        FeedbackState.Dispatching,
        "sendUserMessage returning does not establish receipt",
      );
      await runner.emitBeforeAgentStart({ messageType: "user", prompt: delivered }, { cwd: project });
      assert.equal(
        (await host.sync()).feedback.find((item) => item.requestId === live.requestId)?.state,
        FeedbackState.Awaiting,
      );
      const outcome = runner.getToolDefinition("document_feedback_outcome");
      assert.ok(outcome !== undefined);
      await assert.rejects(
        async () =>
          outcome.execute("wrong", { requestId: "wrong", summary: "Not attributable" }, undefined, undefined, idle),
        /No matching active/u,
      );
      const responseDraft = {
        ...agent,
        summary: "Narrowed the scope after the highlighted comment",
      };
      await draftTool.execute(
        "revise",
        {
          ...responseDraft,
          expectedRevision: (await host.sync()).documents[0]?.revision,
        },
        undefined,
        undefined,
        idle,
      );
      const result = await outcome.execute(
        "outcome-call",
        { requestId: live.requestId, summary: "Narrowed the scope" },
        undefined,
        undefined,
        idle,
      );
      assert.equal(
        (await host.sync()).feedback.find((item) => item.requestId === live.requestId)?.state,
        FeedbackState.Awaiting,
        "the outcome needs a persisted native response event",
      );
      const message = {
        role: "assistant" as const,
        content: [
          {
            type: "toolCall" as const,
            id: "outcome-call",
            name: "document_feedback_outcome",
            arguments: {
              requestId: live.requestId,
              summary: "Narrowed the scope",
            },
          },
        ],
        api: "openai-completions" as const,
        provider: "fixture",
        model: "fixture",
        stopReason: "toolUse" as const,
        timestamp: 0,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const toolResult = {
        role: "toolResult" as const,
        toolCallId: "outcome-call",
        toolName: "document_feedback_outcome",
        content: result.content,
        isError: false,
        timestamp: 0,
      };
      const responseId = session.appendMessage(message);
      const resultId = session.appendMessage(toolResult);
      await runner.emitBoundary(
        {
          type: "turn_end",
          turnIndex: 0,
          outcome: "completed",
          message,
          toolResults: [toolResult],
          messageEntryId: responseId,
          toolResultEntryIds: [resultId],
        },
        () => ({
          contextEntries: [],
          contextMessages: [],
          llmMessages: [],
          pendingMessages: [],
          canContinue: false,
        }),
      );
      const answered = (await host.sync()).feedback.find((item) => item.requestId === live.requestId);
      assert.ok(answered !== undefined);
      assert.equal(answered.state, FeedbackState.Answered);
      assert.equal(answered.responseId, responseId);
      assert.equal(answered.changes.length, 1);
      assert.equal(answered.changes[0]?.afterRevision, (await host.sync()).documents[0]?.revision);
      assert.ok(
        (answered.changes[0]?.range?.endLine ?? Infinity) < renderPlan(responseDraft).split("\n").length,
        "outcome navigation identifies the changed section rather than the whole document",
      );
      await runner.emit({ type: "agent_settled", aborted: false });

      // A native prompt preflight can reject without before_agent_start or agent_settled.
      // Release its queue slot after bounded uncertainty, never silently resend it.
      host.capture(idle);
      const lost = await host.feedback({
        ...feedback,
        requestId: randomUUID(),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const lostPrompt = delivered;
      assert.equal(host.pending(), true);
      const discoveries = runner.getCommand("discoveries");
      assert.ok(discoveries !== undefined);
      await assert.rejects(
        discoveries.handler("", {
          ...runner.createCommandContext(),
          isIdle: () => true,
        }),
        /settle/u,
      );
      await new Promise((resolve) => setTimeout(resolve, 5100));
      assert.equal(host.pending(), false);
      assert.equal(
        (await host.sync()).feedback.find((item) => item.requestId === lost.requestId)?.state,
        FeedbackState.Uncertain,
      );
      assert.equal(delivered, lostPrompt, "uncertain feedback is never automatically replayed");

      // Even if a branch changes outside the guarded command, a late old prompt must
      // not inherit another owner's fresh revision and mutate that owner's document.
      session.appendCustomEntry("studio:discovery", {
        id: other.id,
        project: snapshot.ref.project,
        session: session.getSessionId(),
      });
      host.capture(idle);
      const successor = await host.feedback({
        ...feedback,
        requestId: randomUUID(),
        ref: { ...feedback.ref, ownerId: other.id },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const successorPrompt = delivered;
      assert.notEqual(successorPrompt, lostPrompt);
      await runner.emitBeforeAgentStart({ messageType: "user", prompt: lostPrompt }, { cwd: project });
      host.capture(idle);
      await assert.rejects(
        draftTool.execute("late-wrong-owner", original, undefined, undefined, idle),
        /no longer admitted/u,
      );
      assert.equal(store.get(other.id).leadPlan.draft, null);
      assert.equal(
        (await host.sync()).feedback.find((item) => item.requestId === successor.requestId)?.state,
        FeedbackState.Dispatching,
      );
      await runner.emit({ type: "agent_settled", aborted: true });
      await runner.emitBeforeAgentStart({ messageType: "user", prompt: successorPrompt }, { cwd: project });
      assert.equal(
        (await host.sync()).feedback.find((item) => item.requestId === successor.requestId)?.state,
        FeedbackState.Awaiting,
      );
      await runner.emit({ type: "agent_settled", aborted: true });

      store.change(other.id, (row) => {
        row.specification = {
          status: SpecStatus.Interrogating,
          version: 1,
          acceptedRevision: row.revision,
          draft: {
            objective: "Legacy",
            scope: ["Scope"],
            requirements: [{ id: "R1", outcome: "Outcome", acceptance: "Observe" }],
            decisions: [{ decision: "Preserve", basis: "decided", evidence: "Operator" }],
            blockingQuestions: [],
          },
        };
      });
      host.capture(busy);
      const legacy = (await host.sync()).documents[0];
      assert.ok(legacy !== undefined);
      assert.equal(legacy.writable, false);
      assert.match(legacy.reason ?? "", /legacy specification.*redraft/u);
      await assert.rejects(
        host.save({
          operationId: randomUUID(),
          ref: legacy.ref,
          expectedRevision: legacy.revision,
          markdown: legacy.markdown,
        }),
        /legacy specification.*redraft/u,
      );

      const reviewed = readySpecification(store.get(other.id).revision);
      const firstTask = original.tasks[0];
      assert.ok(firstTask !== undefined);
      const proposal = {
        ...original,
        tasks: [{ ...firstTask, requirements: ["R1"] }],
      };
      store.change(other.id, (row) => {
        row.specification = reviewed;
        row.leadPlan = { ...row.leadPlan, draft: proposal };
      });
      host.capture(busy);
      const documents = (await host.sync()).documents;
      const editablePlan = documents.find((item) => item.ref.kind === DocumentKind.Plan);
      assert.ok(editablePlan !== undefined);
      assert.equal(editablePlan.writable, true, "a discovery proposal is editable before freeze");
      const { assignment, ...unassigned } = firstTask;
      assert.ok(assignment !== undefined);
      for (const tasks of [
        [{ ...unassigned, requirements: ["R1"] }],
        [...proposal.tasks, { ...unassigned, key: "new-task" }],
      ]) {
        await assert.rejects(
          host.save({
            operationId: randomUUID(),
            ref: editablePlan.ref,
            expectedRevision: editablePlan.revision,
            markdown: renderPlan({ ...proposal, tasks }),
          }),
          /Specify worker capability and reasoning for task/u,
        );
      }
      const editedPlan = await host.save({
        operationId: randomUUID(),
        ref: editablePlan.ref,
        expectedRevision: editablePlan.revision,
        markdown: renderPlan({
          ...proposal,
          summary: "Operator revised the proposal",
        }),
      });
      const afterPlan = store.get(other.id);
      assert.equal(afterPlan.planSpecificationRevision, specificationToken(reviewed));
      assert.equal(afterPlan.leadPlan.draft?.tasks[0]?.delivery, TaskDelivery.Local);
      assert.ok(afterPlan.specification !== undefined);
      assert.equal(afterPlan.specification.coverageRevision, reviewed.coverageRevision);
      assert.equal(afterPlan.specification.pendingReview?.cause, "plan");
      assert.ok(!coverageFresh(afterPlan.specification, afterPlan.revision));
      await assert.rejects(
        host.save({
          operationId: randomUUID(),
          ref: editedPlan.ref,
          expectedRevision: editedPlan.revision,
          markdown: renderPlan({
            ...proposal,
            tasks: [{ ...firstTask, requirements: ["R99"] }],
          }),
        }),
        /current specification/u,
      );
      await assert.rejects(
        host.save({
          operationId: randomUUID(),
          ref: editedPlan.ref,
          expectedRevision: editedPlan.revision,
          markdown: renderPlan({
            ...proposal,
            tasks: [
              {
                ...firstTask,
                requirements: ["R1"],
                delivery: TaskDelivery.PullRequest,
              },
            ],
          }),
        }),
        /conflicts with decision/u,
      );
      const staleAssessment = host.capture(busy).find((item) => item.ref.kind === DocumentKind.Specification);
      assert.ok(staleAssessment !== undefined);
      await host.save({
        operationId: randomUUID(),
        ref: editedPlan.ref,
        expectedRevision: editedPlan.revision,
        markdown: renderPlan({
          ...proposal,
          summary: "Changed again while assessment was already stale",
        }),
      });
      const currentAssessment = host.capture(busy).find((item) => item.ref.kind === DocumentKind.Specification);
      assert.ok(currentAssessment !== undefined);
      assert.notEqual(
        staleAssessment.revision,
        currentAssessment.revision,
        "plan contents fence coverage proposals while an earlier review is pending",
      );
      const specificationTool = runner.getToolDefinition("draft_socrates_specification");
      assert.ok(specificationTool !== undefined);
      await runner.emitContext([]);
      await assert.rejects(
        specificationTool.execute(
          "stale-assessment",
          { ...reviewed.draft, expectedRevision: staleAssessment.revision },
          undefined,
          undefined,
          busy,
        ),
        /changed after the agent read/u,
      );
      await specificationTool.execute(
        "reassess",
        { ...reviewed.draft, expectedRevision: currentAssessment.revision },
        undefined,
        undefined,
        busy,
      );
      const editableSpec = host.capture(busy).find((item) => item.ref.kind === DocumentKind.Specification);
      assert.ok(editableSpec?.writable === true);
      await assert.rejects(
        host.save({
          operationId: randomUUID(),
          ref: editableSpec.ref,
          expectedRevision: editableSpec.revision,
          markdown: renderSpecification({
            ...reviewed.draft,
            coverage: undefined,
          }),
        }),
        /coverage/u,
      );
      await host.save({
        operationId: randomUUID(),
        ref: editableSpec.ref,
        expectedRevision: editableSpec.revision,
        markdown: renderSpecification({
          ...reviewed.draft,
          scope: ["Operator revised the scope"],
        }),
      });
      const afterSpec = store.get(other.id);
      assert.ok(afterSpec.specification !== undefined);
      assert.equal(
        afterSpec.specification.coverageRevision,
        undefined,
        "editor prose edits never certify inherited coverage",
      );
      assert.notEqual(
        afterSpec.planSpecificationRevision,
        specificationToken(afterSpec.specification),
        "a specification edit requires relinking the plan",
      );
      store.change(other.id, (row) => {
        assert.ok(row.specification !== undefined);
        row.specification.status = SpecStatus.Frozen;
        row.specification.approvalAt = new Date().toISOString();
      });
      const frozenDocuments = host.capture(busy);
      assert.equal(frozenDocuments.find((item) => item.ref.kind === DocumentKind.Specification)?.writable, false);
      assert.equal(frozenDocuments.find((item) => item.ref.kind === DocumentKind.Plan)?.writable, true);
      assert.throws(() => handoffDraft(store.get(other.id)), /Reassess properties/u);
      store.change(other.id, (row) => {
        row.specification = {
          ...reviewed,
          draft: { ...reviewed.draft, coverage: undefined },
        };
      });
      const historical = host.capture(busy).find((item) => item.ref.kind === DocumentKind.Specification);
      assert.ok(historical !== undefined);
      assert.equal(historical.writable, false);
      assert.match(historical.reason ?? "", /complete property assessment/u);
      host.dispose();
    } finally {
      if (api) getPlanningDocuments(api)?.dispose();
      store.close();
      if (previous === undefined) delete process.env["STUDIO_STATE_DIR"];
      else process.env["STUDIO_STATE_DIR"] = previous;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
