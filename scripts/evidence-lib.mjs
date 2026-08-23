import fs from 'node:fs';
import path from 'node:path';
import {
  EVIDENCE_TYPES, exists, nextCounter, now, pad, readJson, sha256, writeJson, event
} from './lib.mjs';

export function evidencePath(dir, id) {
  return path.join(dir, 'evidence', `${pad(Number(id))}.json`);
}

export function loadEvidence(dir, id) {
  const file = evidencePath(dir, id);
  return exists(file) ? readJson(file) : null;
}

function digestFile(file) {
  return sha256(fs.readFileSync(file));
}

function resolvedPath(active, value) {
  return path.isAbsolute(value) ? value : path.resolve(active.workspace, value);
}

export function verifyEvidenceRecord(active, dir, record, persist = true) {
  if (record.status === 'invalid') {
    return { valid: false, record, detail: record.invalidated_reason || 'evidence is invalidated' };
  }
  let valid = false;
  let detail = '';
  let currentSha256 = null;

  if (record.type === 'request') {
    const file = path.join(dir, 'requests', `${pad(record.request_revision, 4)}.md`);
    valid = exists(file);
    if (valid) currentSha256 = digestFile(file);
    detail = valid ? 'request revision exists' : 'request revision is missing';
  } else if (record.path) {
    const file = resolvedPath(active, record.path);
    valid = exists(file) && fs.statSync(file).isFile();
    if (valid) currentSha256 = digestFile(file);
    detail = valid ? 'snapshot exists' : 'snapshot is missing';
  } else {
    detail = 'no mechanically readable snapshot';
  }

  if (valid && record.sha256 && record.sha256 !== currentSha256) {
    valid = false;
    detail = 'snapshot hash changed';
  }

  record.status = valid ? 'verified' : 'recorded';
  record.verified_at = valid ? now() : null;
  record.verification_detail = detail;
  if (currentSha256) record.sha256 = currentSha256;
  if (persist) writeJson(evidencePath(dir, record.id), record);
  return { valid, record, detail };
}

export function recordEvidence(active, dir, input) {
  const type = String(input.type || '');
  if (!EVIDENCE_TYPES.has(type)) {
    throw Object.assign(new Error(`unsupported evidence type: ${type}`), { code: 'BAD_INPUT' });
  }
  if (type === 'artifact' && !input.path) {
    throw Object.assign(new Error('artifact evidence requires path'), { code: 'BAD_INPUT' });
  }
  const id = nextCounter(dir, 'evidence');
  const record = {
    id,
    type,
    status: 'recorded',
    created_at: now(),
    workflow_item_id: input.workflow_item_id || null,
    request_revision: type === 'request' ? Number(input.request_revision || active.request_revision) : active.request_revision,
    path: input.path ? String(input.path) : null,
    source_id: input.source_id ? String(input.source_id) : null,
    source_url: input.source_url ? String(input.source_url) : null,
    result_id: input.result_id ? String(input.result_id) : null,
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {}
  };
  verifyEvidenceRecord(active, dir, record);
  event(dir, 'evidence_recorded', active, {
    evidence_id: id,
    evidence_type: type,
    status: record.status
  });
  return record;
}

export function verifyEvidenceId(active, dir, id) {
  const record = loadEvidence(dir, id);
  if (!record) return { valid: false, detail: 'evidence not found', record: null };
  return verifyEvidenceRecord(active, dir, record);
}

export function verifiedEvidenceForCriterion(active, dir, evidenceIds, criterion) {
  const records = [];
  const failures = [];
  for (const id of evidenceIds) {
    const result = verifyEvidenceId(active, dir, id);
    if (!result.valid) {
      failures.push(`${id}: ${result.detail}`);
      continue;
    }
    if (!criterion.evidence_types.includes(result.record.type)) {
      failures.push(`${id}: type ${result.record.type} is not allowed`);
      continue;
    }
    records.push(result.record);
  }
  return { valid: records.length > 0 && failures.length === 0, records, failures };
}

export function listEvidence(dir) {
  const directory = path.join(dir, 'evidence');
  if (!exists(directory)) return [];
  return fs.readdirSync(directory)
    .filter(name => /^\d{6}\.json$/.test(name))
    .sort()
    .map(name => readJson(path.join(directory, name)));
}
