#!/usr/bin/env bun
import { inspectIntegrations } from "./integrations.ts";
import { inspectPackageResources } from "./package-resources.ts";
import { Argument, Command, Option } from "commander";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { registerRuntimeCommands } from "./execution/cli.ts";
import { startSession } from "./session.ts";
import { BeadsReader, taskDetails, taskLabel, taskSchema, taskTree } from "./beads.ts";
import { dispatchGate } from "./capabilities.ts";
import { configPath, exampleConfig, loadConfig } from "./config.ts";

enum HelpTopic {
  Tasks = "tasks",
  Compaction = "compaction",
  Profile = "profile",
  Dispatch = "dispatch",
  Runtime = "runtime",
}

const program = new Command()
  .name("studio")
  .description("Start a daily-driver Pi session or run and inspect an existing bead")
  .version("0.1.0")
  .action(async () => {
    await startSession();
  });
program
  .command("lead [args...]")
  .description("Open Pi here without a bead; pass native Pi options after --")
  .allowUnknownOption()
  .allowExcessArguments()
  .action(async (_args: string[], _options: unknown, command: Command) => {
    await startSession(command.args);
  });
registerRuntimeCommands(program);
const output = (value: unknown): void => {
  console.log(JSON.stringify(value, null, 2));
};
program
  .command("config")
  .description("Inspect configuration without changing settings or credentials")
  .option("--example", "Print a configuration example")
  .addOption(
    new Option(
      "--pi-models [catalog]",
      "Generate Mantle entries for Pi models.json (optionally from a saved models.dev catalog)",
    ).conflicts("example"),
  )
  .addOption(
    new Option("--region <region>", "Mantle AWS region (or AWS_REGION/AWS_DEFAULT_REGION)")
      .implies({ piModels: true })
      .conflicts("example"),
  )
  .action(async (options: { example?: boolean; piModels?: boolean | string; region?: string }) => {
    if (options.piModels !== undefined && options.piModels !== false) {
      const { generatePiModels } = await import("./pi-models.ts");
      output(
        await generatePiModels(options.region, typeof options.piModels === "string" ? options.piModels : undefined),
      );
      return;
    }
    output(options.example === true ? exampleConfig : { path: configPath(), configuration: await loadConfig() });
  });
program
  .command("doctor")
  .description("Verify the configured task source and inspect the managed-launch gate")
  .action(async () => {
    const config = await loadConfig();
    let beads: { configured: boolean; readable?: boolean; error?: string } = {
      configured: false,
    };
    if (config.beads) {
      try {
        await new BeadsReader(config.beads).verify();
        beads = { configured: true, readable: true };
      } catch (error) {
        beads = {
          configured: true,
          readable: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    let beadsService: {
      configured: boolean;
      verified: boolean;
      error?: string;
    } = { configured: false, verified: false };
    if (config.beadsService) {
      try {
        const { TaskBeads } = await import("./task-service.ts");
        await new TaskBeads(config.beadsService).verifyAuthority();
        beadsService = { configured: true, verified: true };
      } catch (cause) {
        beadsService = {
          configured: true,
          verified: false,
          error: cause instanceof Error ? cause.message : String(cause),
        };
      }
    }
    const integrations = await inspectIntegrations(config);
    const resources = await inspectPackageResources();
    output({
      resources,
      integrations,
      beads,
      beadsService,
      dispatch: dispatchGate,
      profile: config.profile ?? null,
    });
    process.exitCode =
      !resources.available ||
      beads.readable === false ||
      (beadsService.configured && !beadsService.verified) ||
      Object.values(integrations).some((integration) => integration.enabled && !integration.present)
        ? 1
        : 0;
  });
program
  .command("tasks [id]")
  .description("Inspect a Beads task or containment tree (maximum 1000 records)")
  .option("--json", "Print structured task data")
  .action(async (id: string | undefined, options: { json?: boolean }) => {
    const config = await loadConfig();
    if (config.beadsService) {
      const { TaskBeads } = await import("./task-service.ts");
      const service = new TaskBeads(config.beadsService);
      const projectId = config.beadsService.projectId;
      if (id !== undefined) {
        const task = await service.get(id);
        const { Attempts, stateDirectory } = await import("./attempts.ts");
        const directory = stateDirectory();
        let attempt = null;
        if (existsSync(join(directory, "attempts.sqlite"))) {
          const db = new Attempts(directory, true);
          try {
            attempt = db.latest(projectId, id);
          } finally {
            db.close();
          }
        }
        if (options.json === true) output({ projectId, task, attempt });
        else {
          console.log(taskDetails(taskSchema.parse(task), projectId));
          if (attempt !== null) console.log(`${attempt.phase} · ${attempt.message}`);
        }
      } else {
        const page = await service.list();
        const tasks = z.array(taskSchema).parse(page.items);
        if (options.json === true) output({ projectId, tasks, possiblyTruncated: page.has_more });
        else {
          for (const row of taskTree(tasks)) console.log(taskLabel(row));
          if (page.has_more) console.error("Additional tasks are available. Inspect a task by its full ID.");
        }
      }
      return;
    }
    if (!config.beads)
      throw new Error(
        `Configure an explicit Beads workspace, database, and branch in ${configPath()}; discovery never initializes one`,
      );
    const reader = new BeadsReader(config.beads);
    if (id !== undefined && id.length > 0) {
      const task = await reader.show(id);
      if (options.json === true) output({ workspace: config.beads.workspace, task });
      else console.log(taskDetails(task, config.beads.workspace));
    } else {
      const tasks = await reader.list();
      if (options.json === true)
        output({
          workspace: config.beads.workspace,
          tasks,
          possiblyTruncated: tasks.length === 1000,
        });
      else {
        console.log(`Beads: ${config.beads.workspace} / ${config.beads.database}@${config.beads.branch}`);
        for (const row of taskTree(tasks)) console.log(taskLabel(row));
        if (tasks.length === 1000)
          console.error("Result may be truncated at 1000 tasks; inspect a task by its full ID.");
      }
    }
  });
program
  .command("start <bead-id> [verifier...]")
  .description("Start or focus a bead lead. Pass the agreed check as argv after --")
  .option("--worker", "Start a direct worker without a lead plan")
  .option("--tab-id <id>", "Place a new worker in this Zellij tab")
  .action(async (id: string, verifier: string[], options: { tabId?: string; worker?: boolean }) => {
    if (verifier.length > 0 && !process.argv.slice(2).includes("--"))
      throw new Error("Place the agreed verification command after --");
    const { tabId } = await import("./zellij.ts");
    const { startTask } = await import("./task-run.ts");
    output(
      await startTask(
        id,
        verifier,
        options.tabId === undefined ? undefined : tabId(options.tabId),
        options.worker !== true,
      ),
    );
  });
program
  .command("resume <bead-id>")
  .description("Resume a settled lead in its existing worktree")
  .option("--tab-id <id>", "Place the reopened lead in this Zellij tab")
  .action(async (id: string, options: { tabId?: string }) => {
    const { resumeLead } = await import("./task-run.ts");
    const { tabId } = await import("./zellij.ts");
    output(await resumeLead(id, options.tabId === undefined ? undefined : tabId(options.tabId)));
  });
program
  .command("publish <bead-id>")
  .description("Publish the verified lead commit through Octo")
  .requiredOption("--title <title>", "Reviewed PR title")
  .requiredOption("--body-file <path>", "Reviewed PR description")
  .requiredOption("--base <branch>", "GitHub base branch")
  .action(async (id: string, options: { title: string; bodyFile: string; base: string }) => {
    const { publishLead } = await import("./delivery.ts");
    output(await publishLead(id, options.title, options.bodyFile, options.base));
  });
program
  .command("ready <bead-id>")
  .description("Record owner assessment of current PR feedback in Octo")
  .requiredOption("--head <sha>", "Full verified commit SHA")
  .action(async (id: string, options: { head: string }) => {
    const { leadDeliveryDecision } = await import("./delivery.ts");
    output(await leadDeliveryDecision(id, options.head, undefined));
  });
program
  .command("merge <bead-id>")
  .description("Request an exact-head merge from an Octo Ready notice")
  .requiredOption("--head <sha>", "Full verified commit SHA")
  .requiredOption("--notice <id>", "Ready notice ID from /octo-inbox")
  .action(async (id: string, options: { head: string; notice: string }) => {
    const { leadDeliveryDecision } = await import("./delivery.ts");
    output(await leadDeliveryDecision(id, options.head, options.notice));
  });
program
  .command("archive <bead-id>")
  .description("Archive a settled lead after Octo confirms its merge")
  .action(async (id: string) => {
    const { archiveLead } = await import("./lead-archive.ts");
    output(await archiveLead(id));
  });
program
  .command("skill")
  .description("Read compact agent guidance without configuration or services")
  .addOption(new Option("--topic <topic>", "Choose a Studio workflow").choices(Object.values(HelpTopic)))
  .action((options: { topic?: string }) => {
    const topics = {
      [HelpTopic.Tasks]:
        "Use studio tasks [FULL_ID] [--json]. Use beadsService.url and projectId for the HTTP workflow. Existing workspace/database/branch settings still support read-only inspection. Containment and blockers remain separate. Observed descriptions are not accepted execution scope.",
      [HelpTopic.Compaction]:
        "Load the Pi package to enable idle compaction. Defaults: five settled minutes AND 60% context use. Active work, drafts, dialogs, queued input, unknown usage, and active child work prevent compaction. Failed attempts do not loop. Pi near-limit compaction remains independent.",
      [HelpTopic.Profile]:
        "Configure one global profile using studio config --example. Choose each role’s provider and model independently. studio config --pi-models --region REGION generates Mantle entries for Pi models.json. /studio-profile applies the configured lead model in Pi.",
      [HelpTopic.Dispatch]:
        "From the repository in Zellij: studio start BEAD_ID -- make test. Supply a check that covers the accepted criteria; omit it for human review. Repeat the command to focus the registered worker. Use /task-submit SUMMARY in its Pi pane. Inspect studio tasks BEAD_ID --json for the result.",
      [HelpTopic.Runtime]:
        "Use studio runtime status --summary for a bounded snapshot with attempt and pending request IDs, or --json for full receipts. In a terminal, Enter opens the task preview. Use studio runtime bead close PROJECT_ID BEAD_ID --reason TEXT or studio runtime bead delete PROJECT_ID BEAD_ID --confirm BEAD_ID to act on one eligible bead in an enrolled project.",
    } satisfies Record<HelpTopic, string>;
    const topic = options.topic === undefined ? undefined : z.enum(HelpTopic).parse(options.topic);
    console.log(
      topic !== undefined
        ? topics[topic]
        : `# Studio\n\nRun studio or studio lead for a daily-driver Pi session in the current directory. No bead or integrations are required. Use studio lead -- PI_OPTIONS for native Pi options, including --continue and --resume. Apply the configured lead model inside Pi with /studio-profile.\n\nCommands: lead, config, doctor, tasks, start, resume.\nTopics: ${Object.keys(topics).join(", ")}. Read one with studio skill --topic NAME.\n\n${topics[HelpTopic.Dispatch]}`,
    );
  });

const completionSetup = `Opt-in, for this shell only (no dotfile changes):
  Bash: source <(studio completion bash)
  Zsh:  autoload -Uz compinit; compinit; source <(studio completion zsh)
  Fish: studio completion fish | source
Or save the output to a file and source it explicitly.
Candidates are static and offline; no task, branch, credential or service lookup.`;

// The final word is the prefix at the cursor, including an empty trailing word.
// Walk Commander metadata only: never parse/execute the requested command.
function completionCandidates(words: string[]): string[] {
  if (words.length > 128 || words.some((word) => word.length > 4096)) return [];
  const prefix = words.at(-1) ?? "";
  let command = program;
  let pending: Option | undefined;
  let positional = 0;
  let help = false;
  const options = () => command.createHelp().visibleOptions(command);
  const commands = () => command.createHelp().visibleCommands(command);
  for (const word of words.slice(0, -1)) {
    if (pending) {
      if (pending.required || !word.startsWith("-")) {
        pending = undefined;
        continue;
      }
      pending = undefined;
    }
    if (word === "--") return [];
    if (word.startsWith("-")) {
      const [flag] = word.split("=", 1);
      const option = options().find((item) => item.short === flag || item.long === flag);
      if (!option) return [];
      if (!word.includes("=") && (option.required || option.optional)) pending = option;
      continue;
    }
    const child = commands().find((item) => item.name() === word || item.aliases().includes(word));
    if (child && positional === 0) {
      // Commander's implicit help command describes its parent's command tree.
      // Do not switch to that synthetic command, which has no children itself.
      if (child.name() === "help") help = true;
      else command = child;
    } else positional++;
  }
  let candidates: string[];
  const equals = prefix.indexOf("=");
  if (pending && (pending.required || !prefix.startsWith("-"))) {
    candidates = pending.argChoices ?? [];
  } else if (prefix.startsWith("-") && equals !== -1) {
    const option = options().find((item) => item.long === prefix.slice(0, equals));
    candidates = (option?.argChoices ?? []).map((value) => `${prefix.slice(0, equals + 1)}${value}`);
  } else if (prefix.startsWith("-")) {
    candidates = options().flatMap((option) =>
      [option.short, option.long].filter((flag): flag is string => flag !== undefined),
    );
  } else {
    candidates = positional === 0 ? commands().map((child) => child.name()) : [];
    if (!help) {
      const argument = command.registeredArguments[positional];
      candidates.push(...(argument?.argChoices ?? []));
    }
  }
  return [...new Set(candidates)].filter((candidate) => candidate.startsWith(prefix)).sort();
}

function completionScript(shell: string): string {
  const header = completionSetup
    .split("\n")
    .map((line) => `# ${line}`)
    .join("\n");
  if (shell === "bash")
    return `${header}
_studio_complete() {
  local candidate word index last=-1 value_prefix=''
  local -a words=()
  # Readline splits '=' by default. Rejoin locally for the CLI query; leave
  # COMP_WORDBREAKS and the user's completion configuration untouched.
  for ((index=1; index<=COMP_CWORD; index++)); do
    word="\${COMP_WORDS[index]}"
    if [[ "$word" == '=' && $last -ge 0 ]]; then
      words[last]="\${words[last]}="
    elif [[ $last -ge 0 && "\${COMP_WORDS[index-1]}" == '=' ]]; then
      words[last]="\${words[last]}$word"
    else
      words+=("$word")
      last=$((last + 1))
    fi
  done
  if [[ $last -ge 0 && "\${words[last]}" == *=* && "$COMP_WORDBREAKS" == *=* ]]; then
    value_prefix="\${words[last]%%=*}="
  fi
  COMPREPLY=()
  while IFS= read -r candidate; do
    candidate="\${candidate#"$value_prefix"}"
    [[ -n "$candidate" ]] && COMPREPLY+=("$candidate")
  done < <(studio completion --query -- "\${words[@]}")
}
complete -F _studio_complete studio
`;
  if (shell === "zsh")
    return `${header}
_studio_complete() {
  local -a candidates
  candidates=("\${(@f)$(studio completion --query -- "\${words[@]:1:$((CURRENT - 1))}")}")
  [[ -n "\${candidates[1]}" ]] && compadd -- "\${candidates[@]}"
}
compdef _studio_complete studio
`;
  return `${header}
function __studio_candidates
  set -l words (commandline -opc)
  set -e words[1]
  set -l current (commandline -ct)
  studio completion --query -- $words "$current"
end
complete -c studio -f -a '(__studio_candidates)'
`;
}

program
  .command("completion")
  .description("Generate opt-in standalone shell completion (offline)")
  .addArgument(new Argument("[shell]", "shell to generate").choices(["bash", "zsh", "fish"]))
  .addOption(new Option("--query", "Query offline candidates").hideHelp())
  .addHelpText("after", `\n${completionSetup}`)
  .action((shell: string | undefined) => {
    if (shell === undefined) throw new Error("Usage: studio completion <bash|zsh|fish>");
    console.log(completionScript(shell));
  });

try {
  // Query tokens are data, not generation arguments (which have shell choices).
  const queryIndex = process.argv.indexOf("--query");
  if (process.argv[2] === "completion" && queryIndex === 3) {
    const separator = process.argv.indexOf("--", queryIndex);
    const candidates = completionCandidates(separator === -1 ? [] : process.argv.slice(separator + 1));
    if (candidates.length > 0) console.log(candidates.join("\n"));
  } else await program.parseAsync();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
