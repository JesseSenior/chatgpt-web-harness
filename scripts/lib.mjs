import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { appendEvent, sha256 } from './audit.mjs';
import { success, failure } from './protocol.mjs';

export const STATE_DIR = '.chatgpt-workflow';
export const SCHEMA_VERSION = 2;
export const EVIDENCE_TYPES = new Set(['request', 'artifact', 'tool_result', 'source_snapshot']);
export const OPEN_STATUSES = new Set(['queued', 'running', 'blocked']);
export const RECEIPT_PATTERN = /(?:^|\n)Workflow-Receipt:\s*sha256:[a-f0-9]{64}\s*$/i;

export function now() { return new Date().toISOString(); }
export { sha256 };
export function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
export function makeRunId() { return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`; }
export function root(cwd = process.cwd()) { return path.resolve(cwd, STATE_DIR); }
export function runDir(runId, cwd = process.cwd()) { return path.join(root(cwd), 'runs', runId); }
export function activePath(cwd = process.cwd()) { return path.join(root(cwd), 'active.json'); }
export function ensureDir(value) { fs.mkdirSync(value, { recursive: true }); }
export function exists(value) { try { fs.accessSync(value); return true; } catch { return false; } }
export function readText(file, fallback = null) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { if (fallback !== null) return fallback; throw error; }
}
export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (fallback !== null) return fallback; throw error; }
}
export function atomicWrite(file, value) {
  ensureDir(path.dirname(file));
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(temporary, value);
  fs.renameSync(temporary, file);
}
export function writeText(file, value) { atomicWrite(file, String(value)); }
export function writeJson(file, value) { atomicWrite(file, JSON.stringify(value, null, 2) + '\n'); }
export function pad(value, width = 6) { return String(value).padStart(width, '0'); }

export function parseInput(index = 3) {
  const argument = process.argv[index];
  if (argument) return JSON.parse(argument);
  const input = fs.readFileSync(0, 'utf8').trim();
  return input ? JSON.parse(input) : {};
}

export function loadActive(cwd = process.cwd()) {
  const file = activePath(cwd);
  if (!exists(file)) throw Object.assign(new Error('NO_ACTIVE_RUN'), { code: 'NO_ACTIVE_RUN' });
  const active = readJson(file);
  if (active.version !== SCHEMA_VERSION) {
    throw Object.assign(new Error('legacy state cannot be verified'), { code: 'LEGACY_STATE_UNVERIFIABLE' });
  }
  return active;
}
export function saveActive(active, cwd = process.cwd()) {
  active.updated_at = now();
  writeJson(activePath(cwd), active);
}
export function loadRun(cwd = process.cwd()) {
  const active = loadActive(cwd);
  const dir = runDir(active.run_id, cwd);
  const wf = readJson(path.join(dir, 'workflow.json'));
  if (wf.version !== SCHEMA_VERSION) {
    throw Object.assign(new Error('legacy workflow cannot be verified'), { code: 'LEGACY_STATE_UNVERIFIABLE' });
  }
  return { active, dir, wf };
}
export function saveWorkflow(dir, wf) {
  wf.updated_at = now();
  writeJson(path.join(dir, 'workflow.json'), wf);
  regenerateCurrent(dir, wf);
}
export function loadCounters(dir) {
  return readJson(path.join(dir, 'counters.json'), {
    observation: 0, evidence: 0, phase: 0, check: 0, delivery: 0, effect: 0
  });
}
export function nextCounter(dir, key) {
  const counters = loadCounters(dir);
  counters[key] = (counters[key] || 0) + 1;
  writeJson(path.join(dir, 'counters.json'), counters);
  return counters[key];
}

export function event(dir, type, active, payload = {}) {
  return appendEvent(dir, type, {
    state_before: payload.state_before ?? active.state,
    state_after: payload.state_after ?? active.state,
    ...payload
  });
}

export function openItems(wf) { return wf.items.filter(item => OPEN_STATUSES.has(item.status)); }
export function dependenciesDone(item, wf) {
  return item.depends_on.every(id => wf.items.find(candidate => candidate.id === id)?.status === 'done');
}
export function nextRunnable(wf) {
  const running = wf.items.find(item => item.status === 'running');
  if (running) return running;
  return wf.items.find(item => item.status === 'queued' && dependenciesDone(item, wf)) || null;
}
export function activeFog(wf) { return (wf.fog || []).filter(item => item.status === 'fog'); }

export function issueExecutionToken(active, dir, wf, item = nextRunnable(wf)) {
  if (!item) return null;
  const token = randomToken();
  item.status = 'running';
  wf.current_item_id = item.id;
  active.execution = {
    item_id: item.id,
    token_hash: sha256(token),
    request_revision: active.request_revision,
    workflow_revision: wf.revision,
    issued_at: now(),
    used: false
  };
  active.state = 'EXECUTE';
  saveActive(active);
  saveWorkflow(dir, wf);
  return { token, item };
}

export function validateExecutionToken(active, wf, token) {
  const record = active.execution;
  if (!record || record.used) return { valid: false, code: record?.used ? 'TOKEN_ALREADY_USED' : 'INVALID_TOKEN' };
  const valid = sha256(String(token || '')) === record.token_hash
    && record.request_revision === active.request_revision
    && record.workflow_revision === wf.revision
    && record.item_id === wf.current_item_id
    && active.state === 'EXECUTE';
  return { valid, code: 'INVALID_TOKEN' };
}

export function issueReconcileToken(active, dir, wf, sourceItemId) {
  const token = randomToken();
  active.reconcile = {
    source_item_id: sourceItemId,
    token_hash: sha256(token),
    request_revision: active.request_revision,
    workflow_revision: wf.revision,
    issued_at: now(),
    used: false
  };
  active.execution = null;
  active.state = 'RECONCILE';
  saveActive(active);
  saveWorkflow(dir, wf);
  return token;
}

export function validateReconcileToken(active, wf, token) {
  const record = active.reconcile;
  if (!record || record.used) return { valid: false, code: record?.used ? 'TOKEN_ALREADY_USED' : 'INVALID_TOKEN' };
  const valid = sha256(String(token || '')) === record.token_hash
    && record.request_revision === active.request_revision
    && record.workflow_revision === wf.revision
    && active.state === 'RECONCILE';
  return { valid, code: 'INVALID_TOKEN' };
}

function criterion(value, prefix, index) {
  const id = String(value?.id || `${prefix}-${index + 1}`).trim();
  const text = String(value?.text || '').trim();
  const evidenceTypes = Array.isArray(value?.evidence_types) ? value.evidence_types.map(String) : [];
  if (!id || !text || evidenceTypes.length === 0 || evidenceTypes.some(type => !EVIDENCE_TYPES.has(type))) {
    throw Object.assign(new Error(`invalid criterion ${id || index + 1}`), { code: 'INVALID_PLAN' });
  }
  return { id, text, evidence_types: [...new Set(evidenceTypes)] };
}

export function normalizePlanItems(values, existingIds = new Set()) {
  if (!Array.isArray(values) || values.length === 0) {
    throw Object.assign(new Error('plan requires items'), { code: 'INVALID_PLAN' });
  }
  const ids = new Set(existingIds);
  const items = values.map((value, index) => {
    const id = String(value?.id || '').trim();
    const objective = String(value?.objective || '').trim();
    const kind = String(value?.kind || '');
    if (!id || ids.has(id) || !objective || !['knowledge', 'execution'].includes(kind)) {
      throw Object.assign(new Error(`invalid item at index ${index}`), { code: 'INVALID_PLAN' });
    }
    ids.add(id);
    const acceptance = Array.isArray(value.acceptance)
      ? value.acceptance.map((entry, criterionIndex) => criterion(entry, id, criterionIndex))
      : [];
    if (acceptance.length === 0 || new Set(acceptance.map(entry => entry.id)).size !== acceptance.length) {
      throw Object.assign(new Error(`item ${id} requires unique acceptance criteria`), { code: 'INVALID_PLAN' });
    }
    return {
      id,
      kind,
      objective,
      status: 'queued',
      depends_on: Array.isArray(value.depends_on) ? [...new Set(value.depends_on.map(String))] : [],
      acceptance,
      criterion_results: [],
      created_at: now()
    };
  });
  validatePlanGraph(items, existingIds);
  return items;
}

export function validatePlanGraph(items, externalIds = new Set()) {
  const ids = new Set([...externalIds, ...items.map(item => item.id)]);
  for (const item of items) {
    const unknown = item.depends_on.filter(id => !ids.has(id));
    if (unknown.length) {
      throw Object.assign(new Error(`unknown dependencies for ${item.id}: ${unknown.join(', ')}`), { code: 'INVALID_PLAN' });
    }
  }
  const local = new Map(items.map(item => [item.id, item]));
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw Object.assign(new Error(`dependency cycle at ${id}`), { code: 'INVALID_PLAN' });
    if (visited.has(id) || !local.has(id)) return;
    visiting.add(id);
    for (const dependency of local.get(id).depends_on) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const item of items) visit(item.id);
}

export function normalizeDestination(value) {
  const objective = String(value?.objective || '').trim();
  const constraints = Array.isArray(value?.constraints) ? value.constraints.map(String).filter(Boolean) : [];
  const successCriteria = Array.isArray(value?.success_criteria)
    ? value.success_criteria.map((entry, index) => criterion(entry, 'destination', index))
    : [];
  if (!objective || successCriteria.length === 0 || new Set(successCriteria.map(entry => entry.id)).size !== successCriteria.length) {
    throw Object.assign(new Error('destination requires an objective and unique success criteria'), { code: 'INVALID_PLAN' });
  }
  return { objective, constraints, success_criteria: successCriteria };
}

export function normalizeFog(values = []) {
  if (!Array.isArray(values)) throw Object.assign(new Error('fog must be an array'), { code: 'INVALID_PLAN' });
  const ids = new Set();
  return values.map((value, index) => {
    const id = String(value?.id || `fog-${index + 1}`).trim();
    const question = String(value?.question || '').trim();
    if (!id || ids.has(id) || !question) {
      throw Object.assign(new Error(`invalid fog entry ${id}`), { code: 'INVALID_PLAN' });
    }
    ids.add(id);
    return { id, question, status: 'fog', created_at: now() };
  });
}

export function regenerateCurrent(dir, wf) {
  const active = readJson(path.join(path.dirname(path.dirname(dir)), 'active.json'), null);
  const requestRevision = active?.request_revision ?? wf.request_revision;
  const requestPath = path.join(dir, 'requests', `${pad(requestRevision, 4)}.md`);
  const open = openItems(wf);
  const fog = activeFog(wf);
  const lines = [
    '# Current durable workflow state', '',
    `- Run: ${wf.run_id}`,
    `- State: ${active?.state || 'UNKNOWN'}`,
    `- Request revision: ${requestRevision}`,
    `- Workflow revision: ${wf.revision}`,
    `- Destination: ${wf.destination?.objective || '(not planned)'}`,
    '', '## Latest request', '', readText(requestPath, '(missing)').trim(),
    '', '## Current item', '', wf.current_item_id || 'None',
    '', '## Open work', '', ...(open.length ? open.map(item => `- [${item.status}] ${item.id}: ${item.objective}`) : ['- None']),
    '', '## Fog', '', ...(fog.length ? fog.map(item => `- ${item.id}: ${item.question}`) : ['- None'])
  ];
  writeText(path.join(dir, 'CURRENT.md'), lines.join('\n') + '\n');
}

export function emit(value) { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }
export function ok(options) { emit(success(options)); }
export function fail(code, options = {}) {
  emit(failure(code, options));
  process.exitCode = 1;
}
export function errorCode(error) {
  return error?.code || (error?.message === 'NO_ACTIVE_RUN' ? 'NO_ACTIVE_RUN' : 'RUNTIME_ERROR');
}
