#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  root, runDir, ensureDir, exists, readJson, readText, writeJson, writeText, now, sha256, pad,
  makeRunId, parseInput, activePath, loadActive, saveActive, loadRun, event, loadWorkflow,
  saveWorkflow, loadChecklist, saveChecklist, loadArtifacts, saveArtifacts, invalidateApproval,
  openItems, nextRunnable, phaseOpenItems, nextCounter, slug, directive, baseChecklist, emit, fail
} from './lib.mjs';

function main() {
  const action = process.argv[2];
  if (!action) return fail('Usage: workflow.mjs <start|plan|next|complete|block|regenerate|interrupt|artifact|snapshot|stage|status> [json]', 'BAD_USAGE');
  try {
    const input = parseInput();
    if (action === 'start') return start(input);
    const { active, dir } = loadRun();
    const wf = loadWorkflow(dir);
    switch (action) {
      case 'plan': return plan(active, dir, wf, input);
      case 'next': return next(active, dir, wf);
      case 'complete': return complete(active, dir, wf, input);
      case 'block': return block(active, dir, wf, input);
      case 'regenerate': return regenerate(active, dir, wf, input);
      case 'interrupt': return interrupt(active, dir, wf, input);
      case 'artifact': return artifact(active, dir, wf, input);
      case 'snapshot': return snapshot(active, dir, wf, input);
      case 'stage': return stage(active, dir, wf, input);
      case 'status': return status(active, dir, wf);
      default: return fail(`Unknown workflow action: ${action}`, 'BAD_USAGE');
    }
  } catch (e) {
    return fail(e?.stack || String(e), e?.message === 'NO_ACTIVE_RUN' ? 'NO_ACTIVE_RUN' : 'RUNTIME_ERROR');
  }
}

main();

function start(input) {
  if (!input.request || typeof input.request !== 'string') return fail('start requires {"request":"..."}', 'BAD_INPUT');
  ensureDir(root());
  if (exists(activePath())) {
    const existing = readJson(activePath());
    if (!input.force_new) return fail(`Active run already exists: ${existing.run_id}. Use interrupt for a new user message or start with force_new:true only when intentionally forking/replacing.`, 'ACTIVE_RUN_EXISTS');
  }
  const run_id = makeRunId();
  const dir = runDir(run_id);
  for (const d of ['requests','observations','phases','checks','outbox']) ensureDir(path.join(dir,d));
  writeText(path.join(dir,'requests','0001.md'), input.request.trim() + '\n');
  writeJson(path.join(dir,'counters.json'), { event:0, observation:0, phase:0, check:0 });
  const wf = {
    version:1, run_id, revision:1, request_revision:1, created_at:now(), updated_at:now(),
    items:[{
      id:'bootstrap-plan', phase:'planning', objective:'Interpret the latest request and produce a durable workflow.',
      status:'running', depends_on:[], acceptance:['A workflow graph and task-specific checklist are persisted before substantive task execution.'],
      expected_evidence:['workflow plan'], evidence_refs:[], response_dependency:'none'
    }]
  };
  writeJson(path.join(dir,'workflow.json'), wf);
  writeJson(path.join(dir,'checklist.json'), { base:baseChecklist(), task:[] });
  writeJson(path.join(dir,'artifacts.json'), { artifacts:[] });
  const active = { version:1, run_id, request_revision:1, workflow_revision:1, state:'PLAN_ONLY', workspace:input.workspace || process.cwd(), created_at:now(), updated_at:now() };
  saveActive(active);
  saveWorkflow(dir, wf);
  event(dir,'run_started',{ request_revision:1, workflow_revision:1 });
  emit(directive({ active, wf, state:'PLAN_ONLY', next_item:wf.items[0],
    allowed:['workflow.plan'],
    forbidden:['task research','task drafting','artifact modification','final answer'],
    prompt:'Before substantive task work, decompose the latest request into a minimal durable workflow. Include explicit acceptance criteria, dependencies, evidence requirements, and task-specific checklist items. Then call workflow.plan. Do not solve the task yet.' }));
}

function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('plan/regenerate requires a non-empty items array');
  const ids = new Set();
  return items.map((x, idx) => {
    const id = String(x.id || `item-${idx+1}`);
    if (ids.has(id)) throw new Error(`duplicate workflow item id: ${id}`); ids.add(id);
    return {
      id, phase:String(x.phase || 'execution'), objective:String(x.objective || '').trim(),
      status:'queued', depends_on:Array.isArray(x.depends_on) ? x.depends_on.map(String) : [],
      acceptance:Array.isArray(x.acceptance) ? x.acceptance.map(String) : [],
      expected_evidence:Array.isArray(x.expected_evidence) ? x.expected_evidence.map(String) : [],
      evidence_refs:[], response_dependency:x.response_dependency || 'none'
    };
  });
}

function plan(active, dir, wf, input) {
  if (active.state !== 'PLAN_ONLY') return fail(`plan is only allowed in PLAN_ONLY; current=${active.state}`, 'INVALID_TRANSITION');
  const fresh = normalizeItems(input.items);
  const bootstrap = [...wf.items].reverse().find(i => i.status === 'running' && i.phase === 'planning' && i.id.startsWith('bootstrap-plan'));
  if (bootstrap) {
    bootstrap.status = 'done';
    bootstrap.completed_at = now();
    bootstrap.evidence_refs = [`workflow-plan:r${wf.revision + 1}`];
  }
  const used = new Set(wf.items.map(i => i.id));
  for (const item of fresh) {
    if (used.has(item.id)) item.id = `req${active.request_revision}-${item.id}`;
    used.add(item.id);
    wf.items.push(item);
  }
  wf.revision += 1;
  wf.request_revision = active.request_revision;
  const task = Array.isArray(input.checklist) ? input.checklist.map((x,i)=>({
    id:String(x.id || `task-${i+1}`), text:String(x.text || x), evidence_required:x.evidence_required !== false, task_specific:true
  })) : [];
  saveChecklist(dir, { base:baseChecklist(), task });
  active.workflow_revision = wf.revision; active.state='EXECUTE'; saveActive(active); invalidateApproval(dir,'workflow planned');
  if (bootstrap) makeSnapshot(dir, wf, 'planning', 'completed', 'Workflow plan persisted before substantive execution.');
  event(dir,'workflow_planned',{ workflow_revision:wf.revision, item_count:fresh.length, checklist_count:task.length });
  const d = nextDirective(active, wf); saveWorkflow(dir,wf); emit(d);
}

function nextDirective(active, wf) {
  const open = openItems(wf);
  if (!open.length) {
    active.state='CHECK'; saveActive(active);
    return directive({ active, wf, state:'CHECK', allowed:['workflow.stage','check.open'], forbidden:['final answer before check READY'],
      prompt:'The durable workflow is empty. Stage the candidate user-facing response with workflow.stage, then call check.open. Do not answer the user before check returns READY.' });
  }
  const item = nextRunnable(wf);
  if (!item) {
    active.state='WAIT_USER'; saveActive(active);
    return directive({ active, wf, state:'WAIT_USER', allowed:['workflow.interrupt','workflow.stage'], forbidden:['claiming completion'],
      prompt:'No workflow item is currently runnable. Resolve an explicit blocker or stage an interaction response only if a user-input/approval dependency cannot be resolved by available tools or best effort.',
      extra:{ open_items:open } });
  }
  if (item.status !== 'running') item.status='running';
  active.state='EXECUTE'; saveActive(active);
  return directive({ active, wf, state:'EXECUTE', next_item:item, allowed:['observe.capture','workflow.complete','workflow.block','workflow.artifact','workflow.snapshot'],
    forbidden:['working on unrelated queued items unless explicitly independent','final answer'],
    prompt:`Work only on workflow item ${item.id}: ${item.objective}. Use normal host tools as needed. Persist any material finding through observe.capture before depending on it later. Complete the item only with evidence references.` });
}

function next(active, dir, wf) {
  const d = nextDirective(active, wf); saveWorkflow(dir,wf); event(dir,'workflow_next',{ state:d.directive.state, item_id:d.directive.next_item?.id || null }); emit(d);
}

function complete(active, dir, wf, input) {
  const id = String(input.item_id || '');
  const item = wf.items.find(x=>x.id===id);
  if (!item) return fail(`Unknown item_id: ${id}`, 'BAD_INPUT');
  if (!['running','runnable','queued'].includes(item.status)) return fail(`Item ${id} cannot be completed from status ${item.status}`, 'INVALID_TRANSITION');
  const evidence = Array.isArray(input.evidence_refs) ? input.evidence_refs.filter(Boolean).map(String) : [];
  if ((item.expected_evidence.length || item.acceptance.length) && evidence.length === 0) return fail(`Item ${id} requires evidence_refs`, 'EVIDENCE_REQUIRED');
  item.status='done'; item.completed_at=now(); item.evidence_refs=evidence; item.result=input.result ? String(input.result) : undefined;
  invalidateApproval(dir,'workflow item completed');
  saveWorkflow(dir,wf); event(dir,'item_completed',{ item_id:id, evidence_refs:evidence });
  const phase = item.phase;
  if (!phaseOpenItems(wf, phase).length) makeSnapshot(dir,wf,phase,'completed',input.phase_summary || null);
  const d = nextDirective(active,wf); saveWorkflow(dir,wf); emit(d);
}

function block(active, dir, wf, input) {
  const id=String(input.item_id||''); const item=wf.items.find(x=>x.id===id);
  if (!item) return fail(`Unknown item_id: ${id}`, 'BAD_INPUT');
  item.status='blocked'; item.blocker=String(input.reason||'unspecified blocker');
  if (input.response_dependency) item.response_dependency=input.response_dependency;
  saveWorkflow(dir,wf); invalidateApproval(dir,'workflow item blocked'); event(dir,'item_blocked',{item_id:id,reason:item.blocker});
  const d = nextDirective(active,wf); saveWorkflow(dir,wf); emit(d);
}

function regenerate(active, dir, wf, input) {
  const reason=String(input.reason||'replan requested'); const fresh=normalizeItems(input.items);
  for (const old of wf.items) if (['queued','runnable','running','blocked'].includes(old.status)) { old.status='superseded'; old.superseded_at=now(); old.superseded_reason=reason; }
  const used=new Set(wf.items.map(i=>i.id));
  for (const n of fresh) { if (used.has(n.id)) n.id=`r${wf.revision+1}-${n.id}`; wf.items.push(n); }
  wf.revision+=1; wf.request_revision=active.request_revision;
  active.workflow_revision=wf.revision; active.state='EXECUTE'; saveActive(active); invalidateApproval(dir,'workflow regenerated');
  if (Array.isArray(input.checklist)) {
    const current=loadChecklist(dir); current.task=input.checklist.map((x,i)=>({id:String(x.id||`task-${i+1}`),text:String(x.text||x),evidence_required:x.evidence_required!==false,task_specific:true})); saveChecklist(dir,current);
  }
  event(dir,'workflow_regenerated',{reason,workflow_revision:wf.revision}); const d=nextDirective(active,wf); saveWorkflow(dir,wf); emit(d);
}

function interrupt(active, dir, wf, input) {
  if (!input.request || typeof input.request!=='string') return fail('interrupt requires {"request":"..."}', 'BAD_INPUT');
  active.request_revision+=1; active.workflow_revision=wf.revision+1; active.state='PLAN_ONLY';
  writeText(path.join(dir,'requests',`${pad(active.request_revision,4)}.md`), input.request.trim()+'\n');
  for (const i of wf.items) if (['queued','runnable','running','blocked'].includes(i.status)) { i.status='superseded'; i.superseded_at=now(); i.superseded_reason='new user interrupt'; }
  wf.revision+=1; wf.request_revision=active.request_revision;
  wf.items.push({ id:`bootstrap-plan-r${active.request_revision}`, phase:'planning', objective:'Interpret the latest request revision and regenerate the durable workflow.', status:'running', depends_on:[], acceptance:['Latest request revision is represented by a new workflow plan.'], expected_evidence:['workflow plan'], evidence_refs:[], response_dependency:'none' });
  saveActive(active); invalidateApproval(dir,'new user request');
  const draft=path.join(dir,'outbox','draft.md'); if(exists(draft)) fs.rmSync(draft);
  const draftMeta=path.join(dir,'outbox','draft.json'); if(exists(draftMeta)) fs.rmSync(draftMeta);
  saveWorkflow(dir,wf); event(dir,'user_interrupt',{request_revision:active.request_revision,workflow_revision:wf.revision});
  emit(directive({active,wf,state:'PLAN_ONLY',next_item:wf.items.at(-1),allowed:['workflow.plan'],forbidden:['continuing stale plan','using prior READY approval','final answer'],prompt:'A new user request revision invalidated prior approval and open work. Re-read the latest request from durable state and call workflow.plan with a regenerated workflow before substantive work.'}));
}

function artifact(active, dir, wf, input) {
  if (!input.path && !input.ref) return fail('artifact requires path or ref', 'BAD_INPUT');
  const data=loadArtifacts(dir); const id=String(input.id || `artifact-${data.artifacts.length+1}`);
  const rec={id, path:input.path?String(input.path):undefined, ref:input.ref?String(input.ref):undefined, description:input.description?String(input.description):undefined, workflow_revision:wf.revision, recorded_at:now()};
  if (rec.path) { const p=path.isAbsolute(rec.path)?rec.path:path.resolve(process.cwd(),rec.path); if(exists(p)&&fs.statSync(p).isFile()) rec.sha256=sha256(fs.readFileSync(p)); }
  data.artifacts=data.artifacts.filter(a=>a.id!==id); data.artifacts.push(rec); saveArtifacts(dir,data); invalidateApproval(dir,'artifact registry changed'); event(dir,'artifact_recorded',{id,path:rec.path,ref:rec.ref});
  emit(directive({active,wf,state:active.state,next_item:nextRunnable(wf),allowed:['workflow.next','observe.capture','workflow.complete'],forbidden:['claiming unverified artifact integrity'],prompt:`Artifact ${id} is durably registered. Continue the current workflow item and reference this artifact as evidence where appropriate.`,extra:{artifact:rec}}));
}

function makeSnapshot(dir,wf,phase,status,summary=null) {
  const n=nextCounter(dir,'phase'); const items=wf.items.filter(i=>i.phase===phase);
  const lines=[`# Phase ${n}: ${phase}`,'',`- Status: ${status}`,`- Workflow revision: ${wf.revision}`,`- Captured: ${now()}`,'', '## Objective / items','',...items.map(i=>`- [${i.status}] ${i.id}: ${i.objective}`),'','## Validated evidence','',...items.flatMap(i=>(i.evidence_refs||[]).map(e=>`- ${i.id}: ${e}`))];
  if(summary) lines.push('','## Summary','',String(summary));
  const p=path.join(dir,'phases',`${pad(n,3)}-${slug(phase)}.md`); writeText(p,lines.join('\n')+'\n'); event(dir,'phase_snapshot',{phase,status,path:p}); return p;
}
function snapshot(active,dir,wf,input){ const phase=String(input.phase || nextRunnable(wf)?.phase || 'current'); const p=makeSnapshot(dir,wf,phase,input.status||'suspended',input.summary||null); emit(directive({active,wf,state:active.state,next_item:nextRunnable(wf),allowed:['workflow.next','workflow.stage'],forbidden:['forgetting unresolved work'],prompt:`Phase state persisted at ${p}. Continue from durable workflow state; this snapshot is a lossy recovery artifact, not a replacement for primary artifacts.`,extra:{snapshot:p}})); }

function stage(active, dir, wf, input) {
  const mode=String(input.mode||''); const content=String(input.content||'');
  if (!['final','interaction','progress'].includes(mode) || !content.trim()) return fail('stage requires mode final|interaction|progress and non-empty content', 'BAD_INPUT');
  const open=openItems(wf);
  if (mode==='final' && open.length) return fail(`Cannot stage final response with ${open.length} open workflow item(s).`, 'WORKFLOW_NOT_EMPTY');
  if (mode==='interaction' && !open.some(i=>i.status==='blocked' && ['user_input','approval'].includes(i.response_dependency))) return fail('interaction mode requires an explicit blocked user_input/approval item', 'INVALID_INTERACTION');
  if (mode==='progress' && !open.length) return fail('progress mode is only for incomplete workflows', 'INVALID_PROGRESS');
  invalidateApproval(dir,'new draft staged');
  writeText(path.join(dir,'outbox','draft.md'),content);
  writeJson(path.join(dir,'outbox','draft.json'),{mode,run_id:active.run_id,request_revision:active.request_revision,workflow_revision:wf.revision,sha256:sha256(content),staged_at:now()});
  active.state='CHECK'; saveActive(active); event(dir,'response_staged',{mode,sha256:sha256(content)});
  emit(directive({active,wf,state:'CHECK',allowed:['check.open'],forbidden:['sending staged draft','editing draft outside runtime'],prompt:'A user-facing response is staged but not approved. Call check.open now. Do not answer the user from outbox/draft.md unless the mandatory check returns READY.'}));
}

function status(active,dir,wf){ emit(directive({active,wf,state:active.state,next_item:nextRunnable(wf),allowed:['workflow.next','recover','check.open'],forbidden:['inferring completion from conversation memory'],prompt:'Use this durable status as authoritative. Continue with the next permitted runtime call.',extra:{open_items:openItems(wf),current:path.join(dir,'CURRENT.md')}})); }
