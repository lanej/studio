import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { selectorText } from "@lanej/pi-components";
import { processFailure, signalProcessGroup } from "../process.ts";

export const mermaidSourceLimit = 50_000;

export type MermaidArtifact =
  | { status: "rendered"; sourcePath: string; svgPath: string; pngPath: string }
  | { status: "source-only"; sourcePath: string; reason: string };

interface RenderOptions {
  signal?: AbortSignal;
  executable?: string;
  timeoutMs?: number;
}

const siteConfig = {
  theme: "dark",
  securityLevel: "strict",
  maxTextSize: mermaidSourceLimit,
  // Preserve Mermaid's default site-controlled keys and the Studio palette
  // when an input contains frontmatter or a diagram-level init directive.
  secure: [
    "secure",
    "securityLevel",
    "startOnLoad",
    "maxTextSize",
    "suppressErrorRendering",
    "maxEdges",
    "theme",
    "themeCSS",
    "themeVariables",
    "dompurifyConfig",
  ],
};

async function runRenderer(
  executable: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const unix = process.platform !== "win32";
  const path = (process.env["PATH"] ?? "")
    .split(delimiter)
    .filter(isAbsolute)
    .join(delimiter);
  const child = spawn(executable, args, {
    cwd,
    env: { ...process.env, PATH: path },
    stdio: ["ignore", "ignore", "pipe"],
    detached: unix,
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
  });
  await new Promise<void>((done, reject) => {
    const cancel = () => {
      try {
        if (unix && child.pid !== undefined)
          signalProcessGroup(child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      reject(new Error("Mermaid CLI rendering was interrupted"));
    };
    signal.addEventListener("abort", cancel, { once: true });
    child.once("error", (error) => {
      signal.removeEventListener("abort", cancel);
      reject(
        processFailure(error).code === "ENOENT"
          ? new Error(
              "Mermaid CLI (mmdc) was not found on PATH. Install it and retry to generate SVG and PNG.",
            )
          : error,
      );
    });
    child.once("close", (code, killedBy) => {
      signal.removeEventListener("abort", cancel);
      if (code === 0) done();
      else {
        const detail = selectorText(stderr)
          .replace(/\s+/gu, " ")
          .trim()
          .slice(0, 1000);
        reject(
          new Error(
            `Mermaid CLI exited with ${String(killedBy ?? code)}${detail === "" ? "" : ` — ${detail}`}`,
          ),
        );
      }
    });
    if (signal.aborted) cancel();
  });
}

async function checkImage(path: string, format: "svg" | "png") {
  const info = await lstat(path);
  const limit = format === "png" ? 4 * 1024 * 1024 : 8 * 1024 * 1024;
  if (!info.isFile() || info.size === 0 || info.size > limit)
    throw new Error(
      `Mermaid CLI produced an empty, oversized, or non-file ${format.toUpperCase()} output`,
    );
  const bytes = await readFile(path);
  if (format === "svg") {
    const xml = bytes.toString("utf8").trim();
    if (
      !/^(?:<\?xml\s[^?]*\?>\s*)?<svg\b/u.test(xml) ||
      !xml.endsWith("</svg>")
    )
      throw new Error("Mermaid CLI did not produce a complete SVG");
    return;
  }
  if (
    bytes.length < 45 ||
    !bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.toString("ascii", 12, 16) !== "IHDR" ||
    bytes.toString("ascii", bytes.length - 8, bytes.length - 4) !== "IEND"
  )
    throw new Error("Mermaid CLI did not produce a complete PNG");
  const pixels = bytes.readUInt32BE(16) * bytes.readUInt32BE(20);
  if (pixels === 0 || pixels > 16_000_000)
    throw new Error("Rendered PNG exceeds the terminal preview dimensions");
}

async function hasImages(directory: string) {
  const info = await lstat(directory).catch((error: unknown) => {
    if (processFailure(error).code !== "ENOENT") throw error;
    return undefined;
  });
  if (info === undefined) return false;
  if (!info.isDirectory())
    throw new Error("Mermaid output path is not a directory");
  await Promise.all([
    checkImage(join(directory, "diagram.svg"), "svg"),
    checkImage(join(directory, "diagram.png"), "png"),
  ]);
  return true;
}

export async function renderMermaidArtifact(
  root: string,
  source: string,
  options: RenderOptions = {},
): Promise<MermaidArtifact> {
  options.signal?.throwIfAborted();
  if (source.trim() === "" || source.length > mermaidSourceLimit)
    throw new Error(
      `Mermaid diagrams must contain between 1 and ${String(mermaidSourceLimit)} characters`,
    );
  const timeoutMs = options.timeoutMs ?? 45_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000)
    throw new Error("Mermaid rendering requires a timeout of 1 to 120000 ms");
  const digest = createHash("sha256").update(source, "utf8").digest("hex");
  const directory = resolve(root, digest);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory())
    throw new Error("Mermaid artifact path is not a directory");
  const stage = await mkdtemp(join(directory, ".render-"));
  const input = join(stage, "diagram.mmd");
  const sourcePath = join(directory, "diagram.mmd");
  const output = join(directory, "rendered");
  const rendered = {
    status: "rendered",
    sourcePath,
    svgPath: join(output, "diagram.svg"),
    pngPath: join(output, "diagram.png"),
  } as const;
  try {
    // Link only after the complete source is written. Concurrent requests can
    // reuse it, and a later render never overwrites a user's edited source.
    const candidate = join(stage, "source");
    await writeFile(candidate, source, { mode: 0o600 });
    try {
      await link(candidate, sourcePath);
    } catch (error) {
      if (processFailure(error).code !== "EEXIST") throw error;
      const existing = await lstat(sourcePath);
      if (
        !existing.isFile() ||
        existing.size !== Buffer.byteLength(source) ||
        (await readFile(sourcePath, "utf8")) !== source
      )
        throw new Error(
          "The saved Mermaid source has changed; move it before recreating this artifact",
        );
    }
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal =
      options.signal === undefined
        ? timeout
        : AbortSignal.any([options.signal, timeout]);
    try {
      if (await hasImages(output)) {
        signal.throwIfAborted();
        return rendered;
      }
      // The editable source is already visible. Render both formats from our
      // own snapshot even if an editor changes that file between invocations.
      await writeFile(input, source, { mode: 0o600 });
      const drafts = join(stage, "rendered");
      await mkdir(drafts, { mode: 0o700 });
      const config = join(stage, "mermaid.json");
      await writeFile(config, JSON.stringify(siteConfig), { mode: 0o600 });
      for (const format of ["svg", "png"] as const) {
        const destination = join(drafts, `diagram.${format}`);
        await runRenderer(
          options.executable ?? "mmdc",
          [
            "-i",
            input,
            "-o",
            destination,
            "-c",
            config,
            "-t",
            "dark",
            "-b",
            "#2E3440",
          ],
          stage,
          signal,
        );
        await checkImage(destination, format);
      }
      signal.throwIfAborted();
      try {
        await rename(drafts, output);
      } catch (error) {
        // Another process may have published the same immutable pair.
        if (!(await hasImages(output))) throw error;
      }
      return rendered;
    } catch (error) {
      options.signal?.throwIfAborted();
      const failure = processFailure(error);
      const reason = timeout.aborted
        ? "Mermaid CLI timed out."
        : failure.message;
      return { status: "source-only", sourcePath, reason };
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
