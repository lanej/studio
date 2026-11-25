"""Exercise the live worker roster against owned fixture receipts in an approved lead."""
import json
from pathlib import Path
import subprocess

question = "If the selected bead disappears on refresh, should focus move to its parent?"
draft = "Keep the graph visible while I inspect the worker."
worker_prompt = "Walk me through the focus change before I answer the worker."
worker_reply = """The lead keeps the draft and cursor while you inspect an assignment.

If the selected bead still exists after a refresh, the graph keeps that selection. If the bead has disappeared, the worker needs a rule for where focus should land.

The parent is a reasonable choice when it remains in the graph. It preserves the context of the original task. The next visible row is another option when the parent is gone.

Answering the question resumes the same assignment. The reviewer can then check that the agreed fallback works on the updated graph.

The resize and draft-preservation assignments can continue independently while you decide."""


def check_worker_sidebar(terminal_type, project, env, output, authority, served_beads, ready_draft):
    root = Path(__file__).resolve().parents[1]
    source = """
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { Discoveries } from './discovery/store.ts';
import { draftSchema, planDigest } from './lead-plan.ts';
import { runtimeProjectSchema } from './config.ts';
import { coverageToken } from './socrates/assessment.ts';
import { ExecutionStore, executionSchema } from './execution/store.ts';
const [project, sourceJson, question, draftJson] = process.argv.slice(1);
const authority = JSON.parse(sourceJson);
const session = SessionManager.create(project);
const discoveries = new Discoveries();
const runtime = new ExecutionStore();
const record = discoveries.create(project, session.getSessionId(), 'Lead focus and graph navigation');
const titles = {
  base: 'Record the graph selection',
  restore: 'Restore the selected graph node',
  resize: 'Keep the graph visible on resize',
  review: 'Preserve the draft when focus changes',
};
const tasks = Object.entries(titles).map(([key,title]) => ({
  key,title, description:title, acceptance: 'Keep the lead usable through refresh.',
  blockedBy: key === 'base' ? [] : ['base'], owns:[key+'.ts'], requirements:['R1'],
}));
const graph = draftSchema.parse({summary:'Preserve the lead draft across graph navigation.', tasks});
const target = runtimeProjectSchema.parse({root:project, source:authority, profile:'personal', base:'main', beadsWorkspace:project, beadsDatabase:'fixture'});
const linked = discoveries.change(record.id, row => {
  row.specification = {status:'frozen',version:1,acceptedRevision:row.revision,draft:JSON.parse(draftJson)};
  row.specification.coverageRevision = coverageToken(row.specification);
  row.leadPlan.draft = graph;
  row.approved = planDigest(graph);
  row.graph = Object.fromEntries(tasks.map(task => [task.key, 'worker-'+task.key]));
  row.graph.root = 'worker-root';
  row.handoff = {operation:crypto.randomUUID(), revision:row.revision, digest:row.approved, phase:'complete',target:{...target,id:authority.projectId}};
});
const beads = {};
for (const task of tasks) {
  const id = crypto.randomUUID();
  const bead = {id:linked.graph[task.key],title:task.title,status:task.key==='base'?'closed':'in_progress',
    assignee:task.key==='base'?'':'pi:'+id, revision:'fixture-revision', acceptance_criteria:task.acceptance,
    metadata:{'studio.graph':linked.revision,'studio.approval':linked.approved,'studio.task':task}};
  beads[bead.id] = bead;
  if(task.key==='base') continue;
  const launchToken = crypto.randomUUID();
  runtime.saveAttempt(executionSchema.parse({id,project:authority.projectId,bead,revision:bead.revision,profile:'personal',
    phase:{restore:'awaiting-decision',resize:'running',review:'reviewing'}[task.key],launchToken,message:'',
    operatorDecisions:task.key==='restore'?[{id:crypto.randomUUID(),at:new Date().toISOString(),question,
      binding:{project:authority.projectId,bead:bead.id,revision:bead.revision,launchToken,contract:'a'.repeat(64)}}]:undefined}));
}
session.appendMessage({role:'user',content:'Keep the lead usable while workers implement graph navigation.',timestamp:Date.now()});
session.appendMessage({role:'assistant',content:[{type:'text',text:'The approved graph has four beads. The selection record is complete, so the three dependent assignments can proceed.\\n\\nThe implementation graph shows their dependencies. Each worker below it is linked to the bead it owns.'}],
  api:'openai-completions',provider:'fixture',model:'tiny',stopReason:'stop',timestamp:Date.now(),
  usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
session.appendCustomEntry('studio:discovery',{id:linked.id,project});
console.log(JSON.stringify({beads,session:session.getSessionFile()}));
runtime.close();
discoveries.close();
"""
    result = subprocess.run(
        ["bun", "--no-env-file", "-e", source, str(project), json.dumps(authority), question, json.dumps(ready_draft)],
        cwd=root, env=env, text=True, capture_output=True, timeout=30,
    )
    if result.returncode:
        raise AssertionError(result.stderr)
    fixture = json.loads(result.stdout)
    served_beads.update(fixture["beads"])
    console = terminal_type(project, env, output, fixture["session"])
    try:
        def roster():
            return console.rail_text().partition("Workers")[2]

        console.wait(lambda: all(label in roster() for label in ("Needs input", "Implementing", "Reviewing")),
                     "Current workers and reviewer did not appear below the graph")
        assert question in " ".join(roster().split()), roster()
        assert "2 active · 1 needs you" in roster(), roster()
        console.send(worker_prompt + "\r")
        console.wait(lambda: "while you decide." in console.text(), "The lead did not finish its reply")
        console.send(draft)
        console.contains(draft)
        assert "Alt+W" in roster(), roster()
        assert "at processTicksAndRejections" not in console.text(), console.text()
        console.capture("worker-sidebar")
        console.send("\x1bw")
        console.contains("Enter inspect")
        console.send(" ")
        console.wait(lambda: "▸ Workers" in console.rail_text() and "Implementing" not in roster(),
                     "Folding the roster did not keep its summary")
        console.send(" ")
        console.wait(lambda: "Implementing" in roster(), "The worker roster did not unfold")
        console.send("j")
        console.wait(lambda: "› Keep the graph visible" in console.rail_text(),
                     "Selecting a worker did not highlight its graph node")
        console.send("\r")
        console.contains("Brief & acceptance")
        console.send("q")
        console.wait_for_rail()
        console.contains(draft)
        console.resize(60, 24)
        console.contains("1 needs you")
        console.contains(draft)
        console.capture("worker-dock")
        console.resize(128, 34)
        console.wait_for_rail()
        console.send("\x1bw")
        console.contains("Enter inspect")
        # A reassignment invalidates the selection and returns input to the lead.
        served_beads["worker-resize"]["assignee"] = "pi:replacement"
        console.wait(lambda: "Implementing" not in roster() and "1 active" in roster(),
                     "The worker receipt outlived its Beads ownership", timeout=12)
        console.send(" Still here.")
        console.contains(draft + " Still here.")
    finally:
        console.close()
