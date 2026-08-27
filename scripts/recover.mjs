#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  activeFog, authorizeAction, errorCode, event, fail, issueExecutionToken, issueReconcileToken, loadRun,
  nextRunnable, ok, randomToken, readJson, saveActive, saveWorkflow, sha256, writeJson
} from './lib.mjs';
import { interruptRun } from './workflow.mjs';

const CONTINUE_PATTERN = /skill-continue-or-finalize/gi;
const CONTINUE_TRIGGER = /skill-continue-or-finalize/i;

function input() {
  const argument = process.argv[2];
  if (argument) return JSON.parse(argument);
  const text = fs.readFileSync(0, 'utf8').trim();
  return text ? JSON.parse(text) : {};
}

function preparedEffects(dir) {
  return readJson(path.join(dir, 'effects.json'), { effects: [] }).effects
    .filter(effect => effect.status === 'prepared');
}

function rotateReleaseToken(active, dir) {
  const file = path.join(dir, 'releases', `${String(active.release_id).padStart(6, '0')}.json`);
  const release = readJson(file);
  const token = randomToken();
  release.token_hash = sha256(token);
  release.token_rotated_at = new Date().toISOString();
  writeJson(file, release);
  return token;
}

function recover(inputValue) {
  let { active, dir, wf } = loadRun();
  const message = String(inputValue.message || '');
  const authorization = authorizeAction(active, dir, 'recover', {
    bypass: CONTINUE_TRIGGER.test(message)
  });
  if (!authorization.valid) {
    return fail(authorization.code, { active, wf, detail: authorization.detail });
  }
  if (CONTINUE_PATTERN.test(message)) {
    CONTINUE_PATTERN.lastIndex = 0;
    const remainder = message.replace(CONTINUE_PATTERN, '').trim();
    if (remainder) {
      ({ active, dir, wf } = interruptRun(active, dir, wf, remainder));
      return ok({ active, wf, allowed: ['workflow.plan'], extra: { request_revision_created: active.request_revision } });
    }
  }

  if (active.state === 'PLAN_ONLY') return ok({ active, wf, allowed: ['workflow.plan'] });

  if (active.state === 'EXECUTE') {
    const pending = preparedEffects(dir);
    if (pending.length) {
      const item = wf.items.find(candidate => candidate.id === wf.current_item_id);
      if (!item) return fail('RUNTIME_ERROR', { active, wf, detail: 'prepared effect has no current item' });
      const issued = issueExecutionToken(active, dir, wf, item);
      event(dir, 'execution_reissued', active, {
        state_before: 'EXECUTE',
        state_after: 'EXECUTE',
        item_id: item.id
      });
      return ok({
        active,
        wf,
        allowed: ['evidence.record', 'workflow.effect_complete'],
        extra: { pending_effects: pending, execution_token: issued.token, item }
      });
    }
    const item = wf.items.find(candidate => candidate.id === wf.current_item_id) || nextRunnable(wf);
    if (!item) {
      if (activeFog(wf).length) {
        const token = issueReconcileToken(active, dir, wf, 'fog');
        event(dir, 'reconcile_reissued', active, {
          state_before: 'EXECUTE',
          state_after: 'RECONCILE',
          source_item_id: 'fog'
        });
        return ok({ active, wf, allowed: ['workflow.reconcile'], extra: { reconcile_token: token, fog: activeFog(wf) } });
      }
      active.state = 'CHECK';
      active.execution = null;
      saveActive(active);
      saveWorkflow(dir, wf);
      event(dir, 'recovery_advanced', active, { state_before: 'EXECUTE', state_after: 'CHECK' });
      return ok({ active, wf, allowed: ['workflow.stage'] });
    }
    const issued = issueExecutionToken(active, dir, wf, item);
    event(dir, 'execution_reissued', active, {
      state_before: 'EXECUTE',
      state_after: 'EXECUTE',
      item_id: item.id
    });
    return ok({
      active,
      wf,
      nextItem: item,
      allowed: [
        'evidence.record',
        'observe.capture',
        'workflow.effect_prepare',
        'workflow.complete',
        'workflow.block',
        'workflow.snapshot'
      ],
      extra: { execution_token: issued.token, item }
    });
  }

  if (active.state === 'RECONCILE') {
    const sourceItemId = active.reconcile?.source_item_id || 'fog';
    const token = issueReconcileToken(active, dir, wf, sourceItemId);
    event(dir, 'reconcile_reissued', active, {
      state_before: 'RECONCILE',
      state_after: 'RECONCILE',
      source_item_id: sourceItemId
    });
    return ok({
      active,
      wf,
      allowed: [
        'workflow.reconcile',
        'workflow.regenerate',
        'observe.capture',
        'observe.validate',
        'observe.status'
      ],
      extra: { reconcile_token: token, source_item_id: sourceItemId, fog: activeFog(wf) }
    });
  }

  if (active.state === 'CHECK') {
    const staged = fs.existsSync(path.join(dir, 'outbox', 'draft.json'));
    return ok({ active, wf, allowed: [staged ? 'check.open' : 'workflow.stage'] });
  }

  if (active.state === 'READY') {
    const releaseToken = rotateReleaseToken(active, dir);
    event(dir, 'release_token_rotated', active, { release_id: active.release_id });
    return ok({ active, wf, allowed: ['check.consume'], extra: { release_token: releaseToken, release_id: active.release_id } });
  }

  if (active.state === 'CONSUMED') {
    return ok({ active, wf, allowed: ['check.redeliver', 'check.verify'], extra: { release_id: active.release_id } });
  }

  if (active.state === 'WAIT_USER') {
    return ok({ active, wf, allowed: ['workflow.interrupt', 'workflow.status'] });
  }

  return fail('INVALID_TRANSITION', { active, wf, allowed: ['workflow.status'] });
}

try {
  recover(input());
} catch (error) {
  fail(errorCode(error), { detail: error.message });
}
