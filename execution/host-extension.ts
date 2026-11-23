import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { executeAssignment } from "./worker.ts";
import { ExecutionStore, ExecutionPhase, VerificationPhase } from "./store.ts";
import { processFailure } from "../process.ts";
import { z } from "zod";

export default function runtimeHost(pi: ExtensionAPI): void {
  const id = z.uuid().parse(process.env["STUDIO_RUN_ID"]);
  const token = z.uuid().parse(process.env["STUDIO_LAUNCH_TOKEN"]);
  const controller = new AbortController();
  process.once("SIGTERM", () => {
    controller.abort();
  });
  process.once("SIGINT", () => {
    controller.abort();
  });
  pi.on("session_start", async (_event, ctx) => {
    const store = new ExecutionStore();
    try {
      await executeAssignment(pi, ctx, id, controller.signal, token);
    } catch (error) {
      store.change(id, (record) => {
        if (
          record.launchToken !== token ||
          (record.pid !== undefined && record.pid !== process.pid)
        )
          return;
        record.launchSettled =
          record.verifier === undefined ||
          record.verifier.phase === VerificationPhase.Complete;
        record.phase =
          !record.launchSettled || controller.signal.aborted
            ? ExecutionPhase.Uncertain
            : ExecutionPhase.Parked;
        record.message = processFailure(error).message;
      });
      console.error(processFailure(error).message);
      process.exitCode = 1;
    } finally {
      store.change(id, (record) => {
        if (
          record.launchToken === token &&
          record.phase === ExecutionPhase.Complete
        )
          record.launchSettled = true;
      });
      store.close();
      // The control host has no human input stream; all child sessions are settled by executeAssignment.
      setTimeout(() => {
        process.exit(process.exitCode ?? 0);
      }, 0);
    }
  });
}
