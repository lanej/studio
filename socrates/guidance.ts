import { readFile } from "node:fs/promises";

export async function socratesGuidance(): Promise<string> {
  try {
    const skill = new URL("../resources/socrates/", import.meta.url);
    const [entrypoint, procedure, dataChangePlanning, host] = await Promise.all([
      readFile(new URL("SKILL.md", skill), "utf8"),
      readFile(new URL("references/dialogue.txt", skill), "utf8"),
      readFile(new URL("references/data-change-planning.md", skill), "utf8"),
      readFile(new URL("./host.md", import.meta.url), "utf8"),
    ]);
    return [entrypoint, procedure, dataChangePlanning, host].join("\n\n");
  } catch (cause) {
    throw new Error("Cannot load the shared Socrates procedure from the installed driver package", { cause });
  }
}
