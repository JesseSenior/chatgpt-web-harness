#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  errorCode, event, exists, fail, loadRun, nextCounter, now, ok, pad, parseInput, readJson, writeJson
} from './lib.mjs';
import { verifyEvidenceId } from './evidence-lib.mjs';

const CONFIDENCE = new Set(['provisional', 'high_confidence', 'validated']);

function observationPath(dir, id) {
  return path.join(dir, 'observations', `${pad(Number(id))}.json`);
}

function loadObservation(dir, id) {
  const file = observationPath(dir, id);
  return exists(file) ? readJson(file) : null;
}

function verifyAttachedEvidence(active, dir, ids) {
  const results = ids.map(id => verifyEvidenceId(active, dir, id));
  return {
    valid: results.length > 0 && results.every(result => result.valid),
    failures: results.filter(result => !result.valid).map((result, index) => String(ids[index]))
  };
}

function capture(active, dir, wf, input) {
  const statement = String(input.statement || '').trim();
  const confidence = String(input.confidence || 'provisional');
  const evidenceIds = Array.isArray(input.evidence_ids) ? [...new Set(input.evidence_ids.map(Number))] : [];
  const sourceRefs = Array.isArray(input.source_refs) ? [...new Set(input.source_refs.map(String))] : [];
  if (!statement || !CONFIDENCE.has(confidence)) return fail('BAD_INPUT', { active, wf, missing: ['statement/confidence'] });
  if (confidence === 'high_confidence' && evidenceIds.length === 0 && sourceRefs.length === 0) {
    return fail('EVIDENCE_REQUIRED', { active, wf, missing: ['evidence_ids or source_refs'] });
  }
  if (confidence === 'validated') {
    const evidence = verifyAttachedEvidence(active, dir, evidenceIds);
    if (!evidence.valid) return fail('EVIDENCE_INVALID', { active, wf, missing: evidence.failures.length ? evidence.failures : ['evidence_ids'] });
  }
  const id = nextCounter(dir, 'observation');
  const record = {
    id,
    statement,
    confidence,
    status: confidence,
    evidence_ids: evidenceIds,
    source_refs: sourceRefs,
    supersedes: Array.isArray(input.supersedes) ? input.supersedes.map(Number) : [],
    workflow_item_id: input.workflow_item_id || wf.current_item_id || null,
    created_at: now(),
    updated_at: now()
  };
  writeJson(observationPath(dir, id), record);
  event(dir, 'observation_captured', active, { observation_id: id, confidence });
  return ok({
    active,
    wf,
    allowed: ['observe.validate', 'workflow.complete', 'observe.capture'],
    extra: { observation: record }
  });
}

function validate(active, dir, wf, input) {
  const record = loadObservation(dir, Number(input.id));
  if (!record) return fail('NOT_FOUND', { active, wf, missing: [String(input.id || '')] });
  const added = Array.isArray(input.evidence_ids) ? input.evidence_ids.map(Number) : [];
  record.evidence_ids = [...new Set([...record.evidence_ids, ...added])];
  const evidence = verifyAttachedEvidence(active, dir, record.evidence_ids);
  if (!evidence.valid) return fail('EVIDENCE_INVALID', { active, wf, missing: evidence.failures.length ? evidence.failures : ['evidence_ids'] });
  record.confidence = 'validated';
  record.status = 'validated';
  record.updated_at = now();
  writeJson(observationPath(dir, record.id), record);
  event(dir, 'observation_validated', active, { observation_id: record.id });
  return ok({ active, wf, allowed: ['workflow.reconcile', 'workflow.complete'], extra: { observation: record } });
}

function supersede(active, dir, wf, input) {
  const record = loadObservation(dir, Number(input.id));
  if (!record) return fail('NOT_FOUND', { active, wf, missing: [String(input.id || '')] });
  record.status = 'superseded';
  record.superseded_reason = String(input.reason || 'newer knowledge');
  record.updated_at = now();
  writeJson(observationPath(dir, record.id), record);
  event(dir, 'observation_superseded', active, { observation_id: record.id });
  return ok({ active, wf, allowed: ['observe.capture', 'workflow.reconcile'], extra: { observation: record } });
}

function status(active, dir, wf) {
  const directory = path.join(dir, 'observations');
  const records = exists(directory)
    ? fs.readdirSync(directory).filter(name => /^\d{6}\.json$/.test(name)).sort().map(name => readJson(path.join(directory, name)))
    : [];
  return ok({ active, wf, allowed: ['observe.capture', 'observe.validate'], extra: { observations: records } });
}

function main() {
  const action = process.argv[2];
  if (!action) return fail('BAD_USAGE');
  try {
    const input = parseInput();
    const { active, dir, wf } = loadRun();
    if (action === 'capture') return capture(active, dir, wf, input);
    if (action === 'validate' || action === 'promote') return validate(active, dir, wf, input);
    if (action === 'supersede') return supersede(active, dir, wf, input);
    if (action === 'status') return status(active, dir, wf);
    return fail('BAD_USAGE', { active, wf });
  } catch (error) {
    return fail(errorCode(error), { detail: error.message });
  }
}

main();
