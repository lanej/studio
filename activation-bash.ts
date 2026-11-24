import { AgentSession, ExtensionRunner } from "@earendil-works/pi-coding-agent";

interface Dispatch {
  command: string;
  state: "dispatching" | "execute" | "record" | "executing" | "uncertain";
  result?: Parameters<AgentSession["recordBashResult"]>[1];
}

const pending = new Set<Dispatch>();
const owners = new WeakMap<ExtensionRunner, Dispatch[]>();
let fenced = () => false;
let installed = false;
let intact = () => false;

function admitted(): void {
  if (fenced())
    throw new Error("Studio is checkpointed; user Bash admission is suspended");
}

function finish(runner: ExtensionRunner, dispatch: Dispatch): void {
  pending.delete(dispatch);
  const queue = owners.get(runner);
  if (queue !== undefined)
    owners.set(
      runner,
      queue.filter((entry) => entry !== dispatch),
    );
}

function begin(runner: ExtensionRunner, command: string): Dispatch {
  admitted();
  const dispatch: Dispatch = { command, state: "dispatching" };
  pending.add(dispatch);
  owners.set(runner, [...(owners.get(runner) ?? []), dispatch]);
  return dispatch;
}

/** The pinned unbundled host shares these actual SDK dispatch/write boundaries. */
export function registerNativeBashAdmission(isFenced: () => boolean): void {
  fenced = isFenced;
  if (installed) return;
  installed = true;
  const originalDispatch = Reflect.get(
    ExtensionRunner.prototype,
    "emitUserBash",
  );
  const originalExecute = Reflect.get(AgentSession.prototype, "executeBash");
  const originalRecord = Reflect.get(
    AgentSession.prototype,
    "recordBashResult",
  );
  const dispatch = async function (
    this: ExtensionRunner,
    ...args: Parameters<ExtensionRunner["emitUserBash"]>
  ) {
    const operation = begin(this, args[0].command);
    try {
      const result = await originalDispatch.apply(this, args);
      admitted();
      if (result?.result !== undefined) {
        operation.state = "record";
        operation.result = result.result;
      } else operation.state = "execute";
      // The SDK caller consumes this admission at execute or record, so the
      // await between dispatch and its effect writer never becomes idle.
      return result;
    } catch (error) {
      operation.state = "uncertain";
      throw error;
    }
  };
  const execute = async function (
    this: AgentSession,
    ...args: Parameters<AgentSession["executeBash"]>
  ) {
    admitted();
    const runner = this.extensionRunner;
    const operation =
      owners
        .get(runner)
        ?.find(
          (entry) => entry.command === args[0] && entry.state === "execute",
        ) ?? begin(runner, args[0]);
    operation.state = "executing";
    try {
      const result = await originalExecute.apply(this, args);
      finish(runner, operation);
      return result;
    } catch (error) {
      operation.state = "uncertain";
      throw error;
    }
  };
  const record = function (
    this: AgentSession,
    ...args: Parameters<AgentSession["recordBashResult"]>
  ) {
    admitted();
    const runner = this.extensionRunner;
    const operation = owners
      .get(runner)
      ?.find(
        (entry) =>
          entry.command === args[0] &&
          entry.state === "record" &&
          entry.result === args[1],
      );
    try {
      originalRecord.apply(this, args);
      if (operation !== undefined) finish(runner, operation);
    } catch (error) {
      if (operation !== undefined) operation.state = "uncertain";
      throw error;
    }
  };
  ExtensionRunner.prototype.emitUserBash = dispatch;
  AgentSession.prototype.executeBash = execute;
  AgentSession.prototype.recordBashResult = record;
  intact = () =>
    ExtensionRunner.prototype.emitUserBash === dispatch &&
    AgentSession.prototype.executeBash === execute &&
    AgentSession.prototype.recordBashResult === record;
}

export function nativeBashAdmission(): {
  intact: boolean;
  pending: number;
  uncertain: boolean;
} {
  return {
    intact: intact(),
    pending: pending.size,
    uncertain: [...pending].some(
      (operation) => operation.state === "uncertain",
    ),
  };
}
