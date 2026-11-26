/** Test-owned teardown only: a probe error never grants permission to signal or discard evidence. */
export async function settleOwnedAllocationGroup(steps: {
  probe: () => boolean;
  verify: () => Promise<boolean>;
  signal: () => void;
  wait: () => Promise<void>;
}): Promise<void> {
  if (!steps.probe()) return;
  if (!(await steps.verify())) throw new Error("Cannot verify a surviving owned allocation process group");
  steps.signal();
  await steps.wait();
}

export async function finishAllocationFixture(
  primary: { error: unknown } | undefined,
  steps: {
    abort: () => void;
    stop: () => Promise<void>;
    drain: () => Promise<void>;
    closeReader: () => void;
    closeStore: () => void;
    dispose: (safe: boolean) => Promise<void>;
  },
): Promise<void> {
  const errors: unknown[] = !primary ? [] : [primary.error];
  let settled = false;
  for (const [name, action] of [
    ["abort pending allocation", steps.abort],
    [
      "settle owned process group",
      async () => {
        await steps.stop();
        settled = true;
      },
    ],
    ["drain pending allocation", steps.drain],
    ["close fixture reader", steps.closeReader],
    ["close fixture store", steps.closeStore],
    ["remove or retain fixture", () => steps.dispose(settled)],
  ] as const) {
    try {
      await action();
    } catch (error) {
      errors.push(new Error(`Allocation fixture cleanup: ${name}`, { cause: error }));
    }
  }
  if (errors.length === 0) return;
  if (primary?.error instanceof Error && errors.length === 1) throw primary.error;
  throw new AggregateError(errors, "Allocation fixture failure; original error (when present) precedes cleanup errors");
}
