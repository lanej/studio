import { safeGit } from "./git.ts";
import { verificationSandbox } from "./sandbox.ts";
import { z } from "zod";
import { gitState, runCheck } from "../task-verification.ts";
import { processStart, processFailure } from "../process.ts";
import { ExecutionStore, VerificationPhase } from "./store.ts";
import { alive } from "./supervisor.ts";
import { ExecutionBeads } from "./beads.ts";

/** A verifier keeps its timeout and parent-liveness guard even if its control host dies. */
export async function runVerification(id: string, token: string): Promise<void> {
  z.uuid().parse(token);
  const store = new ExecutionStore();
  const abort = new AbortController();
  const parent = store.attempt(id);
  const started = await processStart(process.pid);
  let timer: ReturnType<typeof setInterval> | undefined;
  let monitoring: Promise<void> | undefined;
  try {
    if (
      parent.launchToken !== token ||
      parent.pid === undefined ||
      parent.started === undefined ||
      !parent.checkout ||
      !parent.verification ||
      parent.verifier?.phase !== VerificationPhase.Launching
    )
      throw new Error("No matching admitted verification intent");
    const project = store.project(parent.project);
    const service = new ExecutionBeads(project.source);
    const checkout = parent.checkout;
    const git = (args: string[], env?: NodeJS.ProcessEnv) =>
      safeGit(project.root, checkout.path, args, {
        ...(env?.["GIT_INDEX_FILE"] === undefined ? {} : { indexFile: env["GIT_INDEX_FILE"] }),
      });
    const parentPid = parent.pid;
    const parentStart = parent.started;
    store.change(id, (row) => {
      if (row.launchToken !== token || row.pid !== parentPid || row.verifier?.phase !== VerificationPhase.Launching)
        throw new Error("Verification authority changed before startup");
      row.verifier = {
        phase: VerificationPhase.Running,
        pid: process.pid,
        started,
      };
    });
    const fence = async (): Promise<void> => {
      if (!(await alive(parentPid, parentStart)))
        throw new Error("The admitted control host exited during verification");
      const current = store.attempt(id);
      if (current.launchToken !== token || current.pid !== parentPid || !current.bead || current.revision === undefined)
        throw new Error("Verification owner changed");
      await service.requireCurrent(current.bead, current.revision, id);
    };
    await fence();
    timer = setInterval(() => {
      if (monitoring) return;
      monitoring = fence()
        .catch(() => {
          abort.abort();
        })
        .finally(() => {
          monitoring = undefined;
        });
    }, 1000);
    const before = await gitState(parent.checkout.path, parent.checkout.branch, git);
    if (before.gitHead !== parent.verification.gitHead || before.gitState !== parent.verification.gitState)
      throw new Error("The checkout changed after verification was admitted");
    const sandbox = await verificationSandbox(parent.checkout.path, parent.check, project.verificationReadPaths, {
      projectRoot: project.root,
      tree: before.gitState,
      branch: checkout.branch,
    });
    let result: Awaited<ReturnType<typeof runCheck>>;
    try {
      result = await runCheck(
        sandbox.argv,
        sandbox.cwd,
        AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]),
        async (pid) => {
          const childStart = await processStart(pid).catch((error: unknown) => {
            if (processFailure(error).code === 1) return undefined;
            throw error;
          });
          store.change(id, (row) => {
            if (row.launchToken !== token || row.verifier?.pid !== process.pid)
              throw new Error("Verification receipt owner changed");
            row.verifier.childPid = pid;
            row.verifier.childStarted = childStart;
          });
        },
        sandbox.environment,
      );
      await sandbox.assertSourceUnchanged();
    } finally {
      await sandbox.close();
    }
    const after = await gitState(parent.checkout.path, parent.checkout.branch, git);
    if (before.gitHead !== after.gitHead || before.gitState !== after.gitState)
      throw new Error("Verification changed checkout contents or identity");
    await fence();
    store.change(id, (row) => {
      if (row.launchToken !== token || row.verifier?.pid !== process.pid || !row.verification)
        throw new Error("Verification result is for a retired owner");
      row.verification = {
        ...row.verification,
        exitCode: result.exitCode,
        output: result.output,
      };
      row.verifier.phase = VerificationPhase.Complete;
    });
    if (result.exitCode !== 0) throw new Error(`Agreed verification failed: ${result.output}`);
  } catch (error) {
    store.change(id, (row) => {
      if (row.launchToken === token && row.verifier?.pid === process.pid) {
        if (row.verification) {
          if (row.verifier.phase !== VerificationPhase.Complete) row.verification.exitCode = -1;
          row.verification.reason = processFailure(error).message;
        }
        row.verifier.phase = VerificationPhase.Complete;
      }
    });
    throw error;
  } finally {
    if (timer) clearInterval(timer);
    await monitoring;
    store.close();
  }
}
