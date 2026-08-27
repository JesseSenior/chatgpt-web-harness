#!/usr/bin/env node
import path from 'node:path';
import {
  authorizeAction, errorCode, event, fail, loadRun, ok, parseInput, readJson, writeJson
} from './lib.mjs';
import {
  evidencePath, listEvidence, loadEvidence, recordEvidence, verifyEvidenceId
} from './evidence-lib.mjs';

function nextCalls(active, dir, base) {
  const effects = readJson(path.join(dir, 'effects.json'), { effects: [] }).effects;
  const pending = effects.some(effect =>
    effect.status === 'prepared' && effect.workflow_item_id === active.execution?.item_id
  );
  return pending
    ? [...base.filter(call => call !== 'workflow.complete'), 'workflow.effect_complete']
    : base;
}

function main() {
  const action = process.argv[2];
  if (!action) return fail('BAD_USAGE');
  let context = null;
  try {
    context = loadRun();
    const { active, dir, wf } = context;
    const authorization = authorizeAction(active, dir, `evidence.${action}`);
    if (!authorization.valid) {
      return fail(authorization.code, { active, wf, detail: authorization.detail });
    }
    const input = parseInput();
    if (action === 'record') {
      const record = recordEvidence(active, dir, input);
      return ok({
        active,
        wf,
        allowed: nextCalls(active, dir, ['evidence.verify', 'observe.capture', 'workflow.complete']),
        extra: { evidence: record }
      });
    }
    if (action === 'verify') {
      const result = verifyEvidenceId(active, dir, Number(input.id));
      if (!result.record) return fail('NOT_FOUND', { active, wf, missing: [String(input.id || '')] });
      event(dir, 'evidence_verified', active, { evidence_id: result.record.id, valid: result.valid });
      if (!result.valid) return fail('EVIDENCE_INVALID', { active, wf, missing: [String(result.record.id)], detail: result.detail });
      return ok({
        active,
        wf,
        allowed: nextCalls(active, dir, ['observe.capture', 'workflow.complete']),
        extra: { evidence: result.record }
      });
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
      return ok({ active, wf, allowed: active.allowed_next_calls, extra: { evidence: listEvidence(dir) } });
    }
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
