import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { processStart } from "../process.ts";
import type { ExecutionStore } from "./store.ts";
import { alive } from "./supervisor.ts";
import { groupExists } from "./recovery.ts";

/** Serialize native manager mutations across task hosts while retaining their individual allocation intents. */
export async function withAllocation<T>(
  store: ExecutionStore,
  attempt: string,
  check: () => Promise<void>,
  operation: () => Promise<T>,
): Promise<T> {
  const owner = {
    id: randomUUID(),
    attempt,
    pid: process.pid,
    started: await processStart(process.pid),
  };
  for (;;) {
    await check();
    const previous = store.allocationOwner();
    if (
      (!previous || (!(await alive(previous.pid, previous.started)) && !groupExists(previous.pid))) &&
      store.reserveAllocation(owner, previous?.id)
    )
      break;
    await delay(100);
  }
  try {
    await check();
    return await operation();
  } finally {
    store.releaseAllocation(owner.id);
  }
}
