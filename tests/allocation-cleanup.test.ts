import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finishAllocationFixture, settleOwnedAllocationGroup } from "./helpers/allocation-cleanup.ts";

for (const fault of ["probe", "signal"] as const) {
  await test(`allocation cleanup retains uncertain evidence and drains resources after ${fault} failure`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "studio-allocation-cleanup-"));
    const evidence = join(directory, "evidence.txt");
    await writeFile(evidence, "retained evidence");
    const primary = new Error("Original allocation assertion failed");
    const failure = Object.assign(new Error(`Injected ${fault} EPERM`), {
      code: "EPERM",
    });
    const order: string[] = [];
    let caught: unknown;
    try {
      try {
        await finishAllocationFixture(fault === "probe" ? { error: primary } : undefined, {
          abort: () => {
            order.push("abort");
          },
          stop: () =>
            settleOwnedAllocationGroup({
              probe: () => {
                order.push("probe");
                if (fault === "probe") throw failure;
                return true;
              },
              verify: () => {
                order.push("verify owned group");
                return Promise.resolve(true);
              },
              signal: () => {
                order.push("signal owned group");
                throw failure;
              },
              wait: () => {
                order.push("wait");
                return Promise.resolve();
              },
            }),
          drain: () => {
            order.push("drain");
            return Promise.resolve();
          },
          closeReader: () => {
            order.push("reader");
          },
          closeStore: () => {
            order.push("store");
          },
          dispose: async (safe) => {
            order.push(`dispose:${String(safe)}`);
            if (!safe)
              throw new Error(`Retained allocation fixture at ${directory}: process settlement is unconfirmed`);
            await rm(directory, { recursive: true, force: true });
          },
        });
      } catch (error) {
        caught = error;
      }
      assert.deepEqual(
        order,
        fault === "probe"
          ? ["abort", "probe", "drain", "reader", "store", "dispose:false"]
          : ["abort", "probe", "verify owned group", "signal owned group", "drain", "reader", "store", "dispose:false"],
      );
      assert.ok(caught instanceof AggregateError);
      const errors: unknown[] = caught.errors;
      if (fault === "probe") assert.equal(errors[0], primary);
      else assert.equal(errors.length, 2, "Cleanup-only failures must fail the test too");
      assert.ok(errors.some((error) => error instanceof Error && error.cause === failure));
      assert.ok(
        errors.some(
          (error) => error instanceof Error && error.cause instanceof Error && error.cause.message.includes(directory),
        ),
      );
      assert.equal(await readFile(evidence, "utf8"), "retained evidence");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

await test("unverified groups are not signaled and all independent finalizers report failures", async () => {
  const order: string[] = [];
  const primary = new Error("Primary failure");
  const fail = (name: string): never => {
    order.push(name);
    throw new Error(name);
  };
  let caught: unknown;
  try {
    await finishAllocationFixture(
      { error: primary },
      {
        abort: () => fail("abort"),
        stop: () =>
          settleOwnedAllocationGroup({
            probe: () => {
              order.push("probe");
              return true;
            },
            verify: () => {
              order.push("unverified");
              return Promise.resolve(false);
            },
            signal: () => {
              order.push("UNOWNED SIGNAL");
            },
            wait: () => Promise.resolve(),
          }),
        drain: () => Promise.reject(new Error("drain", { cause: order.push("drain") })),
        closeReader: () => fail("reader"),
        closeStore: () => fail("store"),
        dispose: (safe) => {
          assert.equal(safe, false);
          return Promise.reject(new Error("retained", { cause: order.push("retain") }));
        },
      },
    );
  } catch (error) {
    caught = error;
  }
  assert.deepEqual(order, ["abort", "probe", "unverified", "drain", "reader", "store", "retain"]);
  assert.ok(caught instanceof AggregateError);
  assert.equal(caught.errors[0], primary);
  assert.equal(caught.errors.length, 7);
});

await test("confirmed absent fixture group permits removal and preserves a lone primary error", async () => {
  const primary = new Error("Primary failure without cleanup failures");
  let removed = false;
  await assert.rejects(
    finishAllocationFixture(
      { error: primary },
      {
        abort: () => {},
        stop: () =>
          settleOwnedAllocationGroup({
            probe: () => false,
            verify: () => Promise.reject(new Error("Must not verify absent group")),
            signal: () => {
              throw new Error("Must not signal absent group");
            },
            wait: () => Promise.reject(new Error("Must not wait for absent group")),
          }),
        drain: () => Promise.resolve(),
        closeReader: () => {},
        closeStore: () => {},
        dispose: (safe) => {
          assert.equal(safe, true);
          removed = true;
          return Promise.resolve();
        },
      },
    ),
    (error: unknown) => error === primary,
  );
  assert.equal(removed, true);
});
