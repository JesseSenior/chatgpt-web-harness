import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const STATE_DIR = '.chatgpt-workflow';

export function now() { return new Date().toISOString(); }
export function sha256(text) { return crypto.createHash('sha256').update(String(text)).digest('hex'); }
export function slug(s='phase') {
  return String(s).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'phase';
}
export function root(cwd = process.cwd()) { return path.resolve(cwd, STATE_DIR); }
export function runDir(runId, cwd = process.cwd()) { return path.join(root(cwd), 'runs', runId); }
export function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
export function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
export function readText(p, fallback = null) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { if (fallback !== null) return fallback; throw e; } }
export function readJson(p, fallback = null) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { if (fallback !== null) return fallback; throw e; } }
export function atomicWrite(p, data) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, p);
}
export function writeText(p, text) { atomicWrite(p, String(text)); }
export function writeJson(p, obj) { atomicWrite(p, JSON.stringify(obj, null, 2) + '\n'); }
export function appendJsonl(p, obj) { ensureDir(path.dirname(p)); fs.appendFileSync(p, JSON.stringify(obj) + '\n'); }
export function pad(n, width = 6) { return String(n).padStart(width, '0'); }
export function makeRunId() { return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`; }

export function parseInput() {
  const arg = process.argv[3];
  if (arg) return JSON.parse(arg);
  const stdin = fs.readFileSync(0, 'utf8').trim();
  return stdin ? JSON.parse(stdin) : {};
}

export function activePath(cwd = process.cwd()) { return path.join(root(cwd), 'active.json'); }
export function loadActive(cwd = process.cwd()) {
  const p = activePath(cwd);
  if (!exists(p)) throw new Error('NO_ACTIVE_RUN');
  return readJson(p);
}
export function saveActive(active, cwd = process.cwd()) {
  active.updated_at = now();
  writeJson(activePath(cwd), active);
}
export function loadRun(cwd = process.cwd()) {
  const active = loadActive(cwd);
  const dir = runDir(active.run_id, cwd);
  return { active, dir };
}
export function event(dir, type, data = {}) {
  const p = path.join(dir, 'events.jsonl');
  const prev = readJson(path.join(dir, 'counters.json'), { event: 0, observation: 0, phase: 0, check: 0 });
  prev.event += 1;
  writeJson(path.join(dir, 'counters.json'), prev);
  appendJsonl(p, { id: prev.event, at: now(), type, ...data });
  return prev.event;
}
export function nextCounter(dir, key) {
  const p = path.join(dir, 'counters.json');
  const counters = readJson(p, { event: 0, observation: 0, phase: 0, check: 0 });
  counters[key] = (counters[key] || 0) + 1;
  writeJson(p, counters);
  return counters[key];
}

export function loadWorkflow(dir) { return readJson(path.join(dir, 'workflow.json')); }
export function saveWorkflow(dir, wf) { wf.updated_at = now(); writeJson(path.join(dir, 'workflow.json'), wf); regenerateCurrent(dir, wf); }
export function loadChecklist(dir) { return readJson(path.join(dir, 'checklist.json'), { base: [], task: [] }); }
export function saveChecklist(dir, c) { writeJson(path.join(dir, 'checklist.json'), c); }
export function loadArtifacts(dir) { return readJson(path.join(dir, 'artifacts.json'), { artifacts: [] }); }
export function saveArtifacts(dir, a) { writeJson(path.join(dir, 'artifacts.json'), a); }
export function invalidateApproval(dir, reason = 'state changed') {
  for (const name of ['approved.md', 'approval.json']) {
    const p = path.join(dir, 'outbox', name); if (exists(p)) fs.rmSync(p);
  }
  const draftMeta = path.join(dir, 'outbox', 'draft.json');
  if (exists(draftMeta)) {
    const d = readJson(draftMeta); d.approval_invalidated_at = now(); d.approval_invalidated_reason = reason; writeJson(draftMeta, d);
  }
}

export function isOpen(item) { return ['queued','runnable','running','blocked'].includes(item.status); }
export function openItems(wf) { return wf.items.filter(isOpen); }
export function depsDone(item, wf) {
  return (item.depends_on || []).every(id => wf.items.find(x => x.id === id)?.status === 'done');
}
export function nextRunnable(wf) {
  const running = wf.items.find(x => x.status === 'running');
  if (running) return running;
  const q = wf.items.find(x => ['queued','runnable'].includes(x.status) && depsDone(x, wf));
  return q || null;
}
export function phaseOpenItems(wf, phase) { return wf.items.filter(i => i.phase === phase && isOpen(i)); }

export function regenerateCurrent(dir, wf = loadWorkflow(dir)) {
  const active = readJson(path.join(root(path.dirname(path.dirname(path.dirname(dir)))), 'active.json'), null);
  const requestRev = active?.request_revision ?? wf.request_revision ?? 1;
  const reqPath = path.join(dir, 'requests', `${pad(requestRev,4)}.md`);
  const open = openItems(wf);
  const lastPhase = latestFile(path.join(dir,'phases'));
  const artifacts = loadArtifacts(dir).artifacts || [];
  const lines = [
    '# Current durable workflow state', '',
    `- Run: ${wf.run_id}`,
    `- Workflow revision: ${wf.revision}`,
    `- Request revision: ${requestRev}`,
    `- Status: ${open.length ? 'IN PROGRESS' : 'WORKFLOW EMPTY'}`,
    '', '## Latest request', '', exists(reqPath) ? readText(reqPath).trim() : '(missing)',
    '', '## Open work', '',
    ...(open.length ? open.map(i => `- [${i.status}] ${i.id}: ${i.objective}${i.blocker ? ` — blocker: ${i.blocker}` : ''}`) : ['- None']),
    '', '## Artifacts', '',
    ...(artifacts.length ? artifacts.map(a => `- ${a.id || a.path || a.ref}: ${a.path || a.ref}${a.description ? ` — ${a.description}` : ''}`) : ['- None']),
    '', '## Latest phase snapshot', '', lastPhase ? `- ${lastPhase}` : '- None',
    '', '## Next action', '',
    open.length ? `Continue with workflow.next; current candidate: ${nextRunnable(wf)?.id || 'resolve blocker/dependency'}.` : 'Stage a response and run the mandatory check gate.'
  ];
  writeText(path.join(dir,'CURRENT.md'), lines.join('\n') + '\n');
}

export function latestFile(dir) {
  if (!exists(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => !f.startsWith('.')).sort();
  return files.length ? path.join(dir, files.at(-1)) : null;
}

export function directive({ active, wf, state, next_item = null, prompt, allowed = [], forbidden = [], extra = {} }) {
  return {
    ok: state !== 'ERROR',
    directive: {
      run_id: active?.run_id ?? wf?.run_id ?? null,
      request_revision: active?.request_revision ?? wf?.request_revision ?? null,
      workflow_revision: wf?.revision ?? active?.workflow_revision ?? null,
      state,
      next_item,
      allowed_next_calls: allowed,
      forbidden_actions: forbidden,
      prompt,
      recovery_paths: active?.run_id ? {
        active: path.join(root(), 'active.json'),
        current: path.join(runDir(active.run_id), 'CURRENT.md'),
        workflow: path.join(runDir(active.run_id), 'workflow.json')
      } : {},
      ...extra
    }
  };
}

export function baseChecklist() {
  return [
    { id:'latest-request', text:'The staged response answers the latest unsuperseded user request.', evidence_required:true },
    { id:'workflow-empty-final', text:'For final mode, there are zero queued, runnable, running, or blocked items.', evidence_required:true, mechanical:true },
    { id:'acceptance-evidence', text:'Every completed workflow item satisfies its acceptance criteria with persisted evidence.', evidence_required:true, mechanical:true },
    { id:'user-constraints', text:'All explicit format, scope, language, length, tool, and safety constraints are satisfied.', evidence_required:true },
    { id:'artifact-integrity', text:'All promised deliverables exist and match the latest workflow revision.', evidence_required:true, mechanical:true },
    { id:'claim-grounding', text:'Material claims are supported or uncertainty is clearly labeled.', evidence_required:true },
    { id:'no-false-completion', text:'The response does not claim work that is not represented as completed.', evidence_required:true },
    { id:'persistence-complete', text:'Material observations and the latest phase state have been persisted.', evidence_required:true },
    { id:'recovery-safe', text:'A fresh context can continue correctly from durable state.', evidence_required:true },
    { id:'draft-exact', text:'The response to be sent is exactly the staged draft being checked.', evidence_required:true, mechanical:true }
  ];
}

export function verifyArtifacts(dir) {
  const artifacts = loadArtifacts(dir).artifacts || [];
  const failures = [];
  for (const a of artifacts) {
    if (a.path) {
      const p = path.isAbsolute(a.path) ? a.path : path.resolve(process.cwd(), a.path);
      if (!exists(p)) failures.push(`missing artifact: ${a.path}`);
      else if (a.sha256 && sha256(fs.readFileSync(p)) !== a.sha256) failures.push(`artifact hash mismatch: ${a.path}`);
    }
  }
  return failures;
}

export function emit(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); }
export function fail(message, code = 'ERROR') { emit({ ok:false, error:code, message }); process.exitCode = 1; }
