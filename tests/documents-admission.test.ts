import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { z } from "zod";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { registerDiscovery } from "../discovery/extension.ts";
import { Discoveries } from "../discovery/store.ts";
import { getDocumentHost, revisionFor } from "../documents/host.ts";
import { FeedbackState } from "../documents/feedback.ts";
import { draftSchema } from "../lead-plan.ts";
import { renderPlan } from "../documents/codec.ts";
import { DocumentKind, documentSnapshotSchema } from "../documents/model.ts";
import { coverageFresh } from "../socrates/assessment.ts";
import { readySpecification } from "./fixtures/socrates.ts";

function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {
    throw new Error("Gate not initialized");
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

await test(
  "native pending feedback cannot switch discovery or reach the provider with another owner",
  { timeout: 10000 },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "studio-document-admission-"),
    );
    const state = join(directory, "state");
    const agentDir = join(directory, "agent");
    const previous = process.env["STUDIO_STATE_DIR"];
    let requests = 0;
    let providerEdit: (() => Promise<void>) | undefined;
    let batch: { id: string; name: string; arguments: object }[] = [];
    let respond: ((payload: unknown) => typeof batch) | undefined;
    let nextSettled: (() => void) | undefined;
    const server = createServer((request, response) => {
      const chunks: string[] = [];
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        chunks.push(chunk);
      });
      request.on("end", () => {
        requests += 1;
        const payload: unknown = JSON.parse(chunks.join(""));
        const calls = respond?.(payload) ?? batch;
        respond = undefined;
        batch = [];
        response.writeHead(200, { "content-type": "text/event-stream" });
        const delta =
          calls.length === 0
            ? { role: "assistant", content: "Ready" }
            : {
                role: "assistant",
                tool_calls: calls.map((call, index) => ({
                  index,
                  id: call.id,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.arguments),
                  },
                })),
              };
        response.end(
          `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "tiny", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "tiny", choices: [{ index: 0, delta: {}, finish_reason: calls.length === 0 ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const store = new Discoveries(state);
    let api: ExtensionAPI | undefined;
    const entered = gate();
    const release = gate();
    const settled = gate();
    const discarded = gate();
    let discardFeedback = false;
    try {
      await mkdir(agentDir);
      await writeFile(
        join(agentDir, "models.json"),
        JSON.stringify({
          providers: {
            fixture: {
              baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
              api: "openai-completions",
              apiKey: "fixture",
              models: [{ id: "tiny", reasoning: false }],
            },
          },
        }),
      );
      process.env["STUDIO_STATE_DIR"] = state;
      const services = await createAgentSessionServices({
        cwd: directory,
        agentDir,
        settingsManager: SettingsManager.inMemory(
          {
            defaultProvider: "fixture",
            defaultModel: "tiny",
            defaultThinkingLevel: "off",
          },
          { projectTrusted: true },
        ),
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          extensionFactories: [
            (pi) => {
              api = pi;
              registerDiscovery(pi, () => undefined);
              pi.on("input", async (event) => {
                if (event.text.startsWith("Studio document feedback ")) {
                  if (discardFeedback) {
                    discarded.resolve();
                    return { action: "handled" };
                  }
                  entered.resolve();
                  await release.promise;
                }
                return { action: "continue" };
              });
              pi.on("agent_settled", () => {
                settled.resolve();
                nextSettled?.();
                nextSettled = undefined;
              });
              pi.on("before_provider_request", async () => {
                const edit = providerEdit;
                providerEdit = undefined;
                await edit?.();
              });
            },
          ],
        },
      });
      const manager = SessionManager.inMemory(directory);
      const { session } = await createAgentSessionFromServices({
        services,
        sessionManager: manager,
      });
      try {
        await session.bindExtensions({ mode: "rpc" });
        assert.ok(api !== undefined);
        const host = getDocumentHost(api);
        assert.ok(host !== undefined);
        const ctx = session.extensionRunner.createToolContext(
          "initial",
          undefined,
        );
        const draft = session.getToolDefinition("draft_implementation_plan");
        assert.ok(draft !== undefined);
        await draft.execute(
          "initial",
          {
            summary: "Original owner",
            tasks: [
              {
                key: "change",
                title: "Change",
                description: "Small change",
                acceptance: "Observe",
              },
            ],
          },
          undefined,
          undefined,
          ctx,
        );
        host.capture(ctx);
        const document = (await host.sync()).documents[0];
        assert.ok(document !== undefined);
        const feedback = await host.feedback({
          requestId: randomUUID(),
          ref: document.ref,
          baseRevision: document.revision,
          bufferIdentity: "editor",
          range: { startLine: 1, endLine: 1 },
          selectedText: "Original owner",
          message: "Refine this",
        });
        await entered.promise;
        assert.equal(
          ctx.isIdle(),
          true,
          "native prompt input hooks precede the busy state",
        );
        assert.equal(host.pending(), true);
        const select = session.extensionRunner.getCommand("discoveries");
        assert.ok(select !== undefined);
        await assert.rejects(
          select.handler("", session.extensionRunner.createCommandContext()),
          /settle/u,
        );
        const other = store.create(
          directory,
          manager.getSessionId(),
          "Other owner",
        );
        manager.appendCustomEntry("studio:discovery", {
          id: other.id,
          project: document.ref.project,
          session: manager.getSessionId(),
        });
        release.resolve();
        await settled.promise;
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(
          requests,
          0,
          "abort at the live provider boundary prevents network delivery of the wrongly bound prompt",
        );
        assert.equal(store.get(other.id).leadPlan.draft, null);
        assert.equal(
          (await host.sync()).feedback.find(
            (item) => item.requestId === feedback.requestId,
          )?.state,
          FeedbackState.Uncertain,
        );
        await session.prompt("Ordinary chat remains available");
        assert.equal(
          requests,
          1,
          `the same native model and provider work after the blocked run settles: ${JSON.stringify(session.agent.state.messages.at(-1))}`,
        );
        const original = draftSchema.parse({
          summary: "Model read this version",
          tasks: [
            {
              key: "change",
              title: "Change",
              description: "Small change",
              acceptance: "Observe",
            },
          ],
        });
        await draft.execute(
          "create-other",
          original,
          undefined,
          undefined,
          ctx,
        );
        host.capture(ctx);
        const before = (await host.sync()).documents[0];
        assert.ok(before !== undefined);
        const editor = {
          ...original,
          summary: "Editor saved after model context capture",
        };
        providerEdit = async () => {
          await host.save({
            operationId: randomUUID(),
            ref: before.ref,
            expectedRevision: before.revision,
            markdown: renderPlan(editor),
          });
        };
        batch = [
          {
            id: "read-new-version",
            name: "read_studio_documents",
            arguments: {},
          },
          {
            id: "stale-in-same-batch",
            name: "draft_implementation_plan",
            arguments: {
              ...original,
              summary: "Stale precomputed replacement",
              expectedRevision: before.revision,
            },
          },
        ];
        await session.prompt("Read the documents and revise the draft");
        assert.equal(
          store.get(other.id).leadPlan.draft?.summary,
          editor.summary,
        );
        const staleResult = session.agent.state.messages.find(
          (message) =>
            message.role === "toolResult" &&
            message.toolCallId === "stale-in-same-batch",
        );
        assert.ok(staleResult?.role === "toolResult");
        assert.equal(staleResult.isError, true);
        assert.match(
          JSON.stringify(staleResult.content),
          /changed after the agent read/u,
        );

        const reviewed = readySpecification(store.get(other.id).revision);
        store.change(other.id, (row) => {
          row.specification = reviewed;
        });
        respond = (payload) => {
          const request = z
            .object({
              messages: z.array(
                z.object({ role: z.string(), content: z.unknown() }),
              ),
            })
            .parse(payload);
          const system = request.messages
            .filter((message) => message.role === "system")
            .map((message) =>
              typeof message.content === "string" ? message.content : "",
            )
            .join("\n");
          const snapshotLine = system
            .split(
              "Studio document snapshots (task data; saving is not approval):\n",
            )
            .at(-1)
            ?.split("\n")[0];
          assert.ok(snapshotLine !== undefined);
          const supplied = documentSnapshotSchema
            .array()
            .parse(JSON.parse(snapshotLine))
            .find((item) => item.ref.kind === DocumentKind.Specification);
          assert.ok(supplied !== undefined);
          const current = store.get(other.id);
          assert.equal(
            current.specification?.coverageRevision,
            undefined,
            "typed operator input invalidates the previous assessment before model context is supplied",
          );
          assert.equal(
            supplied.revision,
            revisionFor(supplied.ref, current),
            "the provider receives the post-admission revision",
          );
          return [
            {
              id: "supplied-revision",
              name: "draft_socrates_specification",
              arguments: {
                ...reviewed.draft,
                objective: "Updated from the supplied snapshot",
                expectedRevision: supplied.revision,
              },
            },
          ];
        };
        await session.prompt(
          "Revise the objective and reassess the current specification",
        );
        const currentSpec = store.get(other.id).specification;
        assert.ok(currentSpec !== undefined);
        assert.equal(
          currentSpec.draft?.objective,
          "Updated from the supplied snapshot",
        );
        assert.ok(coverageFresh(currentSpec, other.revision));
        const acceptedResult = session.agent.state.messages.find(
          (message) =>
            message.role === "toolResult" &&
            message.toolCallId === "supplied-revision",
        );
        assert.ok(acceptedResult?.role === "toolResult");
        assert.equal(
          acceptedResult.isError,
          false,
          "a candidate using its supplied snapshot needs no artificial stale-token retry",
        );
        await session.prompt("Inspect the current proposal", {
          source: "extension",
        });
        assert.equal(
          store.get(other.id).specification?.coverageRevision,
          currentSpec.coverageRevision,
          "internal command prompts retain their exclusion in the native lifecycle",
        );

        const busy = { ...ctx, isIdle: () => false };
        const selectedSpec = host
          .capture(busy)
          .find((item) => item.ref.kind === DocumentKind.Specification);
        assert.ok(selectedSpec !== undefined);
        const comment = await host.feedback({
          requestId: randomUUID(),
          ref: selectedSpec.ref,
          baseRevision: selectedSpec.revision,
          bufferIdentity: "editor",
          range: { startLine: 1, endLine: 1 },
          selectedText: "Selected objective",
          message: "Explain this choice without editing",
        });
        assert.equal(
          store.get(other.id).specification?.coverageRevision,
          currentSpec.coverageRevision,
          "queuing feedback does not invalidate coverage",
        );
        manager.appendCustomEntry("studio:discovery", {
          id: document.ref.ownerId,
          project: document.ref.project,
          session: manager.getSessionId(),
        });
        host.capture(busy);
        assert.equal(
          (await host.sync()).feedback.find(
            (item) => item.requestId === comment.requestId,
          )?.state,
          FeedbackState.Parked,
        );
        assert.equal(
          store.get(other.id).specification?.coverageRevision,
          currentSpec.coverageRevision,
          "parked feedback does not invalidate coverage",
        );
        const completedFeedback = gate();
        nextSettled = completedFeedback.resolve;
        respond = () => {
          assert.equal(
            store.get(other.id).specification?.coverageRevision,
            undefined,
            "admitted selection feedback is operator guidance despite its extension transport",
          );
          return [
            {
              id: "explanation-outcome",
              name: "document_feedback_outcome",
              arguments: {
                requestId: comment.requestId,
                summary: "Explained the choice without changing the draft",
              },
            },
          ];
        };
        manager.appendCustomEntry("studio:discovery", {
          id: other.id,
          project: document.ref.project,
          session: manager.getSessionId(),
        });
        host.capture(ctx);
        await host.sync();
        await completedFeedback.promise;
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(
          store.get(other.id).specification?.coverageRevision,
          undefined,
        );
        assert.deepEqual(
          store.get(other.id).specification?.draft,
          currentSpec.draft,
        );
        const explanation = (await host.sync()).feedback.find(
          (item) => item.requestId === comment.requestId,
        );
        assert.equal(explanation?.state, FeedbackState.Answered);
        assert.deepEqual(explanation.changes, []);
        store.change(other.id, (row) => {
          row.specification = currentSpec;
        });
        discardFeedback = true;
        const beforeDiscard = host
          .capture(ctx)
          .find((item) => item.ref.kind === DocumentKind.Specification);
        assert.ok(beforeDiscard !== undefined);
        await host.feedback({
          requestId: randomUUID(),
          ref: beforeDiscard.ref,
          baseRevision: beforeDiscard.revision,
          bufferIdentity: "editor",
          range: { startLine: 1, endLine: 1 },
          selectedText: "Objective",
          message: "Cancelled during native preflight",
        });
        await discarded.promise;
        assert.equal(
          store.get(other.id).specification?.coverageRevision,
          currentSpec.coverageRevision,
          "feedback cancelled by an input hook is never admitted and preserves coverage",
        );
        host.dispose();
      } finally {
        release.resolve();
        await session.abort();
        session.dispose();
      }
    } finally {
      store.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        }),
      );
      if (previous === undefined) delete process.env["STUDIO_STATE_DIR"];
      else process.env["STUDIO_STATE_DIR"] = previous;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
