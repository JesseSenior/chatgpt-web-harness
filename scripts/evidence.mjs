#!/usr/bin/env node
import { errorCode, event, fail, loadRun, ok, parseInput, writeJson } from './lib.mjs';
import {
  evidencePath, listEvidence, loadEvidence, recordEvidence, verifyEvidenceId
} from './evidence-lib.mjs';

function main() {
  const action = process.argv[2];
  if (!action) return fail('BAD_USAGE');
  try {
    const input = parseInput();
    const { active, dir, wf } = loadRun();
    if (action === 'record') {
      const record = recordEvidence(active, dir, input);
      return ok({ active, wf, allowed: ['evidence.verify', 'observe.capture', 'workflow.complete'], extra: { evidence: record } });
    }
    if (action === 'verify') {
      const result = verifyEvidenceId(active, dir, Number(input.id));
      if (!result.record) return fail('NOT_FOUND', { active, wf, missing: [String(input.id || '')] });
      event(dir, 'evidence_verified', active, { evidence_id: result.record.id, valid: result.valid });
      if (!result.valid) return fail('EVIDENCE_INVALID', { active, wf, missing: [String(result.record.id)], detail: result.detail });
      return ok({ active, wf, allowed: ['observe.capture', 'workflow.complete'], extra: { evidence: result.record } });
    }
    if (action === 'invalidate') {
      const record = loadEvidence(dir, Number(input.id));
      if (!record) return fail('NOT_FOUND', { active, wf, missing: [String(input.id || '')] });
      record.status = 'invalid';
      record.invalidated_reason = String(input.reason || 'source is no longer current');
      writeJson(evidencePath(dir, record.id), record);
      event(dir, 'evidence_invalidated', active, { evidence_id: record.id });
      return ok({ active, wf, allowed: ['observe.supersede', 'workflow.reconcile'], extra: { evidence: record } });
    }
    if (action === 'status') {
      return ok({ active, wf, allowed: ['evidence.record', 'evidence.verify'], extra: { evidence: listEvidence(dir) } });
    }
    return fail('BAD_USAGE', { active, wf });
  } catch (error) {
    return fail(errorCode(error), { detail: error.message });
  }
}

main();
