#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  parseInput, loadRun, loadWorkflow, loadChecklist, loadArtifacts, readJson, readText, writeJson, writeText,
  exists, sha256, nextCounter, pad, now, openItems, nextRunnable, verifyArtifacts, invalidateApproval,
  saveWorkflow, saveActive, event, directive, emit, fail
} from './lib.mjs';

function main() {
  const action=process.argv[2];
  if(!action) return fail('Usage: check.mjs <open|submit|consume> [json]', 'BAD_USAGE');
  try {
    const input=parseInput();
    const {active,dir}=loadRun();
    const wf=loadWorkflow(dir);
    if(action==='open') return openCheck(active,dir,wf);
    if(action==='submit') return submitCheck(active,dir,wf,input);
    if(action==='consume') return consume(active,dir,wf,input);
    return fail(`Unknown check action: ${action}`,'BAD_USAGE');
  } catch(e) { return fail(e?.stack||String(e),'RUNTIME_ERROR'); }
}

function draftState(dir) {
  const metaPath=path.join(dir,'outbox','draft.json'); const bodyPath=path.join(dir,'outbox','draft.md');
  if(!exists(metaPath)||!exists(bodyPath)) throw new Error('NO_STAGED_DRAFT');
  const meta=readJson(metaPath); const body=readText(bodyPath); return {meta,body,hash:sha256(body)};
}

function allChecklist(dir) {
  const c=loadChecklist(dir); return [...(c.base||[]),...(c.task||[])];
}

function mechanical(active,dir,wf,draft) {
  const open=openItems(wf); const artifactFailures=verifyArtifacts(dir);
  const acceptanceFailures=wf.items.filter(i=>i.status==='done' && ((i.acceptance||[]).length||(i.expected_evidence||[]).length) && !(i.evidence_refs||[]).length).map(i=>i.id);
  const phaseFiles=exists(path.join(dir,'phases')) ? fs.readdirSync(path.join(dir,'phases')).filter(f=>f.endsWith('.md')) : [];
  return {
    'latest-request': { pass:draft.meta.request_revision===active.request_revision, detail:`draft request r${draft.meta.request_revision}; active r${active.request_revision}` },
    'workflow-empty-final': { pass:draft.meta.mode!=='final' || open.length===0, detail:`mode=${draft.meta.mode}; open=${open.length}` },
    'acceptance-evidence': { pass:acceptanceFailures.length===0, detail:acceptanceFailures.length?`missing evidence: ${acceptanceFailures.join(', ')}`:'all completed evidence-bearing items have evidence refs' },
    'artifact-integrity': { pass:artifactFailures.length===0, detail:artifactFailures.length?artifactFailures.join('; '):'registered path artifacts exist and hashes match' },
    'draft-exact': { pass:draft.hash===draft.meta.sha256 && draft.meta.workflow_revision===wf.revision && draft.meta.request_revision===active.request_revision, detail:`hash=${draft.hash}; staged=${draft.meta.sha256}; draft wf=${draft.meta.workflow_revision}; active wf=${wf.revision}` },
    '_mode': { pass:(draft.meta.mode==='final'&&open.length===0)||(draft.meta.mode==='progress'&&open.length>0)||(draft.meta.mode==='interaction'&&open.some(i=>i.status==='blocked'&&['user_input','approval'].includes(i.response_dependency))), detail:`mode=${draft.meta.mode}; open=${open.length}` },
    '_phase': { pass:phaseFiles.length>0 || !wf.items.some(i=>i.status==='done'), detail:`phase snapshots=${phaseFiles.length}` }
  };
}

function openCheck(active,dir,wf) {
  const draft=draftState(dir); const checklist=allChecklist(dir); const mech=mechanical(active,dir,wf,draft);
  const id=nextCounter(dir,'check');
  const record={id,opened_at:now(),status:'OPEN',run_id:active.run_id,request_revision:active.request_revision,workflow_revision:wf.revision,draft_sha256:draft.hash,mode:draft.meta.mode,checklist,mechanical_at_open:mech};
  writeJson(path.join(dir,'checks',`${pad(id)}.json`),record); event(dir,'check_opened',{check_id:id,mode:draft.meta.mode,draft_sha256:draft.hash});
  emit(directive({active,wf,state:'CHECK',allowed:['check.submit'],forbidden:['answering user','skipping checklist items','asserting mechanical checks without runtime evidence'],
    prompt:'Read and evaluate every checklist item below against the latest durable request, workflow, artifacts, observations, and staged response. Submit one yes/no assessment per item with a reason and evidence_refs. Do not omit items. Mechanical conditions will be recomputed independently on submit; model confidence cannot override them.',
    extra:{check_id:id,mode:draft.meta.mode,staged_response:draft.body,checklist,mechanical_preview:mech,current:readText(path.join(dir,'CURRENT.md'),'')} }));
}

function normalizeAnswers(input) {
  const arr=Array.isArray(input.answers)?input.answers:[]; const map=new Map();
  for(const a of arr) if(a&&a.id) map.set(String(a.id),{id:String(a.id),answer:String(a.answer||'').toLowerCase(),reason:String(a.reason||''),evidence_refs:Array.isArray(a.evidence_refs)?a.evidence_refs.map(String):[]});
  return map;
}

function submitCheck(active,dir,wf,input) {
  const checkId=Number(input.check_id); if(!checkId) return fail('submit requires check_id','BAD_INPUT');
  const checkPath=path.join(dir,'checks',`${pad(checkId)}.json`); if(!exists(checkPath)) return fail(`Check ${checkId} not found`,'NOT_FOUND');
  const rec=readJson(checkPath); if(rec.status!=='OPEN') return fail(`Check ${checkId} is not OPEN`,'INVALID_TRANSITION');
  const draft=draftState(dir); const checklist=allChecklist(dir); const answers=normalizeAnswers(input); const mech=mechanical(active,dir,wf,draft);
  const failures=[];
  if(rec.request_revision!==active.request_revision) failures.push({id:'stale-check',reason:'request revision changed after check.open'});
  if(rec.workflow_revision!==wf.revision) failures.push({id:'stale-check',reason:'workflow revision changed after check.open'});
  if(rec.draft_sha256!==draft.hash) failures.push({id:'stale-draft',reason:'draft changed after check.open'});
  if(!mech._mode.pass) failures.push({id:'mode-compatibility',reason:mech._mode.detail});
  if(!mech._phase.pass) failures.push({id:'persistence-complete',reason:'completed work exists but no phase snapshot is persisted'});
  for(const item of checklist) {
    const a=answers.get(item.id);
    if(!a) { failures.push({id:item.id,reason:'checklist item omitted'}); continue; }
    if(a.answer!=='yes') failures.push({id:item.id,reason:a.reason||'model assessment is not yes'});
    if(item.evidence_required && a.evidence_refs.length===0) failures.push({id:item.id,reason:'evidence_refs required'});
    if(mech[item.id] && !mech[item.id].pass) failures.push({id:item.id,reason:mech[item.id].detail});
  }
  rec.submitted_at=now(); rec.answers=[...answers.values()]; rec.mechanical_at_submit=mech;
  if(failures.length) return reject(active,dir,wf,draft,rec,checkPath,failures);
  return approve(active,dir,wf,draft,rec,checkPath);
}

function reject(active,dir,wf,draft,rec,checkPath,failures) {
  rec.status='BLOCKED'; rec.failures=failures; writeJson(checkPath,rec); invalidateApproval(dir,'check failed');
  const uniq=[]; const seen=new Set(); for(const f of failures){if(!seen.has(f.id)){seen.add(f.id);uniq.push(f);}}
  for(const old of wf.items) if(['queued','runnable','running','blocked'].includes(old.status)){old.status='superseded';old.superseded_at=now();old.superseded_reason=`check ${rec.id} failed`;}
  const base=`check-${rec.id}`;
  uniq.forEach((f,i)=>wf.items.push({id:`${base}-${i+1}`,phase:'remediation',objective:`Remediate failed check '${f.id}': ${f.reason}`,status:'queued',depends_on:[],acceptance:[`Check '${f.id}' can be answered yes with durable evidence.`],expected_evidence:['remediation evidence'],evidence_refs:[],response_dependency:'none'}));
  wf.revision+=1; active.workflow_revision=wf.revision; active.state='EXECUTE'; saveActive(active); saveWorkflow(dir,wf); event(dir,'check_failed',{check_id:rec.id,failures:uniq,workflow_revision:wf.revision});
  emit(directive({active,wf,state:'EXECUTE',next_item:nextRunnable(wf),allowed:['workflow.next','observe.capture','workflow.complete'],forbidden:['sending rejected draft','claiming completion','manually flipping checklist results'],
    prompt:`Check ${rec.id} failed and generated remediation workflow items. Resume the workflow now. After remediation, stage a fresh response and run a new check; the rejected draft is not approved.`,extra:{failures:uniq,rejected_draft_sha256:draft.hash}}));
}

function approve(active,dir,wf,draft,rec,checkPath) {
  const token=crypto.randomBytes(18).toString('base64url'); rec.status=draft.meta.mode==='final'?'READY':'APPROVED'; rec.approved_at=now(); rec.approval_token_hash=sha256(token); writeJson(checkPath,rec);
  writeText(path.join(dir,'outbox','approved.md'),draft.body);
  writeJson(path.join(dir,'outbox','approval.json'),{token_hash:sha256(token),check_id:rec.id,run_id:active.run_id,request_revision:active.request_revision,workflow_revision:wf.revision,draft_sha256:draft.hash,mode:draft.meta.mode,approved_at:now(),used:false});
  const state=draft.meta.mode==='final'?'READY':draft.meta.mode==='progress'?'PROGRESS_ONLY':'WAIT_USER'; active.state=state; saveActive(active); event(dir,'check_approved',{check_id:rec.id,mode:draft.meta.mode,draft_sha256:draft.hash});
  const prompt=draft.meta.mode==='final'
    ? 'READY. Do not send yet. Call check.consume with the approval token; only consume may release the response for user delivery.'
    : draft.meta.mode==='progress'
      ? 'The progress response is approved but not yet released. Call check.consume with the approval token; only then may it be sent.'
      : 'The interaction response is approved but not yet released. Call check.consume with the approval token; only then may it be sent.';
  emit(directive({active,wf,state,allowed:['check.consume'],forbidden:['editing approved response','claiming additional untracked work'],prompt,extra:{approval_token:token,approved_path:path.join(dir,'outbox','approved.md'),draft_sha256:draft.hash,check_id:rec.id}}));
}

function consume(active,dir,wf,input) {
  const approvalPath=path.join(dir,'outbox','approval.json');
  const approvedPath=path.join(dir,'outbox','approved.md');
  if(!exists(approvalPath)||!exists(approvedPath)) return fail('No current approved response','NO_APPROVAL');
  const approval=readJson(approvalPath);
  if(approval.used) return fail('Approval token already consumed','APPROVAL_ALREADY_USED');
  if(!input.approval_token || sha256(String(input.approval_token))!==approval.token_hash) return fail('Invalid approval token','BAD_APPROVAL_TOKEN');
  const approved=readText(approvedPath);
  const draft=draftState(dir);
  if(approval.request_revision!==active.request_revision || approval.workflow_revision!==wf.revision || approval.draft_sha256!==sha256(approved) || draft.hash!==approval.draft_sha256) return fail('Approval is stale relative to current durable state','STALE_APPROVAL');
  approval.used=true; approval.used_at=now(); writeJson(approvalPath,approval); event(dir,'approval_consumed',{check_id:approval.check_id,mode:approval.mode});
  emit(directive({active,wf,state:active.state,allowed:['send approved_response exactly once'],forbidden:['editing approved response','reusing approval token'],prompt:'This is the final gate. Send approved_response exactly as returned, with no substantive edits. The approval token is now consumed and cannot be reused.',extra:{approved_response:approved,mode:approval.mode,check_id:approval.check_id,draft_sha256:approval.draft_sha256}}));
}

main();
