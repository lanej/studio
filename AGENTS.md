# Studio

When writing or updating a pull request description, follow the [PR template](.github/pull_request_template.md), including its screenshot guidance for UI changes.

Use an environment-provided Bun satisfying `package.json`'s `engines.bun` minimum for dependency installation, commands, checks, and managed Pi hosts. Do not bundle or privately install a runtime. Preserve the strict TypeScript profile; run `bun run check` and the native acceptance check affected by a change. Node-compatible imports do not require the Node executable.

Keep the package usable outside dotfiles. Read `EXTRACTION.md` before updating vendored clients, guidance, theme resources, or generated bindings. Preserve upstream license notices. External Beads, Zellij, worktree manager, and Octo integrations are optional and remain separate authorities. Gate their effects on explicit configuration and availability; keep core commands usable without them.

Keep persistent status surfaces passive. Put selection, inspection, and editing in explicitly opened floating panes. Preserve the lead draft and sidebar or dock layout when a pane opens and closes.

The pre-extraction application has no database contents to migrate. Persist new attempts and recovery state during normal operation. Preserve user settings, credentials, active sessions, retained transcripts, and uncertain execution attempts. Installation and successful checks do not establish that a running session loaded the new version. Keep Markdown paragraphs on one source line.
