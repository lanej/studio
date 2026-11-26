import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { z } from "zod";
import { HOST_CONFORMANCE_CASES } from "@lanej/copydesk/testing";
import { Database } from "bun:sqlite";
import { create, equals, toJsonString } from "@bufbuild/protobuf";
import {
  CallContextSchema,
  DocumentSnapshotSchema,
  FeedbackCommandSchema,
  FeedbackState as WireFeedbackState,
  RejectionCode,
  SaveCommandSchema,
} from "@lanej/copydesk/protocol";
import {
  ProviderError,
  type SnapshotItem,
  type SnapshotReader,
} from "@lanej/copydesk";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { StudioDocumentProvider } from "../documents/provider.ts";
import { Discoveries } from "../discovery/store.ts";
import {
  registerPlanningDocuments,
  type PlanningDocuments,
} from "../planning/documents.ts";
import { DocumentJournal, FeedbackState } from "../planning/feedback.ts";
import { renderPlan } from "../planning/codec.ts";
import { DocumentOwnerKind } from "../planning/model.ts";
import { draftSchema } from "../planning/plan.ts";
const expectation = (id: keyof typeof HOST_CONFORMANCE_CASES) =>
  `${id}: ${HOST_CONFORMANCE_CASES[id]}`;

async function items(reader: SnapshotReader): Promise<SnapshotItem[]> {
  const result: SnapshotItem[] = [];
  try {
    for (
      let value = await reader.next();
      value !== undefined;
      value = await reader.next()
    )
      result.push(value);
  } finally {
    await reader.close();
  }
  return result;
}

await test("Studio provider retains atomic wire witnesses, immutable read views and generation-bound feedback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-provider-"));
  const state = join(directory, "state");
  const project = join(directory, "project");
  await mkdir(project);
  const previous = process.env["STUDIO_STATE_DIR"];
  process.env["STUDIO_STATE_DIR"] = state;
  const store = new Discoveries(state);
  let authority: PlanningDocuments | undefined;
  try {
    const session = SessionManager.inMemory(project);
    let selected = store.create(project, session.getSessionId(), "Draft").id;
    const initial = draftSchema.parse({ summary: "Original", tasks: [] });
    store.change(selected, (row) => {
      row.leadPlan.draft = initial;
    });
    let validate: (() => Promise<void>) | undefined;
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
          authority = registerPlanningDocuments(pi);
          authority.bind({
            current() {
              const id = selected;
              return {
                kind: DocumentOwnerKind.Discovery,
                id,
                project: store.get(id).project,
                conversationId: session.getSessionId(),
                read: () => store.get(id),
                changeWithWitness: (operationId, command, update, result) =>
                  store.changeWithWitness(
                    id,
                    operationId,
                    command,
                    update,
                    result,
                  ),
                validate: () => validate?.() ?? Promise.resolve(),
              };
            },
          });
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
    const runner = new ExtensionRunner(
      extensions,
      runtime,
      project,
      session,
      new ModelRegistry(model),
    );
    runtime.getThinkingLevel = () => "off";
    let feedbackDispatches = 0;
    runtime.sendUserMessage = () => {
      feedbackDispatches++;
    };
    assert.ok(authority !== undefined);
    const ctx = {
      ...runner.createToolContext("provider", undefined),
      isIdle: () => false,
    };
    authority.capture(ctx);
    const binding = authority.binding();
    assert.ok(binding !== undefined);
    const provider = new StudioDocumentProvider(authority, binding);
    const firstReader = await provider.openSnapshot(provider.context);
    const first = (
      await items(await provider.openSnapshot(provider.context))
    )[0];
    assert.ok(first?.kind === "document" && first.value.ref !== undefined);
    const command = create(SaveCommandSchema, {
      operationId: randomUUID(),
      ref: first.value.ref,
      expectedRevision: first.value.revision,
      text: renderPlan({ ...initial, summary: "Accepted" }),
    });
    const result = await provider.save(provider.context, command);
    assert.equal(result.result.case, "accepted");
    const accepted = result.result.value;
    assert.ok(accepted.document !== undefined);
    const oldItems = await items(firstReader);
    assert.equal(oldItems.length, 1);
    assert.ok(oldItems[0]?.kind === "document");
    assert.equal(
      oldItems[0].value.text,
      first.value.text,
      "the completed read view does not adopt a later write",
    );
    const database = new Database(join(state, "discoveries.sqlite"));
    try {
      const row = z
        .object({ record: z.string() })
        .parse(
          database
            .query(
              "SELECT record FROM operation_witnesses WHERE operation_id=?",
            )
            .get(command.operationId),
        );
      const witness = z
        .object({ id: z.string(), command: z.string(), result: z.string() })
        .parse(JSON.parse(row.record));
      assert.equal(witness.id, accepted.commitWitnessId);
      assert.equal(witness.command, toJsonString(SaveCommandSchema, command));
      assert.equal(
        z.object({ presentation: z.string() }).parse(JSON.parse(witness.result))
          .presentation,
        toJsonString(DocumentSnapshotSchema, accepted.document),
      );
    } finally {
      database.close();
    }
    store.change(selected, (row) => {
      row.leadPlan.draft = { ...initial, summary: "Intervening writer" };
    });
    assert.deepEqual(
      await provider.save(provider.context, command),
      result,
      expectation("save.intervening_writer"),
    );
    assert.equal(
      store.get(selected).leadPlan.draft?.summary,
      "Intervening writer",
    );
    const reused = await provider.save(
      provider.context,
      create(SaveCommandSchema, { ...command, text: `${command.text}\n` }),
    );
    assert.ok(reused.result.case === "rejected");
    assert.equal(
      reused.result.value.code,
      RejectionCode.OPERATION_ID_REUSED,
      expectation("save.id_reused"),
    );
    const identical = await provider.save(
      provider.context,
      create(SaveCommandSchema, {
        ...command,
        operationId: randomUUID(),
        text: renderPlan({ ...initial, summary: "Intervening writer" }),
      }),
    );
    assert.ok(identical.result.case === "rejected");
    assert.equal(
      identical.result.value.code,
      RejectionCode.CONFLICT,
      expectation("save.same_text_other_operation"),
    );
    const stale = await provider.save(
      provider.context,
      create(SaveCommandSchema, { ...command, operationId: randomUUID() }),
    );
    assert.ok(stale.result.case === "rejected");
    assert.equal(
      stale.result.value.code,
      RejectionCode.CONFLICT,
      expectation("save.stale_candidate"),
    );
    const feedback = create(FeedbackCommandSchema, {
      requestId: randomUUID(),
      ref: first.value.ref,
      baseRevision: first.value.revision,
      bufferIdentity: "unsaved-buffer",
      range: { startLine: 2, endLine: 3 },
      selectedText: "Actual unsaved selection",
      message: "  Question with intentional spacing  ",
    });
    const queued = await provider.submitFeedback(provider.context, feedback);
    assert.equal(queued.state, WireFeedbackState.QUEUED);
    assert.ok(
      queued.request !== undefined &&
        equals(FeedbackCommandSchema, queued.request, feedback),
      expectation("feedback.exact_unsaved_selection"),
    );
    assert.deepEqual(
      await provider.submitFeedback(provider.context, feedback),
      queued,
      expectation("feedback.duplicate_no_dispatch"),
    );
    await assert.rejects(
      provider.submitFeedback(
        provider.context,
        create(FeedbackCommandSchema, { ...feedback, message: "Different" }),
      ),
      ProviderError,
    );
    const journal = new DocumentJournal(state);
    try {
      assert.ok(feedback.ref !== undefined);
      const feedbackOwner = selected;
      selected = store.create(
        project,
        session.getSessionId(),
        "Other feedback owner",
      ).id;
      assert.deepEqual(
        await provider.submitFeedback(provider.context, feedback),
        queued,
        "an exact feedback retry recovers its receipt after owner selection changes",
      );
      assert.equal(
        feedbackDispatches,
        0,
        expectation("feedback.duplicate_no_dispatch"),
      );
      assert.equal(
        journal.list().filter((row) => row.requestId === feedback.requestId)
          .length,
        1,
      );
      await assert.rejects(
        provider.submitFeedback(
          provider.context,
          create(FeedbackCommandSchema, {
            ...feedback,
            message: "Changed after selection",
          }),
        ),
        (cause: unknown) =>
          cause instanceof ProviderError && cause.code === "already_exists",
      );
      await assert.rejects(
        provider.submitFeedback(
          provider.context,
          create(FeedbackCommandSchema, {
            ...feedback,
            ref: { ...feedback.ref, ownerId: `discovery:${selected}` },
          }),
        ),
        (cause: unknown) =>
          cause instanceof ProviderError && cause.code === "already_exists",
      );
      await assert.rejects(
        provider.submitFeedback(
          provider.context,
          create(FeedbackCommandSchema, {
            ...feedback,
            requestId: randomUUID(),
          }),
        ),
        (cause: unknown) =>
          cause instanceof ProviderError &&
          cause.code === "failed_precondition",
      );
      assert.deepEqual(
        journal.get(feedback.requestId).state,
        FeedbackState.Queued,
      );
      selected = feedbackOwner;
      const parked = { ...feedback, requestId: randomUUID() };
      await provider.submitFeedback(provider.context, parked);
      journal.change(parked.requestId, (row) => {
        row.state = FeedbackState.Parked;
        row.reason = "Owner changed";
      });
      const answered = { ...feedback, requestId: randomUUID() };
      await provider.submitFeedback(provider.context, answered);
      journal.change(answered.requestId, (row) => {
        row.state = FeedbackState.Answered;
        row.responseId = "persisted-turn";
        row.summary = "Answered";
      });
      const failed = { ...feedback, requestId: randomUUID() };
      await provider.submitFeedback(provider.context, failed);
      journal.change(failed.requestId, (row) => {
        row.state = FeedbackState.Failed;
        row.reason = "Confirmed preflight failure";
      });
      await runner.emit({ type: "session_start", reason: "startup" });
      authority.capture(ctx);
      await assert.rejects(
        provider.submitFeedback(provider.context, feedback),
        ProviderError,
      );
      await assert.rejects(
        async () =>
          await provider.openSnapshot(
            create(CallContextSchema, provider.context),
          ),
        ProviderError,
      );
      const nextBinding = authority.binding();
      assert.ok(nextBinding !== undefined);
      const next = new StudioDocumentProvider(authority, nextBinding);
      const records = (
        await items(await next.openSnapshot(next.context))
      ).filter((item) => item.kind === "feedback");
      assert.equal(
        records.find(
          (item) => item.value.request?.requestId === parked.requestId,
        )?.value.state,
        WireFeedbackState.UNCERTAIN,
      );
      assert.equal(
        records.find(
          (item) => item.value.request?.requestId === answered.requestId,
        )?.value.state,
        WireFeedbackState.ANSWERED,
        expectation("feedback.generation_terminal_preserved"),
      );
      assert.equal(
        records.find(
          (item) => item.value.request?.requestId === failed.requestId,
        )?.value.state,
        WireFeedbackState.FAILED,
        expectation("feedback.generation_terminal_preserved"),
      );
      const current = (await items(await next.openSnapshot(next.context))).find(
        (item) => item.kind === "document",
      );
      assert.ok(current?.kind === "document");
      let release: () => void = () => assert.fail("preflight was not entered");
      validate = () =>
        new Promise<void>((resolve) => {
          release = resolve;
        });
      const pending = next.save(
        next.context,
        create(SaveCommandSchema, {
          operationId: randomUUID(),
          ref: current.value.ref,
          expectedRevision: current.value.revision,
          text: renderPlan({ ...initial, summary: "Wrong owner candidate" }),
        }),
      );
      const originalOwner = selected;
      selected = store.create(
        project,
        session.getSessionId(),
        "Other owner",
      ).id;
      store.change(selected, (row) => {
        row.leadPlan.draft = {
          ...initial,
          summary: "Other owner remains current",
        };
      });
      const selectedBefore = store.get(selected);
      release();
      const rejected = await pending;
      assert.ok(rejected.result.case === "rejected");
      assert.equal(
        rejected.result.value.code,
        RejectionCode.WRONG_OWNER,
        expectation("owner.changed_during_preflight"),
      );
      assert.equal(
        store.get(originalOwner).leadPlan.draft?.summary,
        "Intervening writer",
      );
      const answeredBefore = journal.get(answered.requestId);
      const recoveredAnswer = await next.submitFeedback(next.context, answered);
      assert.equal(recoveredAnswer.state, WireFeedbackState.ANSWERED);
      assert.equal(recoveredAnswer.responseId, answeredBefore.responseId);
      assert.deepEqual(
        journal.get(answered.requestId),
        answeredBefore,
        "receipt recovery cannot alter terminal evidence or its original generation",
      );
      assert.equal(
        feedbackDispatches,
        0,
        expectation("feedback.duplicate_no_dispatch"),
      );
      assert.deepEqual(store.get(selected), selectedBefore);
      assert.deepEqual(
        await next.save(next.context, command),
        result,
        "an exact witnessed retry recovers its original acceptance after selection changes",
      );
      assert.deepEqual(
        store.get(selected),
        selectedBefore,
        "historical acceptance cannot edit the current owner",
      );
      const selectedView = (
        await items(await next.openSnapshot(next.context))
      ).find((item) => item.kind === "document");
      assert.ok(selectedView?.kind === "document");
      assert.match(selectedView.value.text, /Other owner remains current/u);
      assert.equal(
        store.get(originalOwner).leadPlan.draft?.summary,
        "Intervening writer",
      );
    } finally {
      journal.close();
    }
  } finally {
    authority?.dispose();
    store.close();
    if (previous === undefined) delete process.env["STUDIO_STATE_DIR"];
    else process.env["STUDIO_STATE_DIR"] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
