"""Restore an already handed-off lead for task-panel tests without dispatching workers."""
import json
from pathlib import Path
import subprocess


def task_panel_session(project, env, source, task, message="Inspect approved work"):
    root = Path(__file__).resolve().parents[1]
    script = """
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { Discoveries } from './discovery/store.ts';
import { runtimeProjectSchema } from './config.ts';
import { draftSchema, planDigest } from './planning/plan.ts';
const [project, sourceJson, task, message] = process.argv.slice(1);
const source = JSON.parse(sourceJson);
const session = SessionManager.create(project);
const store = new Discoveries();
const record = store.create(project, session.getSessionId(), 'Handed-off work');
const draft = draftSchema.parse({summary: message, tasks: [{key: 'work', title: message, description: message, acceptance: 'Reviewed'}]});
const target = runtimeProjectSchema.parse({root: record.project, source, base: 'main', beadsWorkspace: record.project, beadsDatabase: 'fixture'});
store.change(record.id, row => {
  row.leadPlan.draft = draft;
  row.approved = planDigest(draft);
  row.graph = {work: task};
  row.handoff = {operation: crypto.randomUUID(), revision: row.revision, digest: row.approved, phase: 'complete', target: {...target, id: source.projectId}};
});
store.close();
session.appendMessage({role:'user', content:message, timestamp:Date.now()});
session.appendCustomEntry('studio:discovery', {id:record.id, project:record.project});
console.log(session.getSessionFile());
"""
    return subprocess.run(["bun", "--no-env-file", "-e", script, str(project), json.dumps(source), task, message],
                          cwd=root, env=env, check=True, capture_output=True, text=True).stdout.strip()
