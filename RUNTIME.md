# Studio runtime

Studio separates the daily-driver lead, the approved work queue, and execution. The lead is a native Pi conversation that remains available for exploration. Beads owns tasks and dependency readiness. Studio stores discovery and execution receipts outside disposable checkouts. The pinned Pi subagent runner executes workers and reviewers in native sessions; the native worktree manager owns their checkouts. Octo owns PR publication, feedback, and merge effects.

## Discovery and approval

Ordinary conversation requires no task. `/socrates` selects a private discovery and records questions and answers before presenting dialogs. `/socrates new TITLE` creates another topic; `/discoveries` lists this project's discoveries and `/socrates UUID` resumes one. Native conversation branch entries select a discovery only for the matching canonical directory. Directory changes and session navigation preserve the original records.

`/spec-freeze` reviews the specification. `/spec-reopen` retains the frozen version before opening a new one. At the end of Socrates, Pi proposes a work breakdown. An explicit `/plan-draft DESCRIPTION` can request one without a specification. `/plan` previews tasks, owned paths, dependencies, verification commands, hold status, and delivery obligations.

`/plan-approve` reviews the displayed proposal before any task creation. Approval binds its digest, specification version, project, and selected profile. Concurrent edits invalidate the displayed approval. A pending or uncertain handoff prevents replacement drafts until the outcome is reconciled. Graph creation uses deterministic IDs and the native atomic batch; oversized graphs fail before mutation. Retrying an uncertain handoff reconciles those same tasks and edges rather than creating another graph.

Approval creates a controller-owned root and executable children in Beads and starts eligible implementation. Held children use Beads' `deferred` status. Dependencies and task state determine admission; existing eligible work in an enrolled project does not need to originate in the current lead. The root is an orchestration container, excluded from worker admission.

## Independent ownership

Enable `runtime.enabled`, configure each project explicitly, and enable the native worktree integration. The configured Beads HTTP project and native CLI workspace/database must agree. HTTP provides atomic claim-next and guarded mutations; the pinned native CLI provides heartbeats. Studio preflights the selected profile and verification isolation before approving a graph or admitting work. Missing integrations fail the affected capability; discovery remains usable. Changed project authority or profile settings suspend admission until a reviewed handoff reenrolls them. Retained incomplete attempts pin their authority and must be reconciled before enrollment settings change; project merge defaults remain adjustable independently.

`studio runtime start` requests a detached supervisor. `studio runtime status` reports the supervisor's PID/start identity, attempts, retained sessions, and effective project merge policy. `studio runtime stop` stops new admission while task hosts continue. Approved work survives closure of all lead terminals. Installation neither enables projects nor proves that an existing process loaded a new release.

The supervisor persists an actor/attempt before claiming work atomically. A lost response is reconciled by that actor, never by a second blind claim. Native checkout allocation and task-host launch retain intent and receipts. An exclusive supervisor fence and task launch tokens prevent competing writers. Unknown launches retain their ownership/path fences; a missing PID is insufficient evidence of settlement. Known dead hosts can recover the same attempt. `studio runtime retry UUID` requires positive reconciliation of the prior writer and verifier.

Concurrency is bounded to two active inference hosts. Overlapping owned paths serialize; an unspecified scope reserves the entire checkout. Delivery-pending work retains its scope but does not consume an inference slot. A project or task failure retains its evidence while independent work can continue. Runtime state lives under `STUDIO_STATE_DIR`, defaulting to `~/.local/state/studio`; native sessions and logs remain there with the attempt records.

## Worker and verifier boundaries

The controller snapshots the accepted task revision, profile, role models, reasoning, checkout identity, and source base. Missing model/authentication fails visibly without cross-profile fallback. Workers receive only bounded checkout read/write/edit and immutable snapshot inspection tools. Reviewers inspect the exact committed revision through read-only snapshot tools. Neither receives shell, nested delegation, policy changes, or GitHub authority.

Every admitted write rechecks the Beads revision/owner and local launch token. Checkout tools reject external paths, `.git`, symbolic links, and files outside accepted ownership. Controller Git operations bind to the registered worktree metadata and disable hooks, filters, external diffs, and merge drivers before processing worker-controlled data. Authorized network Git operations run from the trusted enrolled source.

When provided, an agreed verification command runs in a separately owned process with retained PID/start receipts. macOS uses `sandbox-exec`; Linux requires Bubblewrap and usable user namespaces. Verification can write its disposable source snapshot and private scratch space; the authoritative checkout and selected dependencies remain read-only. A sanitized Git view exposes source objects without the original repository configuration or authentication metadata. It cannot read controller state/authentication, write the host outside its scope, use host network/IPC, or signal the controller. Explicit `verificationReadPaths` can grant additional dependency reads but cannot expose controller state. A missing isolation backend blocks admission; there is no unrestricted fallback. The verifier records command, exit code, immutable Git state, and a bounded output tail. Failing or content-changing verification cannot establish acceptance. Without a command, no executable success is claimed; the independent reviewer must establish the accepted criteria with file evidence.

## Review, integration, and delivery

A worker result is verified, committed, and independently reviewed at that exact head. Actionable findings return to the same assignment for bounded corrections and a fresh review. New scope or authority decisions park the task for assessment. Native transcripts retain the detailed execution history.

Local-only results integrate into a retained `refs/studio/projects/PROJECT_UUID` integration frontier and are reverified/reviewed before guarded Beads completion. Integration intent precedes ref mutation; completion follows confirmed reachability. Successors receive accepted predecessor code. A restart between integration and task closure resumes the same result and cannot release dependencies prematurely. The interactive lead checkout is not changed.

PR-required work needs the optional Octo integration and its configured project publication contract. Octo receives caller-written title/body and exact-head publication intent. The controller retains submission, ownership, inbox evidence, assessment, and merge receipts. Applicable feedback is inspected in full before assessment; delivery and acknowledgment are separate from resolution. Corrections use the same task and PR, followed by current-head verification and independent review.

Automatic merging defaults off per project. The lead-only `studio_project_merge_policy` tool can enable, disable, inspect, or clear that project's override with a recorded actor/reason/time. Overrides work in either direction and survive restart. The controller reevaluates policy before merge. Independent review, assessed feedback, passing current-head checks, current-base mergeability, and Octo's exact-head merge gate remain mandatory. Disabled policy leaves the PR pending while unrelated work progresses. An uncertain merge is retained for reconciliation rather than blindly repeated.

Beads completion for required PR delivery waits for Octo-confirmed merge, fetched remote state, accepted result contents, and retained integration. Merge alone is insufficient task acceptance. No automatic checkout cleanup discards uncertain work. Existing operator-triggered archival still requires retained manifests/transcripts, settled effects, durable Git reachability, and native manager cleanup receipts.

## Acceptance evidence

The native fixtures use the pinned Pi host and runner, actual worktree manager, Beads HTTP/CLI, Dolt, and a deterministic local provider. They cover lead closure during work, separate worker/reviewer sessions, held/dependency admission, atomic readiness changes, deterministic graph reconciliation, and restart after integration before task closure. Separate native isolation fixtures exercise controller-state denial and Git callback suppression. Terminal acceptance captures discovery and breakdown review at narrow and wide widths. Deterministic Octo fixtures exercise delivery policy and receipt handling without real GitHub mutations.

Controlled provider and service fixtures establish runtime wiring and recovery. They do not establish live provider or GitHub delivery acceptance. Source checks, hosted CI, installed release identity, and an already-running process are separate observations. Use the native scripts in `package.json` and inspect their retained results before enabling a live project.
