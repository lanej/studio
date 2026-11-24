# Extraction provenance

Prepared from [lanej/dotfiles at d33526d125a69ea5be9faf12eb8507014d20e170](https://github.com/lanej/dotfiles/tree/d33526d125a69ea5be9faf12eb8507014d20e170). Studio is maintained in [lanej/studio](https://github.com/lanej/studio), with source checkout `~/src/studio`. The extraction snapshot includes the preparation in [dotfiles at a5b3da4e5a3e7f864ec677144ce37bcd21cc1815](https://github.com/lanej/dotfiles/tree/a5b3da4e5a3e7f864ec677144ce37bcd21cc1815/pi/daily-driver).

`vendor/task-runtime` is derived from `tools/task-runtime` at that revision, with Bun commands, strict-lint adaptations, and configured worktree-executable support. Paseo retains its original client. Update the client, schema and generated declarations together, then run `bun run check:beads-api` in the vendor package and Studio acceptance checks. Its Beads schema provenance is in `vendor/task-runtime/api/README.md`.

`resources/socrates` and the generated theme and palette are snapshots from the same revision. Their authoring sources remain in dotfiles. Refresh them deliberately and rerun native Pi resource and terminal acceptance. Keep `LICENSE.session-snap`, `LICENSE.smart-plan`, and `generated/zellij/LICENSE.md` with redistributed source.

`acceptance/install-worktree-manager` retains the checksum-verifying dotfiles installer for the CI fixture version. `acceptance/zellij_pty.py` retains the generic PTY helper from dotfiles; it does not run the workstation navigation detectors. External native tools remain independently installed.

Studio owns its source, installation, and macOS/Linux acceptance. Dotfiles retains the shared resource authors and registers `~/src/studio` as `studio` in `config/project-updates.toml`. External Beads acceptance uses the dotfiles service installer at the CI-pinned revision; this fixture does not make dotfiles a runtime dependency. The generated Zellij protocol revision is pinned independently in `zellij-revision`.

There is no pre-extraction application database to migrate. Existing Beads data and unrelated Pi sessions remain outside this extraction. Studio retains its normal persistent attempt and recovery records for future use.

Optional integrations are disabled by default and are admitted only when configured and present. Core installation and standalone acceptance do not require Beads, Zellij, worktree manager, or Octo; use `--with-integrations` for native delegation acceptance.

`vendor/pi-components` retains the shared selector, condition status and activity primitives, conditions panel, two-column status dock, and foldable inspector from [dotfiles commit b4163590](https://github.com/lanej/dotfiles/tree/b416359039587ca36d0ec9bc0f7509da0833b933/tools/pi-components). The original package owns generic presentation and interaction; Studio owns Socrates properties, evidence, freshness, activity events, and persistence. Refresh the exported sources together and run both the component package's strict check and Studio's native `test:socrates-ui` check. Source export and installation select Git-visible files; snapshots without Git use the explicit `source-files.json` generated at export. Ignored local files are outside that boundary.
