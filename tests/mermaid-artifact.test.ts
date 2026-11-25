import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import {
  mermaidSourceLimit,
  renderMermaidArtifact,
} from "../diagram/mermaid-artifact.ts";

const source =
  "---\ntitle: Dispatch\n---\nsequenceDiagram\n  Lead->>Worker: Start\n";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0isAAAAASUVORK5CYII=";
const output = `if (dest.endsWith(".svg")) await writeFile(dest, '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>');
else await writeFile(dest, Buffer.from(${JSON.stringify(png)},"base64"));`;

async function workspace(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "studio-mermaid-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function cli(directory: string, behavior: string) {
  const executable = join(directory, "fixture-mmdc.mjs");
  const script = `#!${process.execPath}
import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const args = process.argv.slice(2);
const opt = flag => args[args.indexOf(flag) + 1];
const dest = opt("-o");
assert.equal(opt("-t"),"dark");
assert.equal(opt("-b"),"#2E3440");
const config = JSON.parse(await readFile(opt("-c"),"utf8"));
assert.equal(config.securityLevel,"strict");
assert.ok(config.secure.includes("securityLevel"));
assert.ok(config.secure.includes("theme"));
assert.equal(await readFile(opt("-i"),"utf8"), ${JSON.stringify(source)});
${behavior}
`;
  await writeFile(executable, script, { mode: 0o700 });
  return executable;
}

await test("source survives a missing renderer; competing retries publish one complete pair", async (t) => {
  const directory = await workspace(t);
  const root = join(directory, "diagrams");
  const missing = join(directory, "unavailable-mmdc");
  const first = await renderMermaidArtifact(root, source, {
    executable: missing,
  });
  assert.equal(first.status, "source-only");
  assert.match(first.reason, /mmdc.*not found/u);
  assert.equal(await readFile(first.sourcePath, "utf8"), source);
  assert.deepEqual(await readdir(dirname(first.sourcePath)), ["diagram.mmd"]);

  const executable = await cli(directory, output);
  const [a, b] = await Promise.all([
    renderMermaidArtifact(root, source, { executable }),
    renderMermaidArtifact(root, source, { executable }),
  ]);
  assert.deepEqual(a, b);
  assert.ok(a.status === "rendered");
  assert.equal(a.sourcePath, first.sourcePath);
  assert.equal(
    a.svgPath,
    resolve(dirname(a.sourcePath), "rendered", "diagram.svg"),
  );
  assert.match(await readFile(a.svgPath, "utf8"), /<path/u);
  assert.equal((await readFile(a.pngPath)).toString("base64"), png);
  assert.deepEqual((await readdir(dirname(first.sourcePath))).sort(), [
    "diagram.mmd",
    "rendered",
  ]);
  const cached = await renderMermaidArtifact(root, source, {
    executable: missing,
  });
  assert.deepEqual(cached, a);
});

await test("a corrupt second output never publishes a partial pair", async (t) => {
  const directory = await workspace(t);
  const executable = await cli(
    directory,
    `${output}
if(dest.endsWith(".png")) await writeFile(dest,"Not a PNG");`,
  );
  const result = await renderMermaidArtifact(
    join(directory, "diagrams"),
    source,
    { executable },
  );
  assert.ok(result.status === "source-only");
  assert.match(result.reason, /complete PNG/u);
  assert.deepEqual(await readdir(dirname(result.sourcePath)), ["diagram.mmd"]);
  assert.equal(await readFile(result.sourcePath, "utf8"), source);
});

await test("timeouts and cancellation release the render and preserve the source", async (t) => {
  const directory = await workspace(t);
  const executable = await cli(
    directory,
    "await new Promise(done => setTimeout(done,30_000));",
  );
  const root = join(directory, "diagrams");
  const timedOut = await renderMermaidArtifact(root, source, {
    executable,
    timeoutMs: 120,
  });
  assert.ok(timedOut.status === "source-only");
  assert.match(timedOut.reason, /timed out/u);
  const controller = new AbortController();
  const pending = renderMermaidArtifact(root, source, {
    executable,
    signal: controller.signal,
  });
  const timer = setTimeout(() => {
    controller.abort(new Error("Operator cancelled"));
  }, 120);
  try {
    await assert.rejects(pending, /Operator cancelled/u);
  } finally {
    clearTimeout(timer);
  }
  assert.deepEqual(await readdir(dirname(timedOut.sourcePath)), [
    "diagram.mmd",
  ]);
});

await test("invalid requests and edits to a published source leave the original files alone", async (t) => {
  const directory = await workspace(t);
  const root = join(directory, "diagrams");
  await assert.rejects(
    renderMermaidArtifact(root, " ".repeat(mermaidSourceLimit + 1)),
    /characters/u,
  );
  const missing = join(directory, "missing");
  const result = await renderMermaidArtifact(root, source, {
    executable: missing,
  });
  await writeFile(result.sourcePath, "Edited locally.");
  await assert.rejects(
    renderMermaidArtifact(root, source, { executable: missing }),
    /saved Mermaid source has changed/u,
  );
  assert.equal(await readFile(result.sourcePath, "utf8"), "Edited locally.");
});
