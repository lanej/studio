import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { stateDirectory } from "../attempts.ts";
import {
  commitOperation,
  initializeOperationWitnesses,
  transaction,
  type OperationWitness,
} from "../operation-witness.ts";
import { LeadMode, type PlanWorkers } from "../planning/plan.ts";
import { discoverySchema, HandoffPhase, type Discovery, type DiscoveryHandoff } from "./model.ts";
import { bindHandoffApproval, prepareHandoff } from "./plan.ts";

/** Discovery is private conversational state, not another task backlog. */
export class Discoveries {
  private readonly db: Database;
  constructor(directory = stateDirectory()) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new Database(join(directory, "discoveries.sqlite"), {
      create: true,
    });
    this.db.run("PRAGMA busy_timeout=5000");
    this.db.run(
      "CREATE TABLE IF NOT EXISTS discoveries (id TEXT PRIMARY KEY, project TEXT NOT NULL, record TEXT NOT NULL)",
    );
    initializeOperationWitnesses(this.db);
  }
  beginHandoff(
    expected: Discovery,
    target: DiscoveryHandoff["target"],
    owner?: DiscoveryHandoff["owner"],
    recoverPending = false,
    workers?: PlanWorkers,
  ): Discovery {
    const approval = bindHandoffApproval(expected);
    return this.change(
      approval.id,
      (row) => {
        const handoff = prepareHandoff(row, approval, {
          target,
          owner,
          recoverPending,
          workers,
        });
        row.handoff = {
          ...handoff,
          operation: handoff.operation ?? randomUUID(),
        };
      },
      true,
    );
  }
  close(): void {
    this.db.close();
  }
  list(project: string): Discovery[] {
    return this.db
      .query("SELECT record FROM discoveries WHERE project=? ORDER BY rowid DESC")
      .all(realpathSync(project))
      .map(decode);
  }
  find(id: string): Discovery | undefined {
    const row = this.db.query("SELECT record FROM discoveries WHERE id=?").get(id);
    return row === null ? undefined : decode(row);
  }
  get(id: string): Discovery {
    const record = this.find(id);
    if (!record) throw new Error(`Unknown discovery: ${id}`);
    return record;
  }
  create(project: string, conversation: string, title: string): Discovery {
    const record: Discovery = {
      id: randomUUID(),
      title,
      project: realpathSync(project),
      conversation,
      revision: randomUUID(),
      history: [],
      leadPlan: { mode: LeadMode.Planning, draft: null },
    };
    this.db.query("INSERT INTO discoveries VALUES (?,?,?)").run(record.id, record.project, JSON.stringify(record));
    return record;
  }
  change(id: string, update: (record: Discovery) => void, handoff = false): Discovery {
    return transaction(this.db, () => this.update(id, update, handoff));
  }
  changeWithWitness(
    id: string,
    operationId: string,
    command: string,
    update: (record: Discovery) => void,
    result: (record: Discovery) => string,
  ): OperationWitness {
    return commitOperation(this.db, id, operationId, command, () => result(this.update(id, update)));
  }
  private update(id: string, update: (record: Discovery) => void, handoff = false): Discovery {
    const record = this.get(id);
    if (!handoff && record.handoff && record.handoff.phase !== HandoffPhase.Complete)
      throw new Error("The approved handoff is pending or uncertain; reconcile it before editing this discovery");
    update(record);
    const checked = discoverySchema.parse(record);
    this.db.query("UPDATE discoveries SET record=? WHERE id=?").run(JSON.stringify(checked), id);
    return checked;
  }
}

function decode(value: unknown): Discovery {
  return discoverySchema.parse(JSON.parse(z.object({ record: z.string() }).parse(value).record));
}
