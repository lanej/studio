import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createEditToolDefinition,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import {
  isStudioEdit,
  registerReasonedEdit,
} from "../code-intelligence/edit-tool.ts";
import { StudioProfile } from "../config.ts";
import {
  ExecutionPhase,
  executionSchema,
  projectSchema,
} from "../execution/store.ts";
import { writableTools } from "../execution/tools.ts";

function services(cwd: string) {
  return createAgentSessionServices({
    cwd,
    agentDir: cwd,
    settingsManager: SettingsManager.inMemory({}),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [registerReasonedEdit],
    },
  });
}

await test("reasoned edits respect tool admission and update the schema when old sessions resume", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "studio-edit-tool-"));
  t.after(() => rm(cwd, { force: true, recursive: true }));
  const readOnly = await createAgentSessionFromServices({
    services: await services(cwd),
    sessionManager: SessionManager.inMemory(cwd),
    tools: ["read"],
  });
  try {
    await readOnly.session.bindExtensions({ mode: "rpc" });
    assert.equal(readOnly.session.getToolDefinition("edit"), undefined);
  } finally {
    readOnly.session.dispose();
  }
  const disabled = await createAgentSessionFromServices({
    services: await services(cwd),
    sessionManager: SessionManager.inMemory(cwd),
    noTools: "builtin",
  });
  try {
    await disabled.session.bindExtensions({ mode: "rpc" });
    assert.ok(
      !disabled.session.getCallableToolNames().includes("edit"),
      "Overriding an inactive builtin must not activate it.",
    );
  } finally {
    disabled.session.dispose();
  }
  const original = createEditToolDefinition(cwd);
  const manager = SessionManager.inMemory(cwd);
  const oldEntry = manager.appendMessage({
    role: "system",
    content: "",
    toolsAdded: [
      {
        name: original.name,
        description: original.description,
        parameters: original.parameters,
      },
    ],
    timestamp: Date.now(),
  });
  const resumed = await createAgentSessionFromServices({
    services: await services(cwd),
    sessionManager: manager,
  });
  try {
    await resumed.session.bindExtensions({ mode: "rpc" });
    const edit = resumed.session.agent.state.tools.find(
      (tool) => tool.name === "edit",
    );
    const schema = z
      .object({
        required: z.array(z.string()),
        properties: z.object({
          reason: z.object({ type: z.literal("string") }),
        }),
      })
      .parse(edit?.parameters);
    assert.ok(schema.required.includes("reason"));
    assert.doesNotMatch(
      JSON.stringify(manager.getEntry(oldEntry)),
      /"reason"/u,
    );
  } finally {
    resumed.session.dispose();
  }
});

await test("worker edit rejects a missing or blank reason before checking its lease or touching the file", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "studio-worker-edit-"));
  t.after(() => rm(cwd, { force: true, recursive: true }));
  const projectId = randomUUID();
  const project = projectSchema.parse({
    id: projectId,
    root: cwd,
    source: { url: "http://127.0.0.1:9", projectId },
    profile: StudioProfile.Personal,
    base: "main",
    beadsWorkspace: cwd,
    beadsDatabase: "fixture",
  });
  const id = randomUUID();
  const attempt = executionSchema.parse({
    id,
    project: projectId,
    profile: StudioProfile.Personal,
    phase: ExecutionPhase.Running,
    message: "Editing fixture",
    checkout: {
      primary: cwd,
      root: cwd,
      path: cwd,
      task_id: id,
      owner_id: id,
      agent: "studio",
      branch: "fixture",
      created_at: new Date().toISOString(),
      base_ref: "main",
    },
  });
  let leaseChecks = 0;
  const tools = writableTools(project, attempt, () => {
    leaseChecks++;
    return Promise.reject(new Error("Retired fixture lease"));
  });
  const { session } = await createAgentSessionFromServices({
    services: await services(cwd),
    sessionManager: SessionManager.inMemory(cwd),
    customTools: tools,
  });
  t.after(() => {
    session.dispose();
  });
  await session.bindExtensions({ mode: "rpc" });
  const edit = session.getToolDefinition("edit");
  assert.equal(edit?.label, "Edit accepted task file");
  const prepareArguments = edit.prepareArguments;
  assert.ok(prepareArguments !== undefined);
  assert.ok(
    z
      .object({ required: z.array(z.string()) })
      .parse(edit.parameters)
      .required.includes("reason"),
  );
  const file = join(cwd, "sample.ts");
  await writeFile(file, "original");
  const change = { path: "sample.ts", oldText: "original", newText: "changed" };
  const context = session.extensionRunner.createToolContext(
    "worker-fixture",
    undefined,
  );
  for (const args of [
    change,
    ...["", " \t\n", false].map((reason) => ({ ...change, reason })),
  ]) {
    assert.throws(() => prepareArguments(args), /reason/u);
    await assert.rejects(
      edit.execute("invalid", args, undefined, undefined, context),
      /reason/u,
    );
  }
  assert.equal(leaseChecks, 0);
  assert.equal(await readFile(file, "utf8"), "original");
  await assert.rejects(
    edit.execute(
      "valid",
      { ...change, reason: "Exercise the existing lease check." },
      undefined,
      undefined,
      context,
    ),
    /Retired fixture lease/u,
  );
  assert.equal(leaseChecks, 1);
  assert.equal(await readFile(file, "utf8"), "original");
});

await test("Claude Edit keeps exact matching and literal replace_all inside Studio's admitted edit", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "studio-exact-edit-"));
  t.after(() => rm(cwd, { force: true, recursive: true }));
  const { session } = await createAgentSessionFromServices({
    services: await services(cwd),
    sessionManager: SessionManager.inMemory(cwd),
  });
  t.after(() => {
    session.dispose();
  });
  await session.bindExtensions({ mode: "rpc" });
  const ctx = session.extensionRunner.createToolContext(
    "claude-edit",
    undefined,
  );
  const path = join(cwd, "sample.txt");
  const original = "\uFEFF“one”\r\ntwo\r\n“one”\r\ntwo\r\n";
  await writeFile(path, original);
  const edit = session.getToolDefinition("edit");
  assert.ok(edit !== undefined);
  const info = session.getAllTools().find((tool) => tool.name === "edit");
  assert.ok(info !== undefined && isStudioEdit(info));
  const otherOwner = { ...info.sourceInfo, path: "/elsewhere/extension.ts" };
  assert.equal(isStudioEdit({ ...info, sourceInfo: otherOwner }), false);
  const replace = (oldText: string, mode: "exact" | "all") => {
    const args = {
      path,
      reason: "Exercise the exact edit contract.",
      matchMode: mode,
      edits: [{ oldText, newText: "$&\n$1" }],
    };
    return edit.execute(
      "exact-edit",
      edit.prepareArguments?.(args) ?? args,
      undefined,
      undefined,
      ctx,
    );
  };
  await assert.rejects(
    replace('"one"', "exact"),
    /does not match the file exactly/u,
  );
  await assert.rejects(replace("“one”\ntwo", "exact"), /multiple locations/u);
  assert.equal(await readFile(path, "utf8"), original);
  await replace("“one”\ntwo", "all");
  assert.equal(await readFile(path, "utf8"), "\uFEFF$&\r\n$1\r\n$&\r\n$1\r\n");

  const braces = "}\n}\n}\n";
  await writeFile(path, braces);
  await assert.rejects(replace("}\n}", "exact"), /multiple locations/u);
  assert.equal(await readFile(path, "utf8"), braces);
  await replace("}\n}", "all");
  assert.equal(await readFile(path, "utf8"), "$&\n$1\n}\n");
});
