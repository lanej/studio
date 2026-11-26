# Studio

When writing or updating a pull request description, follow the [PR template](.github/pull_request_template.md), including its screenshot guidance for UI changes.

Use an environment-provided Bun satisfying `package.json`'s `engines.bun` minimum for dependency installation, commands, checks, and managed Pi hosts. Do not bundle or privately install a runtime. Preserve the strict TypeScript profile; run `bun run check` and the native acceptance check affected by a change. Node-compatible imports do not require the Node executable.

Keep the package usable outside dotfiles. Read `EXTRACTION.md` before updating vendored clients, guidance, theme resources, or generated bindings. Preserve upstream license notices. External Beads, Zellij, worktree manager, and Octo integrations are optional and remain separate authorities. Gate their effects on explicit configuration and availability; keep core commands usable without them.

Keep persistent status surfaces passive. Use floating panes to browse and inspect tasks. Open the worker’s question and reply field in a drawer immediately above the lead editor. While answering, preserve the lead draft and return focus to the same task on dismissal. Expose pane actions as slash commands. Global pane shortcuts are opt-in through Studio configuration. Drive focused pane controls and their hints from the same keybindings. Preserve the lead draft and sidebar or dock layout when a pane opens and closes.

The pre-extraction application has no database contents to migrate. Persist new attempts and recovery state during normal operation. Preserve user settings, credentials, active sessions, retained transcripts, and uncertain execution attempts. Installation and successful checks do not establish that a running session loaded the new version. Keep Markdown paragraphs on one source line.

## Architecture

Read the [Studio architecture guide](docs/architecture.md) before adding or moving source. Put Pi command, tool and event wiring in the receiving role's `extensions/` directory and compose it explicitly for that host. Supply observed facts to decision functions in the owning capability and reuse their results for enforcement and operator explanations. Evaluate atomic guards at the authoritative state boundary. Use shared Pi components and semantic theme roles for reusable terminal presentation. When a boundary changes, update the guide and exercise its normal entrypoint.
