import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

const invocationSchema = z.strictObject({
  args: z.array(z.string()),
  cwd: z.string(),
  agent: z.literal("0"),
  thread: z.null(),
  agentId: z.null(),
});

type Invocation = z.infer<typeof invocationSchema>;

const markdown = `# Publication instructions

Keep the authored **Markdown**, including "quotes" and \\paths.

- Describe the accepted change.
- Include local verification evidence.

\`\`\`text
Not a JSON response.
\`\`\`
`;

await test("Octo executable boundary decodes only pr instructions as text", async (t) => {
  // All generated executables, configuration and evidence stay in ignored output.
  const cache = resolve(".aot");
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, "octo-instructions-"));
  const executable = join(directory, "octo-fixture.js");
  const response = join(directory, "response.json");
  const invocation = join(directory, "invocation.json");
  const config = join(directory, "config.json");
  const environment = {
    STUDIO_CONFIG: config,
    // Isolation may map HOME or cache directories into the reviewed checkout.
    // Redirect every fixture/runtime output before importing production modules
    // or starting the fake executable; never write into that source snapshot.
    HOME: join(directory, "home"),
    XDG_CACHE_HOME: join(directory, "cache"),
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_STATE_HOME: join(directory, "state"),
    TMPDIR: join(directory, "tmp"),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(directory, "transpiler-cache"),
    BUN_INSTALL_CACHE_DIR: join(directory, "install-cache"),
  };
  const previousEnvironment = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  try {
    await Promise.all(
      Object.entries(environment)
        .filter(([key]) => key !== "STUDIO_CONFIG")
        .map(([, path]) => mkdir(path, { recursive: true })),
    );
    Object.assign(process.env, environment);
    const { octo } = await import("../delivery.ts");
    const { processFailure } = await import("../process.ts");
    // Give the fake its own package boundary, so Bun cannot treat the reviewed
    // repository as a location for package metadata or installation outputs.
    await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
    await writeFile(
      join(directory, "bunfig.toml"),
      '[install]\nauto = "disable"\n',
    );
    // This fake reads only its local response, never credentials or a network API.
    await writeFile(
      executable,
      `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const response = JSON.parse(readFileSync(${JSON.stringify(response)}, "utf8"));
writeFileSync(${JSON.stringify(invocation)}, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  agent: process.env.OCTO_MANAGER_AGENT,
  thread: process.env.CODEX_THREAD_ID ?? null,
  agentId: process.env.OCTO_MANAGER_AGENT_ID ?? null,
}));
process.stdout.write(response.stdout);
process.stderr.write(response.stderr);
process.exitCode = response.code;
`,
    );
    await chmod(executable, 0o700);
    await writeFile(
      config,
      JSON.stringify({ integrations: { octo: { enabled: true, executable } } }),
    );
    const reply = (stdout: string, code = 0, stderr = "") =>
      writeFile(response, JSON.stringify({ stdout, stderr, code }));
    const readInvocation = async (): Promise<Invocation> => {
      const recorded: unknown = JSON.parse(await readFile(invocation, "utf8"));
      return invocationSchema.parse(recorded);
    };

    await t.test(
      "native Markdown survives intact and is usable by worker brief formatting",
      async () => {
        await reply(markdown);
        const instructions = await octo(directory, "pr", "instructions");
        assert.equal(instructions, markdown);
        // execution/worker.ts embeds this value via JSON.stringify in its brief.
        const guidance = JSON.stringify(instructions);
        const decodedGuidance: unknown = JSON.parse(guidance);
        assert.equal(z.string().parse(decodedGuidance), markdown);
        assert.ok(guidance.length < 32000);
        assert.deepEqual(await readInvocation(), {
          args: ["pr", "instructions", "--json"],
          cwd: directory,
          agent: "0",
          thread: null,
          agentId: null,
        });
      },
    );

    await t.test(
      "instruction decoding depends on the command, not JSON-looking content",
      async () => {
        const authored = '{"guidance":"Keep this authored text verbatim"}\n';
        await reply(authored);
        assert.equal(await octo(directory, "pr", "instructions"), authored);
      },
    );

    await t.test("structured commands keep parsed JSON results", async () => {
      const result = { pr: { id: "fixture-pr", state: "open" } };
      await reply(`${JSON.stringify(result)}\n`);
      assert.deepEqual(
        await octo(directory, "pr", "show", "fixture-pr"),
        result,
      );
      const recorded = await readInvocation();
      assert.deepEqual(recorded.args, ["pr", "show", "fixture-pr", "--json"]);
    });

    await t.test(
      "malformed structured output fails instead of falling back to text",
      async () => {
        for (const args of [
          ["pr", "show", "instructions"],
          ["agent", "inbox"],
          ["submission", "instructions"],
          ["instructions"],
        ]) {
          for (const output of [markdown, '{"pr":', ""]) {
            await reply(output);
            await assert.rejects(octo(directory, ...args), SyntaxError);
          }
        }
      },
    );

    await t.test(
      "nonzero exits retain stdout, stderr and status for both response kinds",
      async () => {
        for (const args of [
          ["pr", "instructions"],
          ["pr", "show", "fixture-pr"],
        ]) {
          const stdout = args[1] === "instructions" ? markdown : '{"pr":{}}';
          await reply(stdout, 23, "fixture command rejected\n");
          await assert.rejects(octo(directory, ...args), (error: unknown) => {
            const failure = processFailure(error);
            assert.equal(failure.code, 23);
            assert.equal(failure.stdout, stdout);
            assert.equal(failure.stderr, "fixture command rejected\n");
            assert.match(failure.message, /fixture command rejected/u);
            return true;
          });
        }
      },
    );
  } finally {
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
