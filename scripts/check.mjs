#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonical, lastEventHash, sha256, verifyEventChain } from './audit.mjs';
import {
  EVIDENCE_TYPES, activeFog, authorizeAction, errorCode, event, exists, fail, loadRun,
  nextCounter, now, ok, openItems, pad, parseInput, permissionStateFailures, randomToken,
  readJson, readText, saveActive, saveWorkflow, writeJson, writeText
} from './lib.mjs';
import { verifyEvidenceId, verifiedEvidenceForCriterion } from './evidence-lib.mjs';
import {
  SHUORENHUA_SEMANTIC_CHECKS, SHUORENHUA_SOURCE, auditShuorenhua
} from './shuorenhua.mjs';

const BASE_MODEL_CHECKS = [
  { id: 'destination-answer', text: 'The final response answers the stable destination.' },
  { id: 'user-constraints', text: 'The final response satisfies the persisted user constraints.' },
  { id: 'grounded-claims', text: 'Material final-response claims are supported by verified evidence.' }
];

function modelChecks(shuorenhua) {
  return [
    ...BASE_MODEL_CHECKS,
    {
      id: 'shuorenhua-style',
      text: 'The final response passes the complete offline shuorenhua semantic audit.',
      source_commit: SHUORENHUA_SOURCE.commit,
      audit_sha256: shuorenhua.audit_sha256,
      checklist: SHUORENHUA_SEMANTIC_CHECKS
    }
  ];
}

function draftState(dir) {
  const bodyFile = path.join(dir, 'outbox', 'draft.md');
  const metaFile = path.join(dir, 'outbox', 'draft.json');
  if (!exists(bodyFile) || !exists(metaFile)) return null;
  const body = readText(bodyFile);
  return { body, meta: readJson(metaFile), body_sha256: sha256(body) };
}

function releaseMetaPath(dir, id) {
  return path.join(dir, 'releases', `${pad(Number(id))}.json`);
}

function releaseBodyPath(dir, id) {
  return path.join(dir, 'releases', `${pad(Number(id))}.md`);
}

function loadRelease(dir, id) {
  const metaFile = releaseMetaPath(dir, id);
  const bodyFile = releaseBodyPath(dir, id);
  if (!exists(metaFile) || !exists(bodyFile)) return null;
  return { meta: readJson(metaFile), body: readText(bodyFile) };
}

function releaseIntegrityFailures(release, eventAudit) {
  const writingAudit = auditShuorenhua(release.body);
  const readyEvent = eventAudit.events.find(record =>
    record.type === 'check_ready' && record.payload.release_id === release.meta.id
  );
  const failures = [];
  if (sha256(release.body) !== release.meta.body_sha256) failures.push('release body');
  if (!writingAudit.pass) {
    failures.push(...writingAudit.violations.map(value => `shuorenhua:${value.rule_id}:${value.line}:${value.column}`));
  }
  if (writingAudit.audit_sha256 !== release.meta.shuorenhua_audit_sha256) failures.push('shuorenhua audit');
  if (writingAudit.source_commit !== release.meta.shuorenhua_source_commit) failures.push('shuorenhua source');
  if (!readyEvent) {
    failures.push('check_ready event');
  } else {
    if (readyEvent.payload.body_sha256 !== release.meta.body_sha256) failures.push('check_ready body');
    if (readyEvent.payload.shuorenhua_audit_sha256 !== release.meta.shuorenhua_audit_sha256) {
      failures.push('check_ready shuorenhua audit');
    }
    if (readyEvent.payload.shuorenhua_source_commit !== release.meta.shuorenhua_source_commit) {
      failures.push('check_ready shuorenhua source');
    }
  }
  return failures;
}

function effectFailures(dir) {
  const data = readJson(path.join(dir, 'effects.json'), { effects: [] });
  return data.effects.filter(effect => effect.status !== 'completed').map(effect => effect.operation_id);
}

function itemEvidenceFailures(active, dir, wf) {
  const failures = [];
  for (const item of wf.items.filter(candidate => candidate.status === 'done')) {
    const map = new Map((item.criterion_results || []).map(result => [result.criterion_id, result.evidence_ids]));
    for (const criterion of item.acceptance) {
      const ids = map.get(criterion.id) || [];
      const result = verifiedEvidenceForCriterion(active, dir, ids, criterion);
      if (!result.valid) failures.push(`${item.id}/${criterion.id}`);
    }
  }
  return failures;
}

function coverageFailures(active, dir, wf, draft) {
  const map = new Map((draft?.meta.coverage || []).map(result => [result.criterion_id, result.evidence_ids]));
  const failures = [];
  for (const criterion of wf.destination.success_criteria) {
    const result = verifiedEvidenceForCriterion(active, dir, map.get(criterion.id) || [], criterion);
    if (!result.valid) failures.push(criterion.id);
  }
  return failures;
}

function mechanical(active, dir, wf, draft) {
  const audit = verifyEventChain(dir);
  const shuorenhua = draft ? auditShuorenhua(draft.body) : null;
  const failures = [];
  if (!draft) failures.push('missing-draft');
  if (draft && draft.meta.body_sha256 !== draft.body_sha256) failures.push('draft-hash');
  if (draft && (draft.meta.request_revision !== active.request_revision || draft.meta.workflow_revision !== wf.revision)) {
    failures.push('stale-draft');
  }
  failures.push(...openItems(wf).map(item => `open-item:${item.id}`));
  failures.push(...activeFog(wf).map(item => `active-fog:${item.id}`));
  failures.push(...effectFailures(dir).map(id => `pending-effect:${id}`));
  failures.push(...itemEvidenceFailures(active, dir, wf).map(id => `item-evidence:${id}`));
  if (draft) failures.push(...coverageFailures(active, dir, wf, draft).map(id => `destination-evidence:${id}`));
  if (shuorenhua && !shuorenhua.pass) {
    failures.push(...shuorenhua.violations.map(value => `shuorenhua:${value.rule_id}:${value.line}:${value.column}`));
  }
  if (shuorenhua && draft.meta.shuorenhua_audit_sha256 !== shuorenhua.audit_sha256) {
    failures.push('shuorenhua:audit-hash');
  }
  if (shuorenhua && draft.meta.shuorenhua_source_commit !== shuorenhua.source_commit) {
    failures.push('shuorenhua:source-commit');
  }
  if (!audit.valid) failures.push(...audit.failures.map(value => `audit:${value}`));
  if (audit.valid && audit.replay_state !== active.state) failures.push('audit:active state mismatch');
  if (audit.valid) failures.push(...permissionStateFailures(active, audit).map(value => `audit:${value}`));
  return { pass: failures.length === 0, failures, audit, shuorenhua };
}

function remediation(active, dir, wf, checkRecord, failures, violations = []) {
  checkRecord.status = 'BLOCKED';
  checkRecord.failures = failures;
  checkRecord.completed_at = now();
  writeJson(path.join(dir, 'checks', `${pad(checkRecord.id)}.json`), checkRecord);
  const revision = wf.revision + 1;
  const ids = new Set(wf.items.map(item => item.id));
  failures.forEach((reason, index) => {
    let id = `check-${checkRecord.id}-${index + 1}`;
    while (ids.has(id)) id = `r${revision}-${id}`;
    ids.add(id);
    wf.items.push({
      id,
      kind: 'execution',
      objective: `Remediate final check failure: ${reason}`,
      status: 'queued',
      depends_on: [],
      acceptance: [{
        id: 'resolved',
        text: `The final check failure '${reason}' is resolved.`,
        evidence_types: [...EVIDENCE_TYPES]
      }],
      criterion_results: [],
      created_at: now(),
      triggered_by_check: checkRecord.id
    });
  });
  wf.revision = revision;
  wf.current_item_id = null;
  active.workflow_revision = revision;
  active.state = 'EXECUTE';
  active.execution = null;
  saveActive(active);
  saveWorkflow(dir, wf);
  event(dir, 'check_failed', active, {
    state_before: 'CHECK',
    state_after: 'EXECUTE',
    check_id: checkRecord.id,
    failures
  });
  return fail('CHECK_FAILED', {
    active,
    wf,
    missing: failures,
    allowed: ['workflow.next'],
    violations,
    transition: true
  });
}

function openCheck(active, dir, wf) {
  if (active.state !== 'CHECK') return fail('INVALID_TRANSITION', { active, wf, allowed: ['workflow.status'] });
  const draft = draftState(dir);
  const result = mechanical(active, dir, wf, draft);
  if (result.failures.some(value => value.startsWith('audit:'))) {
    return fail('RUNTIME_ERROR', { active, wf, missing: result.failures.filter(value => value.startsWith('audit:')) });
  }
  const id = nextCounter(dir, 'check');
  const checks = result.shuorenhua ? modelChecks(result.shuorenhua) : BASE_MODEL_CHECKS;
  const record = {
    id,
    status: 'OPEN',
    opened_at: now(),
    run_id: active.run_id,
    request_revision: active.request_revision,
    workflow_revision: wf.revision,
    draft_sha256: draft?.body_sha256 || null,
    model_checks: checks,
    mechanical: result
  };
  writeJson(path.join(dir, 'checks', `${pad(id)}.json`), record);
  if (!result.pass) {
    return remediation(active, dir, wf, record, result.failures, result.shuorenhua?.violations || []);
  }
  event(dir, 'check_opened', active, {
    check_id: id,
    draft_sha256: draft.body_sha256,
    shuorenhua_audit_sha256: result.shuorenhua.audit_sha256,
    shuorenhua_source_commit: result.shuorenhua.source_commit
  });
  return ok({ active, wf, allowed: ['check.submit'], extra: { check_id: id, checks } });
}

function normalizedAnswers(input) {
  const answers = Array.isArray(input.answers) ? input.answers : [];
  return new Map(answers.map(answer => [
    String(answer.id || ''),
    {
      answer: String(answer.answer || '').toLowerCase(),
      evidence_ids: Array.isArray(answer.evidence_ids) ? [...new Set(answer.evidence_ids.map(Number))] : []
    }
  ]));
}

function submitCheck(active, dir, wf, input) {
  if (active.state !== 'CHECK') return fail('INVALID_TRANSITION', { active, wf });
  const id = Number(input.check_id);
  const file = path.join(dir, 'checks', `${pad(id)}.json`);
  if (!id || !exists(file)) return fail('NOT_FOUND', { active, wf, missing: [String(input.check_id || '')] });
  const record = readJson(file);
  if (record.status !== 'OPEN') return fail('INVALID_TRANSITION', { active, wf });
  const draft = draftState(dir);
  const mechanicalResult = mechanical(active, dir, wf, draft);
  const expectedChecks = mechanicalResult.shuorenhua ? modelChecks(mechanicalResult.shuorenhua) : [];
  if (
    !mechanicalResult.pass
    || record.workflow_revision !== wf.revision
    || record.draft_sha256 !== draft?.body_sha256
    || canonical(record.model_checks) !== canonical(expectedChecks)
  ) {
    return remediation(
      active,
      dir,
      wf,
      record,
      [...mechanicalResult.failures, 'stale-open-check'],
      mechanicalResult.shuorenhua?.violations || []
    );
  }
  const answers = normalizedAnswers(input);
  const failures = [];
  const storedAnswers = [];
  for (const check of expectedChecks) {
    const answer = answers.get(check.id);
    if (!answer || answer.answer !== 'yes' || answer.evidence_ids.length === 0) {
      failures.push(check.id);
      continue;
    }
    const invalid = answer.evidence_ids.filter(evidenceId => !verifyEvidenceId(active, dir, evidenceId).valid);
    if (invalid.length) {
      failures.push(...invalid.map(evidenceId => `${check.id}:${evidenceId}`));
      continue;
    }
    storedAnswers.push({ id: check.id, answer: 'yes', evidence_ids: answer.evidence_ids });
  }
  record.answers = storedAnswers;
  record.submitted_at = now();
  if (failures.length) return remediation(active, dir, wf, record, failures);

  const releaseId = record.id;
  const releaseToken = randomToken();
  const release = {
    id: releaseId,
    status: 'ready',
    run_id: active.run_id,
    request_revision: active.request_revision,
    workflow_revision: wf.revision,
    check_id: record.id,
    body_sha256: draft.body_sha256,
    shuorenhua_audit_sha256: mechanicalResult.shuorenhua.audit_sha256,
    shuorenhua_source_commit: mechanicalResult.shuorenhua.source_commit,
    token_hash: sha256(releaseToken),
    ready_at: now()
  };
  writeText(releaseBodyPath(dir, releaseId), draft.body);
  writeJson(releaseMetaPath(dir, releaseId), release);
  record.status = 'READY';
  record.release_id = releaseId;
  writeJson(file, record);
  active.state = 'READY';
  active.release_id = releaseId;
  saveActive(active);
  event(dir, 'check_ready', active, {
    state_before: 'CHECK',
    state_after: 'READY',
    check_id: record.id,
    release_id: releaseId,
    body_sha256: draft.body_sha256,
    shuorenhua_audit_sha256: mechanicalResult.shuorenhua.audit_sha256,
    shuorenhua_source_commit: mechanicalResult.shuorenhua.source_commit
  });
  return ok({ active, wf, allowed: ['check.consume'], extra: { release_token: releaseToken, release_id: releaseId } });
}

function createDelivery(active, dir, wf, release) {
  const deliveryId = nextCounter(dir, 'delivery');
  const nonce = crypto.randomBytes(32).toString('hex');
  const material = {
    receipt_id: `${active.run_id}:${deliveryId}`,
    run_id: active.run_id,
    request_revision: release.meta.request_revision,
    workflow_revision: release.meta.workflow_revision,
    check_id: release.meta.check_id,
    release_id: release.meta.id,
    delivery_sequence: deliveryId,
    body_sha256: release.meta.body_sha256,
    shuorenhua_audit_sha256: release.meta.shuorenhua_audit_sha256,
    shuorenhua_source_commit: release.meta.shuorenhua_source_commit,
    nonce,
    previous_event_sha256: lastEventHash(dir)
  };
  const receiptSha256 = sha256(canonical(material));
  const record = {
    ...material,
    receipt_sha256: receiptSha256,
    delivered_at: now()
  };
  event(dir, 'delivery_created', active, {
    delivery_id: deliveryId,
    release_id: release.meta.id,
    receipt_sha256: receiptSha256,
    receipt_material: material
  });
  writeJson(path.join(dir, 'deliveries', `${pad(deliveryId)}.json`), record);
  const releasedResponse = `${release.body}\n\nWorkflow-Receipt: sha256:${receiptSha256}`;
  return { record, releasedResponse };
}

function consume(active, dir, wf, input) {
  if (active.state !== 'READY') return fail('INVALID_TRANSITION', { active, wf, allowed: ['recover'] });
  const release = loadRelease(dir, active.release_id);
  if (!release) return fail('NO_FINAL_RELEASE', { active, wf });
  if (release.meta.status !== 'ready' || sha256(String(input.release_token || '')) !== release.meta.token_hash) {
    return fail('BAD_RELEASE_TOKEN', { active, wf });
  }
  const audit = verifyEventChain(dir);
  const integrityFailures = audit.valid ? releaseIntegrityFailures(release, audit) : [];
  if (!audit.valid || audit.replay_state !== 'READY' || integrityFailures.length) {
    return fail('RUNTIME_ERROR', { active, wf, missing: [...audit.failures, ...integrityFailures] });
  }
  release.meta.status = 'consumed';
  release.meta.consumed_at = now();
  delete release.meta.token_hash;
  writeJson(releaseMetaPath(dir, release.meta.id), release.meta);
  active.state = 'CONSUMED';
  saveActive(active);
  event(dir, 'final_consumed', active, {
    state_before: 'READY',
    state_after: 'CONSUMED',
    release_id: release.meta.id
  });
  const delivery = createDelivery(active, dir, wf, release);
  return ok({
    active,
    wf,
    allowed: ['check.redeliver', 'check.verify'],
    extra: {
      required_output: 'send_released_response_exactly',
      released_response: delivery.releasedResponse,
      receipt_sha256: delivery.record.receipt_sha256,
      delivery_id: delivery.record.delivery_sequence
    }
  });
}

function redeliver(active, dir, wf) {
  if (active.state !== 'CONSUMED') return fail('INVALID_TRANSITION', { active, wf, allowed: ['recover'] });
  const release = loadRelease(dir, active.release_id);
  if (!release || release.meta.status !== 'consumed') return fail('NO_FINAL_RELEASE', { active, wf });
  const audit = verifyEventChain(dir);
  const integrityFailures = audit.valid ? releaseIntegrityFailures(release, audit) : [];
  if (!audit.valid || audit.replay_state !== 'CONSUMED' || integrityFailures.length) {
    return fail('RUNTIME_ERROR', { active, wf, missing: [...audit.failures, ...integrityFailures] });
  }
  const delivery = createDelivery(active, dir, wf, release);
  return ok({
    active,
    wf,
    allowed: ['check.redeliver', 'check.verify'],
    extra: {
      required_output: 'send_released_response_exactly',
      released_response: delivery.releasedResponse,
      receipt_sha256: delivery.record.receipt_sha256,
      delivery_id: delivery.record.delivery_sequence
    }
  });
}

function deliveryRecords(dir, events = []) {
  const directory = path.join(dir, 'deliveries');
  const records = !exists(directory) ? [] : fs.readdirSync(directory)
    .filter(name => /^\d{6}\.json$/.test(name))
    .sort()
    .map(name => readJson(path.join(directory, name)));
  const known = new Set(records.map(record => record.receipt_sha256));
  for (const eventRecord of events.filter(record => record.type === 'delivery_created')) {
    const receipt = eventRecord.payload.receipt_sha256;
    if (!known.has(receipt) && eventRecord.payload.receipt_material) {
      records.push({
        ...eventRecord.payload.receipt_material,
        receipt_sha256: receipt,
        delivered_at: eventRecord.at
      });
    }
  }
  return records;
}

function verifyReceipt(active, dir, wf, input) {
  const receipt = String(input.receipt || '').replace(/^sha256:/i, '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(receipt)) return fail('RECEIPT_INVALID', { active, wf, missing: ['receipt'] });
  const audit = verifyEventChain(dir);
  const permissionFailures = audit.valid ? permissionStateFailures(active, audit) : [];
  if (!audit.valid || audit.replay_state !== active.state || permissionFailures.length) {
    return fail('RECEIPT_INVALID', { active, wf, missing: [...audit.failures, ...permissionFailures] });
  }
  const delivery = deliveryRecords(dir, audit.events).find(record => record.receipt_sha256 === receipt);
  if (!delivery) return fail('RECEIPT_INVALID', { active, wf, missing: [receipt] });
  const { receipt_sha256: stored, delivered_at, ...material } = delivery;
  void delivered_at;
  if (sha256(canonical(material)) !== stored) return fail('RECEIPT_INVALID', { active, wf, missing: ['receipt material'] });
  const release = loadRelease(dir, delivery.release_id);
  const releaseFailures = release ? releaseIntegrityFailures(release, audit) : ['release body'];
  if (
    !release
    || sha256(release.body) !== delivery.body_sha256
    || release.meta.shuorenhua_audit_sha256 !== delivery.shuorenhua_audit_sha256
    || release.meta.shuorenhua_source_commit !== delivery.shuorenhua_source_commit
    || releaseFailures.length
  ) {
    return fail('RECEIPT_INVALID', { active, wf, missing: ['release body'] });
  }
  if (input.content) {
    const footer = new RegExp(`\\n\\nWorkflow-Receipt:\\s*sha256:${receipt}\\s*$`, 'i');
    const body = String(input.content).replace(footer, '');
    if (sha256(body) !== delivery.body_sha256) return fail('RECEIPT_INVALID', { active, wf, missing: ['provided content'] });
  }
  const matchingEvent = audit.events.find(eventRecord =>
    eventRecord.type === 'delivery_created' && eventRecord.payload.receipt_sha256 === receipt
  );
  if (!matchingEvent) return fail('RECEIPT_INVALID', { active, wf, missing: ['delivery event'] });
  if (canonical(matchingEvent.payload.receipt_material) !== canonical(material)) {
    return fail('RECEIPT_INVALID', { active, wf, missing: ['delivery event material'] });
  }
  return ok({
    active,
    wf,
    allowed: ['check.verify', 'check.redeliver'],
    extra: {
      valid: true,
      receipt_sha256: receipt,
      release_id: delivery.release_id,
      body_sha256: delivery.body_sha256,
      delivery_sequence: delivery.delivery_sequence,
      audit_head_sha256: audit.head_sha256
    }
  });
}

function main() {
  const action = process.argv[2];
  if (!action) return fail('BAD_USAGE');
  let context = null;
  try {
    context = loadRun();
    const { active, dir, wf } = context;
    const authorization = authorizeAction(active, dir, `check.${action}`);
    if (!authorization.valid) {
      const code = action === 'verify' && authorization.code === 'RUNTIME_ERROR'
        ? 'RECEIPT_INVALID'
        : authorization.code;
      return fail(code, { active, wf, detail: authorization.detail });
    }
    const input = parseInput();
    if (action === 'open') return openCheck(active, dir, wf);
    if (action === 'submit') return submitCheck(active, dir, wf, input);
    if (action === 'consume') return consume(active, dir, wf, input);
    if (action === 'redeliver') return redeliver(active, dir, wf);
    if (action === 'verify') return verifyReceipt(active, dir, wf, input);
    return fail('BAD_USAGE', { active, wf });
  } catch (error) {
    return fail(errorCode(error), {
      active: context?.active,
      wf: context?.wf,
      detail: error.message
    });
  }
}

main();
