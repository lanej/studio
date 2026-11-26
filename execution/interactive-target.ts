import { realpath } from "node:fs/promises";
import { z } from "zod";
import { tabId, Zellij } from "../zellij.ts";
import { processStart } from "../process.ts";
import {
  ExecutionPhase,
  type Execution,
  type InteractiveTarget,
} from "./store.ts";

export async function currentInteractiveTarget(): Promise<InteractiveTarget> {
  const session = z
    .string()
    .min(1, "Approve interactive work from a live Zellij pane")
    .parse(process.env["ZELLIJ_SESSION_NAME"] ?? "");
  const zellij = new Zellij(session);
  const tab = await zellij.launchTab();
  await zellij.requireUnsharedTab(tab);
  return { session, socket: zellij.identity, tab };
}

export async function verifyInteractiveTarget(
  target: InteractiveTarget,
): Promise<Zellij> {
  const zellij = new Zellij(target.session);
  if (zellij.identity !== target.socket)
    throw new Error("The approved tab belongs to a different Zellij server");
  await zellij.requireUnsharedTab(target.tab);
  return zellij;
}

export function currentPaneId(): number {
  const value = (process.env["ZELLIJ_PANE_ID"] ?? "").replace(
    /^terminal_/u,
    "",
  );
  return tabId(value);
}

export async function requireInteractivePane(
  target: InteractiveTarget,
  pane: number,
  token: string,
  repository: string,
): Promise<Zellij> {
  if (process.env["ZELLIJ_SESSION_NAME"] !== target.session)
    throw new Error("Open the approved Zellij session to reach this worker");
  const zellij = await verifyInteractiveTarget(target);
  const current = (await zellij.panes()).find(
    (item) =>
      item.id === pane &&
      item.tab_id === target.tab &&
      !item.is_plugin &&
      !item.exited,
  );
  if (
    current?.terminal_command?.split(/\s+/u).includes(token) !== true ||
    current.pane_cwd == null ||
    (await realpath(current.pane_cwd)) !== repository
  )
    throw new Error(
      "The registered Pi pane changed or exited. Inspect the retained attempt before retrying",
    );
  return zellij;
}

export function hasInteractivePane(attempt: Execution): boolean {
  return (
    attempt.interactive !== undefined &&
    attempt.interactive.session === process.env["ZELLIJ_SESSION_NAME"] &&
    !attempt.launchSettled &&
    attempt.phase === ExecutionPhase.Running &&
    attempt.pane !== undefined &&
    attempt.workerSessionFile !== undefined
  );
}

export async function focusInteractivePane(
  attempt: Execution,
  repository: string,
  signal?: AbortSignal,
): Promise<void> {
  const { interactive, pane, launchToken, pid, started } = attempt;
  if (
    !hasInteractivePane(attempt) ||
    interactive === undefined ||
    pane === undefined ||
    launchToken === undefined ||
    pid === undefined ||
    started === undefined ||
    (await processStart(pid)) !== started
  )
    throw new Error(
      `Attempt ${attempt.id} has no live worker in this session. Inspect its retained transcript and checkout.`,
    );
  const zellij = await requireInteractivePane(
    interactive,
    pane,
    launchToken,
    repository,
  );
  signal?.throwIfAborted();
  await zellij.focus(pane);
}
