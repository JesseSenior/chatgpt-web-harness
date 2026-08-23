#!/usr/bin/env node
import path from 'node:path';
import {
  parseInput, loadRun, loadWorkflow, nextCounter, pad, writeText, readText, exists, now,
  event, directive, nextRunnable, saveWorkflow, emit, fail
} from './lib.mjs';

function main() {
  const action = process.argv[2];
  if (!action) return fail('Usage: observe.mjs <capture|validate|supersede> [json]', 'BAD_USAGE');
  try {
    const input = parseInput();
    const { active, dir } = loadRun();
    const wf = loadWorkflow(dir);
    if (action === 'capture') return capture(active, dir, wf, input);
    if (action === 'validate') return validate(active, dir, wf, input);
    if (action === 'supersede') return supersede(active, dir, wf, input);
    return fail(`Unknown observe action: ${action}`, 'BAD_USAGE');
  } catch (e) { return fail(e?.stack || String(e), 'RUNTIME_ERROR'); }
}

function obsPath(dir, id) { return path.join(dir, 'observations', `${pad(Number(id))}.md`); }
function parseHeader(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const i=line.indexOf(':'); if(i<0) continue;
    const k=line.slice(0,i).trim(), v=line.slice(i+1).trim(); out[k]=v;
  }
  return out;
}

function render(o) {
  const arr = (v)=>Array.isArray(v)?v:[];
  return [
    '---',
    `id: ${o.id}`,
    `created_at: ${o.created_at}`,
    `updated_at: ${o.updated_at || o.created_at}`,
    `kind: ${o.kind}`,
    `status: ${o.status}`,
    `workflow_item_id: ${o.workflow_item_id || ''}`,
    `phase_id: ${o.phase_id || ''}`,
    `confidence: ${o.confidence ?? ''}`,
    '---','',
    '# Statement','',o.statement,'',
    '# Source refs','',...(arr(o.source_refs).length?arr(o.source_refs).map(x=>`- ${x}`):['- None']),'',
    '# Evidence refs','',...(arr(o.evidence_refs).length?arr(o.evidence_refs).map(x=>`- ${x}`):['- None']),'',
    '# Supersedes','',...(arr(o.supersedes).length?arr(o.supersedes).map(x=>`- ${x}`):['- None']),''
  ].join('\n');
}

function capture(active, dir, wf, input) {
  if (!input.statement) return fail('capture requires statement', 'BAD_INPUT');
  const id=nextCounter(dir,'observation');
  const evidence=Array.isArray(input.evidence_refs)?input.evidence_refs.map(String):[];
  const o={ id, created_at:now(), kind:String(input.kind||'finding'), statement:String(input.statement), status:evidence.length?'validated':'provisional',
    source_refs:Array.isArray(input.source_refs)?input.source_refs.map(String):[], evidence_refs:evidence,
    supersedes:Array.isArray(input.supersedes)?input.supersedes.map(String):[], workflow_item_id:input.workflow_item_id||nextRunnable(wf)?.id||'', phase_id:input.phase_id||nextRunnable(wf)?.phase||'', confidence:input.confidence??'' };
  const p=obsPath(dir,id); writeText(p,render(o)); event(dir,'observation_captured',{observation_id:id,status:o.status,path:p});
  emit(directive({active,wf,state:active.state,next_item:nextRunnable(wf),allowed:['workflow.complete','workflow.next','observe.validate','observe.capture'],forbidden:['silently replacing this observation in memory'],prompt:`Observation ${id} persisted as ${o.status}. Reference ${p} instead of relying on conversation memory. If the finding is provisional and needed for acceptance, validate it before completing the dependent item.`,extra:{observation_id:id,path:p,status:o.status}}));
}

function validate(active, dir, wf, input) {
  const id=Number(input.id); if(!id) return fail('validate requires numeric id', 'BAD_INPUT');
  const p=obsPath(dir,id); if(!exists(p)) return fail(`Observation ${id} not found`, 'NOT_FOUND');
  const old=readText(p); const h=parseHeader(old);
  const statement=(old.match(/# Statement\n\n([\s\S]*?)\n\n# Source refs/)||[])[1]||'';
  const source=(old.match(/# Source refs\n\n([\s\S]*?)\n\n# Evidence refs/)||[])[1]?.split('\n').filter(x=>x.startsWith('- ')&&x!=='- None').map(x=>x.slice(2))||[];
  const priorEvidence=(old.match(/# Evidence refs\n\n([\s\S]*?)\n\n# Supersedes/)||[])[1]?.split('\n').filter(x=>x.startsWith('- ')&&x!=='- None').map(x=>x.slice(2))||[];
  const added=Array.isArray(input.evidence_refs)?input.evidence_refs.map(String):[]; if(!added.length) return fail('validate requires evidence_refs', 'EVIDENCE_REQUIRED');
  const o={id,created_at:h.created_at||now(),updated_at:now(),kind:h.kind||'finding',statement,status:'validated',source_refs:source,evidence_refs:[...new Set([...priorEvidence,...added])],supersedes:[],workflow_item_id:h.workflow_item_id||'',phase_id:h.phase_id||'',confidence:input.confidence??h.confidence??''};
  writeText(p,render(o)); event(dir,'observation_validated',{observation_id:id,evidence_refs:added});
  emit(directive({active,wf,state:active.state,next_item:nextRunnable(wf),allowed:['workflow.complete','workflow.next','observe.capture'],forbidden:['dropping evidence pointer'],prompt:`Observation ${id} is now validated with durable evidence. It may be used as evidence for dependent workflow work.`,extra:{observation_id:id,path:p,status:'validated'}}));
}

function supersede(active, dir, wf, input) {
  const id=Number(input.id); if(!id) return fail('supersede requires numeric id', 'BAD_INPUT');
  const p=obsPath(dir,id); if(!exists(p)) return fail(`Observation ${id} not found`, 'NOT_FOUND');
  let text=readText(p); text=text.replace(/^status:\s*\S+/m,'status: superseded').replace(/^updated_at:\s*.*$/m,`updated_at: ${now()}`);
  text += `\n# Superseded reason\n\n${String(input.reason||'newer evidence or decision')}\n`;
  writeText(p,text); event(dir,'observation_superseded',{observation_id:id,reason:input.reason||''});
  emit(directive({active,wf,state:active.state,next_item:nextRunnable(wf),allowed:['observe.capture','workflow.next'],forbidden:['using superseded observation as current truth'],prompt:`Observation ${id} is preserved for history but superseded. Capture the replacement observation separately; do not overwrite history.`}));
}

main();
