#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  SCHEMA_VERSION, RECEIPT_PATTERN, activeFog, activePath, dependenciesDone, ensureDir,
  errorCode, event, exists, fail, issueExecutionToken, issueReconcileToken, loadRun,
  makeRunId, nextCounter, nextRunnable, normalizeDestination, normalizeFog,
  normalizePlanItems, now, ok, openItems, pad, parseInput, readJson,
  root, runDir, saveActive, saveWorkflow, sha256, validateExecutionToken,
  validateReconcileToken, writeJson, writeText
} from './lib.mjs';
import { recordEvidence, verifiedEvidenceForCriterion, verifyEvidenceId } from './evidence-lib.mjs';

const REPLAN_REASONS = new Set([
  'no_change',
  'validated_observation',
  'high_confidence_observation',
  'tool_failure',
  'dependency_change',
  'check_failure',
  'user_revision'
]);

function clearCandidate(dir) {
  for (const name of ['draft.md', 'draft.json', 'release-token.json']) {
    const file = path.join(dir, 'outbox', name);
    if (exists(file)) fs.rmSync(file);
  }
}

function observation(dir, id) {
  const file = path.join(dir, 'observations', `${pad(Number(id))}.json`);
  return exists(file) ? readJson(file) : null;
}

function effects(dir) {
  return readJson(path.join(dir, 'effects.json'), { effects: [] });
}

function saveEffects(dir, value) {
  writeJson(path.join(dir, 'effects.json'), value);
}

function pendingEffects(dir, itemId = null) {
  return effects(dir).effects.filter(effect => effect.status === 'prepared' && (!itemId || effect.workflow_item_id === itemId));
}

function makeSnapshot(dir, wf, phase, summary = '') {
  const id = nextCounter(dir, 'phase');
  const file = path.join(dir, 'phases', `${pad(id, 3)}-${String(phase).replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}.json`);
  writeJson(file, {
    id,
    phase,
    workflow_revision: wf.revision,
    captured_at: now(),
    summary: String(summary || ''),
    item_statuses: wf.items.map(item => ({ id: item.id, status: item.status })),
    current_item_id: wf.current_item_id,
    active_fog_ids: activeFog(wf).map(item => item.id)
  });
  return file;
}

function executionDirective(active, dir, wf, item = null, eventName = 'item_issued', stateBefore = active.state) {
  const issued = issueExecutionToken(active, dir, wf, item || nextRunnable(wf));
  if (!issued) return null;
  event(dir, eventName, active, {
    state_before: stateBefore,
    state_after: 'EXECUTE',
    item_id: issued.item.id
  });
  return ok({
    active,
    wf,
    nextItem: issued.item,
    allowed: [
      'evidence.record',
      'observe.capture',
      'workflow.effect_prepare',
      'workflow.complete',
      'workflow.block',
      'workflow.snapshot'
    ],
    extra: {
      execution_token: issued.token,
      item: issued.item
    }
  });
}

function reconcileDirective(active, dir, wf, sourceItemId, eventName, stateBefore) {
  const token = issueReconcileToken(active, dir, wf, sourceItemId);
  event(dir, eventName, active, {
    state_before: stateBefore,
    state_after: 'RECONCILE',
    source_item_id: sourceItemId
  });
  return ok({
    active,
    wf,
    allowed: ['workflow.reconcile', 'workflow.regenerate', 'observe.validate', 'observe.status'],
    extra: {
      reconcile_token: token,
      source_item_id: sourceItemId,
      fog: activeFog(wf)
    }
  });
}

function advance(active, dir, wf, eventName, stateBefore, payload = {}) {
  const runnable = nextRunnable(wf);
  if (runnable) return executionDirective(active, dir, wf, runnable, eventName, stateBefore);
  if (activeFog(wf).length) return reconcileDirective(active, dir, wf, 'fog', eventName, stateBefore);
  const open = openItems(wf);
  if (open.length) {
    active.state = 'WAIT_USER';
    active.execution = null;
    saveActive(active);
    saveWorkflow(dir, wf);
    event(dir, eventName, active, { state_before: stateBefore, state_after: 'WAIT_USER', ...payload });
    return ok({ active, wf, allowed: ['workflow.interrupt', 'workflow.status'], extra: { open_items: open } });
  }
  active.state = 'CHECK';
  active.execution = null;
  saveActive(active);
  saveWorkflow(dir, wf);
  event(dir, eventName, active, { state_before: stateBefore, state_after: 'CHECK', ...payload });
  return ok({ active, wf, allowed: ['workflow.stage'], extra: { destination: wf.destination } });
}

function start(input) {
  if (!input.request || typeof input.request !== 'string') return fail('BAD_INPUT', { missing: ['request'] });
  ensureDir(root());
  if (exists(activePath()) && !input.force_new) {
    const current = readJson(activePath());
    return fail('INVALID_TRANSITION', { detail: `active run exists: ${current.run_id}`, allowed: ['workflow.interrupt', 'recover'] });
  }
  const runId = makeRunId();
  const dir = runDir(runId);
  for (const name of ['requests', 'observations', 'phases', 'checks', 'outbox', 'evidence', 'events', 'deliveries', 'releases']) {
    ensureDir(path.join(dir, name));
  }
  const active = {
    version: SCHEMA_VERSION,
    run_id: runId,
    request_revision: 1,
    workflow_revision: 1,
    state: 'PLAN_ONLY',
    workspace: path.resolve(input.workspace || process.cwd()),
    execution: null,
    reconcile: null,
    created_at: now(),
    updated_at: now()
  };
  const wf = {
    version: SCHEMA_VERSION,
    run_id: runId,
    revision: 1,
    request_revision: 1,
    destination: null,
    items: [],
    fog: [],
    current_item_id: null,
    created_at: now(),
    updated_at: now()
  };
  writeText(path.join(dir, 'requests', '0001.md'), input.request.trim() + '\n');
  writeJson(path.join(dir, 'counters.json'), {
    observation: 0, evidence: 0, phase: 0, check: 0, delivery: 0, effect: 0
  });
  writeJson(path.join(dir, 'effects.json'), { effects: [] });
  saveActive(active);
  saveWorkflow(dir, wf);
  event(dir, 'run_started', active, { state_before: 'NONE', state_after: 'PLAN_ONLY' });
  return ok({ active, wf, allowed: ['workflow.plan'] });
}

function plan(active, dir, wf, input) {
  if (active.state !== 'PLAN_ONLY') return fail('INVALID_TRANSITION', { active, wf, allowed: ['workflow.status'] });
  const destination = normalizeDestination(input.destination);
  const existingIds = new Set(wf.items.map(item => item.id));
  const items = normalizePlanItems(input.items, existingIds);
  const fog = normalizeFog(input.fog || []);
  wf.destination = destination;
  wf.items.push(...items);
  wf.fog.push(...fog);
  wf.revision += 1;
  wf.request_revision = active.request_revision;
  active.workflow_revision = wf.revision;
  active.reconcile = null;
  clearCandidate(dir);
  saveActive(active);
  saveWorkflow(dir, wf);
  makeSnapshot(dir, wf, 'planning', 'Destination, frontier, and fog persisted.');
  return advance(active, dir, wf, 'workflow_planned', 'PLAN_ONLY', { item_count: items.length, fog_count: fog.length });
}

function next(active, dir, wf) {
  if (active.state === 'RECONCILE') return fail('RECONCILE_REQUIRED', { active, wf, allowed: ['workflow.reconcile'] });
  if (active.state !== 'EXECUTE') return fail('INVALID_TRANSITION', { active, wf, allowed: ['workflow.status'] });
  if (active.execution && !active.execution.used) {
    return fail('INVALID_TRANSITION', { active, wf, allowed: ['workflow.complete', 'recover'], detail: 'current item already has a live token' });
  }
  const item = nextRunnable(wf);
  if (!item) return advance(active, dir, wf, 'workflow_advanced', 'EXECUTE');
  return executionDirective(active, dir, wf, item);
}

function resultMap(input) {
  const values = Array.isArray(input.criterion_results) ? input.criterion_results : [];
  return new Map(values.map(value => [
    String(value.criterion_id || ''),
    Array.isArray(value.evidence_ids) ? [...new Set(value.evidence_ids.map(Number))] : []
  ]));
}

function complete(active, dir, wf, input) {
  const token = validateExecutionToken(active, wf, input.execution_token);
  if (!token.valid) return fail(token.code, { active, wf, allowed: ['recover'] });
  const item = wf.items.find(candidate => candidate.id === wf.current_item_id);
  if (!item || item.status !== 'running' || !dependenciesDone(item, wf)) {
    return fail('INVALID_TRANSITION', { active, wf, currentItem: item, allowed: ['recover'] });
  }
  const pending = pendingEffects(dir, item.id);
  if (pending.length) return fail('PENDING_EFFECT', { active, wf, currentItem: item, missing: pending.map(effect => effect.operation_id) });
  const provided = resultMap(input);
  const failures = [];
  const results = [];
  for (const criterion of item.acceptance) {
    const evidenceIds = provided.get(criterion.id) || [];
    if (evidenceIds.length === 0) {
      failures.push(criterion.id);
      continue;
    }
    const verified = verifiedEvidenceForCriterion(active, dir, evidenceIds, criterion);
    if (!verified.valid) {
      failures.push(...verified.failures.map(detail => `${criterion.id}: ${detail}`));
      continue;
    }
    results.push({ criterion_id: criterion.id, evidence_ids: evidenceIds });
  }
  if (failures.length) return fail('EVIDENCE_REQUIRED', { active, wf, currentItem: item, missing: failures });
  active.execution.used = true;
  active.execution.used_at = now();
  item.status = 'done';
  item.completed_at = now();
  item.criterion_results = results;
  item.result = input.result ? String(input.result) : null;
  wf.current_item_id = null;
  makeSnapshot(dir, wf, item.id, input.summary || '');
  clearCandidate(dir);
  saveActive(active);
  saveWorkflow(dir, wf);
  if (item.kind === 'knowledge') {
    return reconcileDirective(active, dir, wf, item.id, 'knowledge_item_completed', 'EXECUTE');
  }
  return advance(active, dir, wf, 'item_completed', 'EXECUTE', { item_id: item.id });
}

function invalidateCascade(wf, roots) {
  const unknown = roots.filter(id => !wf.items.some(item => item.id === id));
  if (unknown.length) {
    throw Object.assign(new Error(`items not found: ${unknown.join(', ')}`), { code: 'INVALID_PLAN' });
  }
  const affected = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of wf.items) {
      if (!affected.has(item.id) && item.depends_on.some(id => affected.has(id))) {
        affected.add(item.id);
        changed = true;
      }
    }
  }
  const replacementIds = new Map([...affected].map(id => [id, `redo-r${wf.revision + 1}-${id}`]));
  const replacements = [];
  for (const id of affected) {
    const item = wf.items.find(candidate => candidate.id === id);
    if (!item || ['superseded', 'invalidated'].includes(item.status)) continue;
    item.status = item.status === 'done' ? 'invalidated' : 'superseded';
    item.invalidated_at = now();
    replacements.push({
      id: replacementIds.get(id),
      kind: item.kind,
      objective: `Re-evaluate after invalidation: ${item.objective}`,
      status: 'queued',
      depends_on: item.depends_on.map(dependency => replacementIds.get(dependency) || dependency),
      acceptance: item.acceptance,
      criterion_results: [],
      replaces: id,
      created_at: now()
    });
  }
  wf.items.push(...replacements);
  return { affected: [...affected], replacements: replacements.map(item => item.id) };
}

function applyFogChanges(wf, changes, canInvalidate, newItems) {
  const graduate = Array.isArray(changes?.graduate) ? changes.graduate.map(String) : [];
  const exclude = Array.isArray(changes?.exclude) ? changes.exclude.map(String) : [];
  const add = normalizeFog(changes?.add || []);
  if (exclude.length && !canInvalidate) {
    throw Object.assign(new Error('excluding fog requires validated knowledge'), { code: 'INVALID_REPLAN_REASON' });
  }
  if (graduate.length && newItems.length === 0) {
    throw Object.assign(new Error('graduating fog requires new items'), { code: 'INVALID_PLAN' });
  }
  for (const id of graduate) {
    const entry = wf.fog.find(candidate => candidate.id === id && candidate.status === 'fog');
    if (!entry) throw Object.assign(new Error(`fog entry not found: ${id}`), { code: 'INVALID_PLAN' });
    entry.status = 'graduated';
    entry.resolved_at = now();
  }
  for (const id of exclude) {
    const entry = wf.fog.find(candidate => candidate.id === id && candidate.status === 'fog');
    if (!entry) throw Object.assign(new Error(`fog entry not found: ${id}`), { code: 'INVALID_PLAN' });
    entry.status = 'excluded';
    entry.resolved_at = now();
  }
  const existing = new Set(wf.fog.map(entry => entry.id));
  if (add.some(entry => existing.has(entry.id))) {
    throw Object.assign(new Error('duplicate fog id'), { code: 'INVALID_PLAN' });
  }
  wf.fog.push(...add);
}

function reconcile(active, dir, wf, input) {
  const token = validateReconcileToken(active, wf, input.reconcile_token);
  if (!token.valid) return fail(token.code, { active, wf, allowed: ['recover'] });
  const decision = String(input.decision || '');
  const reasonCode = String(input.reason_code || '');
  if (!['no_change', 'expand', 'supersede'].includes(decision) || !REPLAN_REASONS.has(reasonCode)) {
    return fail('INVALID_REPLAN_REASON', { active, wf, missing: ['decision/reason_code'] });
  }
  const observationIds = Array.isArray(input.observation_ids) ? input.observation_ids.map(Number) : [];
  const observations = observationIds.map(id => observation(dir, id)).filter(Boolean);
  const hasValidated = observations.some(record => record.status === 'validated');
  const hasHighConfidence = observations.some(record => ['high_confidence', 'validated'].includes(record.status));
  const systemReason = ['tool_failure', 'dependency_change', 'check_failure', 'user_revision'].includes(reasonCode);
  if (decision !== 'no_change' && !hasHighConfidence && !systemReason) {
    return fail('INVALID_REPLAN_REASON', { active, wf, missing: ['high-confidence or validated observation'] });
  }
  const supersedes = Array.isArray(input.supersedes) ? input.supersedes.map(String) : [];
  const hasFogChanges = ['graduate', 'exclude', 'add'].some(key => (input.fog_changes?.[key] || []).length);
  if (decision === 'no_change' && (reasonCode !== 'no_change' || supersedes.length || (input.items || []).length || hasFogChanges)) {
    return fail('INVALID_REPLAN_REASON', { active, wf, detail: 'no_change cannot modify the route' });
  }
  if (decision !== 'no_change' && reasonCode === 'no_change') {
    return fail('INVALID_REPLAN_REASON', { active, wf, detail: 'route changes require an evidence-backed reason' });
  }
  if (decision === 'expand' && supersedes.length) {
    return fail('INVALID_REPLAN_REASON', { active, wf, detail: 'expand cannot supersede existing items' });
  }
  const touchesDone = supersedes.some(id => wf.items.find(item => item.id === id)?.status === 'done');
  if (touchesDone && !hasValidated) {
    return fail('INVALID_REPLAN_REASON', { active, wf, missing: ['validated observation for completed work'] });
  }
  const existingIds = new Set(wf.items.map(item => item.id));
  const newItems = Array.isArray(input.items) && input.items.length
    ? normalizePlanItems(input.items, existingIds)
    : [];
  let invalidation = { affected: [], replacements: [] };
  if (decision === 'supersede' && supersedes.length) {
    invalidation = invalidateCascade(wf, supersedes);
  }
  if (decision === 'expand' || decision === 'supersede') wf.items.push(...newItems);
  applyFogChanges(wf, input.fog_changes || {}, hasValidated, newItems);
  active.reconcile.used = true;
  active.reconcile.used_at = now();
  wf.revision += 1;
  active.workflow_revision = wf.revision;
  active.reconcile = null;
  clearCandidate(dir);
  saveActive(active);
  saveWorkflow(dir, wf);
  return advance(active, dir, wf, 'workflow_reconciled', 'RECONCILE', {
    decision,
    reason_code: reasonCode,
    observation_ids: observationIds,
    supersedes,
    invalidation,
    new_item_ids: newItems.map(item => item.id)
  });
}

export function interruptRun(active, dir, wf, request) {
  const text = String(request || '').trim();
  if (!text) throw Object.assign(new Error('interrupt requires request text'), { code: 'BAD_INPUT' });
  const previousState = active.state;
  active.request_revision += 1;
  active.workflow_revision = wf.revision + 1;
  active.state = 'PLAN_ONLY';
  active.execution = null;
  active.reconcile = null;
  active.release_id = null;
  writeText(path.join(dir, 'requests', `${pad(active.request_revision, 4)}.md`), text + '\n');
  for (const item of wf.items) {
    if (['queued', 'running', 'blocked'].includes(item.status)) {
      item.status = 'superseded';
      item.superseded_at = now();
      item.superseded_reason = 'new user request revision';
    }
  }
  for (const entry of wf.fog) {
    if (entry.status === 'fog') {
      entry.status = 'superseded';
      entry.resolved_at = now();
    }
  }
  wf.current_item_id = null;
  wf.revision += 1;
  wf.request_revision = active.request_revision;
  clearCandidate(dir);
  saveActive(active);
  saveWorkflow(dir, wf);
  event(dir, 'user_interrupt', active, {
    state_before: previousState,
    state_after: 'PLAN_ONLY',
    request_revision: active.request_revision
  });
  return { active, dir, wf };
}

function interrupt(active, dir, wf, input) {
  interruptRun(active, dir, wf, input.request);
  return ok({ active, wf, allowed: ['workflow.plan'] });
}

function block(active, dir, wf, input) {
  const token = validateExecutionToken(active, wf, input.execution_token);
  if (!token.valid) return fail(token.code, { active, wf, allowed: ['recover'] });
  const item = wf.items.find(candidate => candidate.id === wf.current_item_id);
  if (input.response_dependency && input.response_dependency !== 'user_input') {
    return fail('BAD_INPUT', { active, wf, missing: ['response_dependency:user_input|none'] });
  }
  item.status = 'blocked';
  item.blocker = String(input.reason || 'missing task input');
  active.execution.used = true;
  wf.current_item_id = null;
  saveActive(active);
  saveWorkflow(dir, wf);
  if (input.response_dependency === 'user_input') {
    const previousState = active.state;
    active.state = 'WAIT_USER';
    saveActive(active);
    event(dir, 'item_blocked', active, { state_before: previousState, state_after: 'WAIT_USER', item_id: item.id });
    return ok({ active, wf, allowed: ['workflow.interrupt', 'workflow.status'], extra: { blocker: item.blocker } });
  }
  return reconcileDirective(active, dir, wf, item.id, 'item_blocked', 'EXECUTE');
}

function artifact(active, dir, wf, input) {
  const record = recordEvidence(active, dir, { ...input, type: 'artifact', workflow_item_id: wf.current_item_id });
  return ok({ active, wf, allowed: ['workflow.complete', 'evidence.verify'], extra: { evidence: record } });
}

function effectPrepare(active, dir, wf, input) {
  const token = validateExecutionToken(active, wf, input.execution_token);
  if (!token.valid) return fail(token.code, { active, wf, allowed: ['recover'] });
  const operationId = String(input.operation_id || '').trim();
  const idempotencyKey = String(input.idempotency_key || '').trim();
  if (!operationId || !idempotencyKey || !input.target) {
    return fail('BAD_INPUT', { active, wf, missing: ['operation_id/idempotency_key/target'] });
  }
  const data = effects(dir);
  if (data.effects.some(effect => effect.operation_id === operationId)) {
    return fail('BAD_INPUT', { active, wf, detail: 'operation_id already exists' });
  }
  const record = {
    id: nextCounter(dir, 'effect'),
    operation_id: operationId,
    idempotency_key: idempotencyKey,
    target: String(input.target),
    workflow_item_id: wf.current_item_id,
    status: 'prepared',
    prepared_at: now()
  };
  data.effects.push(record);
  saveEffects(dir, data);
  event(dir, 'effect_prepared', active, { operation_id: operationId, item_id: wf.current_item_id });
  return ok({ active, wf, allowed: ['evidence.record', 'workflow.effect_complete'], extra: { effect: record } });
}

function effectComplete(active, dir, wf, input) {
  const data = effects(dir);
  const record = data.effects.find(effect => effect.operation_id === String(input.operation_id || ''));
  if (!record) return fail('NOT_FOUND', { active, wf, missing: [String(input.operation_id || '')] });
  const evidence = verifyEvidenceId(active, dir, Number(input.evidence_id));
  if (!evidence.valid) return fail('EVIDENCE_INVALID', { active, wf, missing: [String(input.evidence_id || '')] });
  record.status = 'completed';
  record.evidence_id = evidence.record.id;
  record.completed_at = now();
  saveEffects(dir, data);
  event(dir, 'effect_completed', active, { operation_id: record.operation_id, evidence_id: record.evidence_id });
  return ok({ active, wf, allowed: ['workflow.complete'], extra: { effect: record } });
}

function snapshot(active, dir, wf, input) {
  const file = makeSnapshot(dir, wf, input.phase || wf.current_item_id || 'current', input.summary || '');
  event(dir, 'snapshot_created', active, { snapshot: file });
  return ok({ active, wf, allowed: ['workflow.complete', 'workflow.status'], extra: { snapshot: file } });
}

function stage(active, dir, wf, input) {
  const mode = String(input.mode || '');
  if (mode !== 'final') return fail('BAD_INPUT', { active, wf, detail: 'only final responses use the release gate' });
  const content = String(input.content || '');
  if (!content.trim()) return fail('BAD_INPUT', { active, wf, missing: ['content'] });
  if (RECEIPT_PATTERN.test(content)) return fail('RESERVED_RECEIPT', { active, wf });
  if (active.state !== 'CHECK' || openItems(wf).length || activeFog(wf).length) {
    return fail('WORKFLOW_NOT_EMPTY', {
      active,
      wf,
      missing: [...openItems(wf).map(item => item.id), ...activeFog(wf).map(item => item.id)]
    });
  }
  const coverage = resultMap({ criterion_results: input.coverage });
  const failures = [];
  const normalizedCoverage = [];
  for (const criterion of wf.destination.success_criteria) {
    const evidenceIds = coverage.get(criterion.id) || [];
    const verified = verifiedEvidenceForCriterion(active, dir, evidenceIds, criterion);
    if (!verified.valid) {
      failures.push(criterion.id, ...verified.failures);
    } else {
      normalizedCoverage.push({ criterion_id: criterion.id, evidence_ids: evidenceIds });
    }
  }
  if (failures.length) return fail('EVIDENCE_REQUIRED', { active, wf, missing: failures });
  clearCandidate(dir);
  writeText(path.join(dir, 'outbox', 'draft.md'), content);
  writeJson(path.join(dir, 'outbox', 'draft.json'), {
    mode: 'final',
    run_id: active.run_id,
    request_revision: active.request_revision,
    workflow_revision: wf.revision,
    body_sha256: sha256(content),
    coverage: normalizedCoverage,
    staged_at: now()
  });
  event(dir, 'response_staged', active, { body_sha256: sha256(content) });
  return ok({ active, wf, allowed: ['check.open'] });
}

function status(active, dir, wf) {
  return ok({
    active,
    wf,
    allowed: ['recover', 'workflow.next', 'workflow.reconcile', 'workflow.stage'],
    extra: {
      current: path.join(dir, 'CURRENT.md'),
      open_items: openItems(wf),
      fog: activeFog(wf),
      pending_effects: pendingEffects(dir)
    }
  });
}

function main() {
  const action = process.argv[2];
  if (!action) return fail('BAD_USAGE');
  try {
    const input = parseInput();
    if (action === 'start') return start(input);
    const { active, dir, wf } = loadRun();
    if (action === 'plan') return plan(active, dir, wf, input);
    if (action === 'next') return next(active, dir, wf);
    if (action === 'complete') return complete(active, dir, wf, input);
    if (action === 'block') return block(active, dir, wf, input);
    if (action === 'reconcile' || action === 'regenerate') return reconcile(active, dir, wf, input);
    if (action === 'interrupt') return interrupt(active, dir, wf, input);
    if (action === 'artifact') return artifact(active, dir, wf, input);
    if (action === 'effect_prepare') return effectPrepare(active, dir, wf, input);
    if (action === 'effect_complete') return effectComplete(active, dir, wf, input);
    if (action === 'snapshot') return snapshot(active, dir, wf, input);
    if (action === 'stage') return stage(active, dir, wf, input);
    if (action === 'status') return status(active, dir, wf);
    return fail('BAD_USAGE', { active, wf });
  } catch (error) {
    return fail(errorCode(error), { detail: error.message });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
