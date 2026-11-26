import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { mermaidSourceLimit, renderMermaidArtifact } from "../diagram/mermaid-artifact.ts";

const source = "---\ntitle: Dispatch\n---\nsequenceDiagram\n  Lead->>Worker: Start\n";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0isAAAAASUVORK5CYII=";
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
  assert.equal(a.svgPath, resolve(dirname(a.sourcePath), "rendered", "diagram.svg"));
  assert.match(await readFile(a.svgPath, "utf8"), /<path/u);
  assert.equal((await readFile(a.pngPath)).toString("base64"), png);
  assert.deepEqual((await readdir(dirname(first.sourcePath))).sort(), ["diagram.mmd", "rendered"]);
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
  const result = await renderMermaidArtifact(join(directory, "diagrams"), source, { executable });
  assert.ok(result.status === "source-only");
  assert.match(result.reason, /complete PNG/u);
  assert.deepEqual(await readdir(dirname(result.sourcePath)), ["diagram.mmd"]);
  assert.equal(await readFile(result.sourcePath, "utf8"), source);
});

await test("timeouts and cancellation release the render and preserve the source", async (t) => {
  const directory = await workspace(t);
  const executable = await cli(
    directory,
    "process.on('SIGTERM', () => {}); await new Promise(done => setTimeout(done,30_000));",
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
  assert.deepEqual(await readdir(dirname(timedOut.sourcePath)), ["diagram.mmd"]);
});

await test(
  "cancellation waits for the CLI to close its separately grouped browser",
  { skip: process.platform === "win32", timeout: 15_000 },
  async (t) => {
    const directory = await workspace(t);
    const ready = join(directory, "browser-ready");
    const closed = join(directory, "browser-closed");
    const executable = await cli(
      directory,
      `
    import { spawn } from "node:child_process";
    import { once } from "node:events";
    // IPC disconnect also cleans the fixture up if its driver is killed.
    const browser = spawn(process.execPath, ["-e", 'process.once("disconnect", () => process.exit(0)); process.send("ready"); setTimeout(() => process.exit(1), 10000);'], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const stopped = once(browser, "exit");
    await once(browser, "message");
    process.once("SIGTERM", () => browser.kill("SIGTERM"));
    await writeFile(${JSON.stringify(ready)}, "ready");
    await stopped;
    // The stage must still exist until the driver's own cleanup has completed.
    await readFile(opt("-i"));
    await writeFile(${JSON.stringify(closed)}, "closed");
  `,
    );
    const controller = new AbortController();
    const cancelled = assert.rejects(
      renderMermaidArtifact(join(directory, "diagrams"), source, {
        executable,
        signal: controller.signal,
      }),
      /Operator cancelled/u,
    );
    try {
      const deadline = Date.now() + 8000;
      while (!existsSync(ready) && Date.now() < deadline) await delay(10);
      assert.ok(existsSync(ready), "browser fixture did not become ready");
    } finally {
      controller.abort(new Error("Operator cancelled"));
      await cancelled;
    }
    assert.equal(await readFile(closed, "utf8"), "closed");
  },
);

await test("invalid requests and edits to a published source leave the original files alone", async (t) => {
  const directory = await workspace(t);
  const root = join(directory, "diagrams");
  await assert.rejects(renderMermaidArtifact(root, " ".repeat(mermaidSourceLimit + 1)), /characters/u);
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

await test("a missing export is repaired without replacing surviving or concurrently restored files", async (t) => {
  const directory = await workspace(t);
  const root = join(directory, "diagrams");
  const executable = await cli(directory, output);
  const original = await renderMermaidArtifact(root, source, { executable });
  assert.ok(original.status === "rendered");
  const edited = '<svg xmlns="http://www.w3.org/2000/svg"><title>My edits</title></svg>';
  await writeFile(original.svgPath, edited);
  const saved = join(directory, "saved.png");
  await rename(original.pngPath, saved);

  // Only the missing format should require the renderer.
  const pngOnly = `assert.ok(dest.endsWith(".png"));\n${output}`;
  await cli(directory, pngOnly);
  assert.deepEqual(await renderMermaidArtifact(root, source, { executable }), original);
  assert.deepEqual(await readFile(original.pngPath), await readFile(saved));
  assert.equal(await readFile(original.svgPath, "utf8"), edited);

  // The user restores their original PNG while the replacement is rendering.
  await rm(original.pngPath);
  await cli(
    directory,
    `import { link } from "node:fs/promises";
    await link(${JSON.stringify(saved)}, ${JSON.stringify(original.pngPath)});
    ${pngOnly}`,
  );
  assert.deepEqual(await renderMermaidArtifact(root, source, { executable }), original);
  assert.equal((await stat(original.pngPath)).ino, (await stat(saved)).ino);
  assert.equal(await readFile(original.svgPath, "utf8"), edited);
  assert.deepEqual((await readdir(dirname(original.sourcePath))).sort(), ["diagram.mmd", "rendered"]);
});

await test(
  "repair checks for a replaced output directory after rendering",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await workspace(t);
    const root = join(directory, "diagrams");
    const executable = await cli(directory, output);
    const original = await renderMermaidArtifact(root, source, { executable });
    assert.ok(original.status === "rendered");
    await rm(original.pngPath);
    const cache = dirname(original.pngPath);
    const moved = join(directory, "moved");
    await cli(
      directory,
      `import { rename, symlink } from "node:fs/promises";
      await rename(${JSON.stringify(cache)}, ${JSON.stringify(moved)});
      await symlink(${JSON.stringify(moved)}, ${JSON.stringify(cache)});
      ${output}`,
    );
    const repair = await renderMermaidArtifact(root, source, { executable });
    assert.ok(repair.status === "source-only");
    assert.match(repair.reason, /not a directory/u);
    assert.deepEqual(await readdir(moved), ["diagram.svg"]);
  },
);
