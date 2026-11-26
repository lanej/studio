# Studio architecture

Studio organizes source by capability. Pi and CLI entrypoints compose the capabilities needed by each host. Following Pragmatic Hexagonal Architecture, the owning capability supplies the rules and state vocabulary, and its shell gathers facts, calls integrations, and records their outcomes.

## Where to put code

| Change | Location and contract |
| --- | --- |
| A workflow rule or state transition | Put it in the owning capability. Supply the facts the rule needs, including timestamps for transitions that record them. [Specification assessment](../socrates/assessment.ts), [specification freeze](../socrates/freeze.ts), [execution admission](../execution/admission.ts) |
| A Pi command, tool or hook specific to a role | Put it in the receiving role's `extensions/` directory and register it explicitly from the host. Use a file for one adapter and a subdirectory when several files have distinct responsibilities within that adapter. [`lead/extensions/socrates.ts`](../lead/extensions/socrates.ts) |
| A host or provider operation | Keep the operation and its translation at the effect boundary. Use an interface when callers need substitution or isolation. Keep transaction-sensitive guards alongside the authoritative state. [Document hooks](../planning/document-hooks.ts), [inference reservation](../execution/store.ts) |
| A task-specific view or action | Keep display projection with the capability. Bind the panel to its configured task source, which reads Beads and Studio receipts independently and routes actions through execution guards. [Task panel](../tasks/panel.ts), [task source](../tasks/source.ts), [task presentation](../tasks/presentation.ts) |
| A reusable terminal interaction or theme role | Use the shared Pi component API and the active Pi theme. Studio maps workflow state to display values and owns the resulting action. [Pi components](../vendor/pi-components/README.md), [extraction provenance](../EXTRACTION.md) |

Depend inward from the role adapter to capability contracts. Capability rules should be exercisable from supplied values. Make the effect contract explicit when a meaningful next action depends on the outcome. For example, retain launch intent, the process or pane receipt, and uncertainty about an unsettled writer through recovery. The supervisor owns scheduling, Beads owns readiness and claim state, the worktree manager owns checkout allocation, and Octo owns PR publication and merge observations. [Runtime ownership and recovery](../RUNTIME.md#independent-ownership), [delivery](../RUNTIME.md#review-integration-and-delivery)

## Role extensions and host entrypoints

The role that receives the command or tool owns its Pi wiring. The file a host loads can compose more than one role. These are the current paths.

| Role or host | Loading and composition |
| --- | --- |
| Daily lead | Pi loads [`extension.ts`](../extension.ts) from the [package manifest](../package.json). Its [discovery adapter](../discovery/extension.ts) supplies the selected discovery, scoped to the canonical project and conversation branch, and registers the shared lead Socrates controls. |
| Task-bound lead and worker | The [task launcher](../task-run.ts) explicitly loads [`worker-extension.ts`](../worker-extension.ts). A stored lead plan selects the [managed lead controls](../lead/extensions/managed.ts). Session startup verifies the binding before activating the lead tools, and invocation callbacks recheck the binding and authoritative task revision. The ordinary task-bound worker uses [submission wiring](../worker/extensions/submission.ts) and receives its other Pi package registrations from its Pi settings. |
| RPC controller | The [supervisor](../execution/supervisor.ts) explicitly loads [`execution/host-extension.ts`](../execution/host-extension.ts) for an admitted attempt. The controller runs the execution workflow and reconciles its receipts. |
| Interactive and unattended workers | [`execution/worker.ts`](../execution/worker.ts) supplies scoped assignment tools. The [interactive host](../execution/interactive-host.ts) composes the [worker input and session hooks](../worker/extensions/assignment-input.ts) with the current assignment check. The unattended worker runs as an isolated child through [`plugin-runner.mjs`](../plugin-runner.mjs), which disables extension discovery. |
| Reviewer and explorer | The isolated runner and its callers supply role prompts and scoped tools. Runtime review uses committed snapshot tools and its review contract. Delegated review and exploration use the assigned snapshot. Future explicitly admitted Pi adapters follow the same role-local convention, such as `reviewer/extensions/`. [Runtime reviewer](../execution/review.ts), [delegation](../delegation.ts) |

### Socrates through Pi

Both leads call [`lead/extensions/socrates.ts`](../lead/extensions/socrates.ts). The daily adapter supplies discovery records, the selection command and document hooks. The managed adapter supplies the admitted attempt and Beads revision check. Both share the specification model and property assessments, with readiness checks selected for the current binding. [Discovery binding](../discovery/extension.ts), [managed binding](../lead/extensions/managed.ts)

```mermaid
flowchart LR
    Daily["Daily lead"] --> Discovery["Selected discovery"]
    Managed["Task-bound lead"] --> Attempt["Verified attempt and Beads revision"]
    Discovery --> Adapter["Socrates Pi registration"]
    Attempt --> Adapter
    Adapter --> Rules["Specification and freeze decision"]
    Adapter --> View["Question view"]
    View --> Selector["Shared Pi selector and theme"]
```

The registration resolves the bound record, checks the accepted revision and saves the pending question. [`socrates/selector.ts`](../socrates/selector.ts) turns its choices and evidence into component inputs and maps Pi theme roles to the selector. The library renders the choices and handles focus and explicit selection. Studio interprets the result. Escape leaves the saved question available to resume. A submitted answer passes through binding and revision checks again before the optimistic state update records it. [Question handler](../lead/extensions/socrates.ts)

The Dotfiles design system authors shared semantic roles and native mappings. Studio bundles its Nord-derived [palette](../resources/colors.json) and [Pi theme](../resources/theme.json) with contrast adjustments for terminal text. Dotfiles authors `tools/pi-components` and Studio consumes a pinned snapshot under [`vendor/pi-components`](../vendor/pi-components/). Studio's [task presentation](../tasks/presentation.ts) maps task status and worker assignments to terminal text and semantic theme roles for the inspector, sidebar and plan views. Follow [extraction provenance](../EXTRACTION.md) to update the snapshot and keep native focus, cancellation, wrapping and resize checks in scope.

## Core workflow contracts

`LeadSpecification` records the decisions, evidence and accepted revision. `LeadDraft` describes proposed tasks, dependencies, owned paths, verification, delivery and worker assignments. Planning owns the draft schema, graph rules and digest. Socrates prepares a freeze review from the current specification and plan. Pi displays the specification, obtains confirmation, and rechecks the binding and revision. Inside the discovery or attempt store's transaction, Socrates compares the current record with the specification and plan from when the review opened before applying the supplied approval time. [Specification](../socrates/spec.ts), [plan](../planning/plan.ts), [freeze decision](../socrates/freeze.ts)

Plan approval is a separate transition. The discovery contract binds the displayed plan to its specification and revision, and the discovery store evaluates it in the existing transaction against the selected execution target. Execution persists a handoff intent and reconciles uncertain retries against the original task IDs before creating or recovering the Beads graph. The intent decoder accepts older records whose target, draft or worker snapshot is absent. [Discovery approval](../discovery/plan.ts), [execution target](../execution/target.ts), [handoff intent](../execution/handoff-model.ts), [runtime approval](../RUNTIME.md#discovery-and-approval)

Execution yields retained blockers from the ordered attempts. Each blocker can supply its matching paths or whole-checkout scope. The supervisor stops at the first blocker, while the task inspector reads the matching paths for the attempt it displays. Runtime treats unspecified ownership as the whole checkout in the same project. The draft graph uses the same path comparison on the explicitly listed paths of tasks in the same wave. [Admission](../execution/admission.ts), [task projection](../tasks/model.ts), [draft graph](../planning/graph.ts)

Process observation helpers match a PID with its recorded start and probe process groups. The supervisor, allocation and recovery use those observations to keep unsettled writers fenced. Recovery treats missing identity as uncertainty. The execution store supplies the atomic inference reservation. [Process observations](../process.ts), [recovery](../execution/recovery.ts), [inference reservation](../execution/store.ts)

The Pi host checks that the task panel still belongs to the current session and handoff. The task source matches the Beads project and URL against the configured enrollment and supplies the panel with task observations and scoped receipts. The panel owns focus, draft-safe reply input and interaction. Retry and answer requests go through the existing execution guards. [Pi binding](../extension.ts), [task source](../tasks/source.ts), [task panel](../tasks/panel.ts)

## Capability map

| Location | Owns |
| --- | --- |
| [`socrates/`](../socrates/) | Specification and evidence, assessed properties, readiness and revision rules, and Socrates-specific question and status projections. |
| [`discovery/`](../discovery/) | Private discovery records, project and conversation binding, draft ownership and review before handoff to execution. |
| [`planning/`](../planning/) and [`documents/`](../documents/) | Planning document contracts, revisions and guarded saves live with planning. Copydesk provides the protocol, local transport and Neovim runtime. Studio's document host translates document and feedback requests into planning operations. The planning authority records accepted changes and operation witnesses. [Neovim document guide](neovim-documents.md) |
| [`execution/`](../execution/) | Admission, launch, verification, review, integration, delivery and recovery. The shell observes processes and services and persists the receipts. [Runtime contracts](../RUNTIME.md) |
| [`tasks/`](../tasks/) | The configured source, task and worker read models, evidence and task-panel presentation. An operator action uses the guarded execution or Beads operation appropriate to the current owner. |
| [`sessions/`](../sessions/) and [`activation.ts`](../activation.ts) | Conversation forks and prompt loops, plus the separate process and release activation contract. [Activation guide](../ACTIVATION.md) |
| [`code-intelligence/`](../code-intelligence/), [`model-tools/`](../model-tools/) and [`diagram/`](../diagram/) | Language and source observations, model-specific tool dialects, and diagram projection and rendering. Share an operation when several consumers need the same observation. |
| [`scripts/`](../scripts/), [`resources/`](../resources/), [`vendor/`](../vendor/) and [`generated/`](../generated/) | Packaging and launchers, bundled resources, pinned source dependencies and generated protocol bindings. Source and manifest-only exports both include the package entrypoint graph. [Source manifest](../source-files.json) |

When moving a module, update the manifest and any affected path-based workflow selection. Trace both the importers and the explicit loaders. Run `bun run check` and the affected native fixture. For Socrates, exercise the daily lead with `uv run --script acceptance/terminal.py --discovery-only` and the managed lead with `STUDIO_ACCEPTANCE_CASE=socrates bun run test:local`. For worker wiring, use the `accepted` and `interactive-dispatch` native cases. For runtime admission and recovery, run `bun run test:runtime-worker-native` with the fixture's Beads and Dolt paths. The native fixtures use isolated state and a controlled provider. [Acceptance setup](../acceptance/local-run.md), [runtime worker fixture](../acceptance/runtime-worker.ts)
