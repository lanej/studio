import {
  implementationRead,
  readImplementation,
  type ImplementationObservation,
  type ImplementationSource,
} from "./implementation.ts";

export interface ImplementationWatchOptions {
  changed: () => void;
  read?: ((source: ImplementationSource) => Promise<ImplementationObservation | undefined>) | undefined;
  pollMs?: number | undefined;
}

/** A read-only observer; selection changes cannot admit an older plan's result. */
export function createImplementationWatch(options: ImplementationWatchOptions) {
  const read = options.read ?? readImplementation;
  const interval =
    options.pollMs !== undefined && Number.isFinite(options.pollMs) && options.pollMs > 0 ? options.pollMs : 5000;
  const pending = new Map<string, Promise<ImplementationObservation | undefined>>();
  let current: ImplementationSource | undefined;
  let key: string | undefined;
  let observed: ImplementationObservation | undefined;
  let generation = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancelTimer = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const active = (expected: string, epoch: number) => !disposed && generation === epoch && key === expected;
  const refresh = async (source: ImplementationSource, expectedKey: string, epoch: number) => {
    const previous = pending.get(expectedKey);
    if (previous) {
      // Returning to A during an A → B → A switch must get a new A read.
      await previous.catch(() => undefined);
    }
    if (!active(expectedKey, epoch)) return;
    const operation = Promise.resolve().then(() => read(source));
    pending.set(expectedKey, operation);
    let result: ImplementationObservation | undefined;
    try {
      result = await operation;
    } catch (error) {
      result = {
        key: expectedKey,
        state: "unavailable",
        message: error instanceof Error ? error.message : "Beads could not be read.",
      };
    } finally {
      if (pending.get(expectedKey) === operation) pending.delete(expectedKey);
    }
    if (!active(expectedKey, epoch)) return;
    observed =
      result?.key === expectedKey
        ? result
        : {
            key: expectedKey,
            state: "unavailable",
            message: "No current Beads observation.",
          };
    options.changed();
    if (!active(expectedKey, epoch)) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (current) request(current, expectedKey, epoch);
    }, interval);
    timer.unref();
  };
  const request = (source: ImplementationSource, expected: string, epoch: number) => {
    refresh(source, expected, epoch).catch(() => {
      // An observer may disappear as its UI is torn down. Stop that observer only.
      if (active(expected, epoch)) cancelTimer();
    });
  };

  return {
    setSource(source: ImplementationSource | undefined): void {
      if (disposed) return;
      const next = !source ? undefined : implementationRead(source);
      current = source;
      if (next?.key === key) return;
      generation++;
      const epoch = generation;
      cancelTimer();
      key = next?.key;
      observed = !next ? undefined : { key: next.key, state: "loading" };
      options.changed();
      if (source && next) request(source, next.key, epoch);
    },
    observation(): ImplementationObservation | undefined {
      return observed;
    },
    dispose(): void {
      disposed = true;
      generation++;
      current = undefined;
      key = undefined;
      observed = undefined;
      cancelTimer();
    },
  };
}
