import assert from "node:assert/strict";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  InteractiveMode,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { z } from "zod";

const [id, sessionDir, provider, modelId] = z
  .tuple([z.uuid(), z.string(), z.string(), z.string()])
  .parse(process.argv.slice(2));
const cwd = process.cwd();
const agentDir = getAgentDir();
const sessionManager = SessionManager.create(cwd, sessionDir, { id });
const runtime = await createAgentSessionRuntime(
  async ({ sessionManager: target }) => {
    assert.equal(target, sessionManager, "The fixture session cannot change");
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager: SettingsManager.inMemory({
        quietStartup: true,
        doubleEscapeAction: "tree",
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noContextFiles: true,
        disabledBuiltinExtensions: ["mcp"],
        systemPrompt: "Exercise the supplied fixture tool.",
      },
    });
    const model = services.modelRuntime.getModel(provider, modelId);
    if (model === undefined)
      throw new Error("Missing deterministic local model");
    const created = await createAgentSessionFromServices({
      services,
      sessionManager: target,
      model,
      thinkingLevel: "off",
      noTools: "builtin",
      customTools: [
        {
          name: "assignment_probe",
          label: "Assignment probe",
          description: "Emit a fixture receipt during this turn",
          parameters: Type.Object({}),
          execute: () =>
            Promise.resolve({
              content: [{ type: "text", text: "Native fixture tool ran." }],
              details: {},
            }),
        },
      ],
    });
    return { ...created, services, diagnostics: [] };
  },
  { cwd, agentDir, sessionManager },
);
const mode = new InteractiveMode(runtime, {
  assignmentInput: true,
  initialMessage: "Begin the assigned turn.",
  initialThemeSetting: "dotfiles",
});
assert.equal(mode.assignmentInputEnabled, true, "Pi input policy is missing");
await mode.run();
