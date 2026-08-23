import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  run, simplePlan, start, requestEvidence, temporaryWorkspace
} from './helpers.mjs';

test('plan rejects cycles and incomplete item contracts', async t => {
  await t.test('dependency cycle', () => {
    const workspace = temporaryWorkspace(t);
    start(workspace);
    const result = run(workspace, 'workflow.mjs', 'plan', {
      ...simplePlan(),
      items: [
        {
          id: 'a',
          kind: 'execution',
          objective: 'A',
          depends_on: ['b'],
          acceptance: [{ id: 'a-done', text: 'A done', evidence_types: ['request'] }]
        },
        {
          id: 'b',
          kind: 'execution',
          objective: 'B',
          depends_on: ['a'],
          acceptance: [{ id: 'b-done', text: 'B done', evidence_types: ['request'] }]
        }
      ]
    }, 1);
    assert.equal(result.error.code, 'INVALID_PLAN');
  });

  await t.test('missing acceptance evidence contract', () => {
    const workspace = temporaryWorkspace(t);
    start(workspace);
    const result = run(workspace, 'workflow.mjs', 'plan', {
      ...simplePlan(),
      items: [{ id: 'work', kind: 'execution', objective: 'Work', depends_on: [], acceptance: [] }]
    }, 1);
    assert.equal(result.error.code, 'INVALID_PLAN');
  });
});

test('execution requires the current fresh token and criterion evidence', t => {
  const workspace = temporaryWorkspace(t);
  start(workspace);
  const planned = run(workspace, 'workflow.mjs', 'plan', simplePlan());
  const originalToken = planned.directive.execution_token;

  const missing = run(workspace, 'workflow.mjs', 'complete', {
    execution_token: originalToken,
    criterion_results: []
  }, 1);
  assert.equal(missing.error.code, 'EVIDENCE_REQUIRED');
  assert.deepEqual(missing.error.missing, ['done']);

  const evidenceId = requestEvidence(workspace);
  const recovered = run(workspace, 'recover.mjs', null, {
    message: 'skill-continue-or-finalize'
  });
  assert.notEqual(recovered.directive.execution_token, originalToken);

  const stale = run(workspace, 'workflow.mjs', 'complete', {
    execution_token: originalToken,
    criterion_results: [{ criterion_id: 'done', evidence_ids: [evidenceId] }]
  }, 1);
  assert.equal(stale.error.code, 'INVALID_TOKEN');

  const completed = run(workspace, 'workflow.mjs', 'complete', {
    execution_token: recovered.directive.execution_token,
    criterion_results: [{ criterion_id: 'done', evidence_ids: [evidenceId] }]
  });
  assert.equal(completed.directive.state, 'CHECK');
});

test('knowledge items require reconciliation and validated knowledge for cascade invalidation', t => {
  const workspace = temporaryWorkspace(t);
  start(workspace);
  const planned = run(workspace, 'workflow.mjs', 'plan', {
    ...simplePlan(),
    items: [
      {
        id: 'research',
        kind: 'knowledge',
        objective: 'Discover the route.',
        depends_on: [],
        acceptance: [{ id: 'found', text: 'A route is found.', evidence_types: ['request'] }]
      },
      {
        id: 'build',
        kind: 'execution',
        objective: 'Use the discovered route.',
        depends_on: ['research'],
        acceptance: [{ id: 'built', text: 'The route is used.', evidence_types: ['request'] }]
      }
    ],
    fog: [{ id: 'unknown-api', question: 'Which API is required?' }]
  });
  const evidenceId = requestEvidence(workspace, 'research');
  const completed = run(workspace, 'workflow.mjs', 'complete', {
    execution_token: planned.directive.execution_token,
    criterion_results: [{ criterion_id: 'found', evidence_ids: [evidenceId] }]
  });
  assert.equal(completed.directive.state, 'RECONCILE');

  const unreasonable = run(workspace, 'workflow.mjs', 'reconcile', {
    reconcile_token: completed.directive.reconcile_token,
    decision: 'expand',
    reason_code: 'context_limit',
    items: [{
      id: 'shortcut',
      kind: 'execution',
      objective: 'Skip work.',
      depends_on: [],
      acceptance: [{ id: 'skipped', text: 'Work was skipped.', evidence_types: ['request'] }]
    }]
  }, 1);
  assert.equal(unreasonable.error.code, 'INVALID_REPLAN_REASON');

  const observed = run(workspace, 'observe.mjs', 'capture', {
    statement: 'The original route is probably wrong.',
    confidence: 'high_confidence',
    source_refs: ['tool:search'],
    workflow_item_id: 'research'
  });
  const observationId = observed.directive.observation.id;
  const rejected = run(workspace, 'workflow.mjs', 'reconcile', {
    reconcile_token: completed.directive.reconcile_token,
    decision: 'supersede',
    reason_code: 'high_confidence_observation',
    observation_ids: [observationId],
    supersedes: ['research'],
    fog_changes: { exclude: ['unknown-api'] }
  }, 1);
  assert.equal(rejected.error.code, 'INVALID_REPLAN_REASON');

  run(workspace, 'observe.mjs', 'validate', {
    id: observationId,
    evidence_ids: [evidenceId]
  });
  const reconciled = run(workspace, 'workflow.mjs', 'reconcile', {
    reconcile_token: completed.directive.reconcile_token,
    decision: 'supersede',
    reason_code: 'validated_observation',
    observation_ids: [observationId],
    supersedes: ['research'],
    fog_changes: { exclude: ['unknown-api'] }
  });
  assert.equal(reconciled.directive.state, 'EXECUTE');

  const workflow = JSON.parse(fs.readFileSync(
    path.join(workspace, '.chatgpt-workflow', 'runs', reconciled.directive.run_id, 'workflow.json'),
    'utf8'
  ));
  assert.equal(workflow.items.find(item => item.id === 'research').status, 'invalidated');
  assert.equal(workflow.items.find(item => item.id === 'build').status, 'superseded');
  assert.ok(workflow.items.some(item => item.replaces === 'research'));
  assert.ok(workflow.items.some(item => item.replaces === 'build'));
  assert.equal(workflow.fog.find(item => item.id === 'unknown-api').status, 'excluded');
});

test('prepared external effects block recovery and completion until verified', t => {
  const workspace = temporaryWorkspace(t);
  start(workspace);
  const planned = run(workspace, 'workflow.mjs', 'plan', simplePlan());
  const token = planned.directive.execution_token;
  run(workspace, 'workflow.mjs', 'effect_prepare', {
    execution_token: token,
    operation_id: 'send-1',
    idempotency_key: 'task-send-1',
    target: 'external-service'
  });

  const recovered = run(workspace, 'recover.mjs', null, {
    message: 'skill-continue-or-finalize'
  });
  assert.deepEqual(recovered.directive.allowed_next_calls, ['evidence.record', 'workflow.effect_complete']);

  const blocked = run(workspace, 'workflow.mjs', 'complete', {
    execution_token: token,
    criterion_results: []
  }, 1);
  assert.equal(blocked.error.code, 'PENDING_EFFECT');

  const evidenceId = requestEvidence(workspace);
  run(workspace, 'workflow.mjs', 'effect_complete', {
    operation_id: 'send-1',
    evidence_id: evidenceId
  });
  const completed = run(workspace, 'workflow.mjs', 'complete', {
    execution_token: token,
    criterion_results: [{ criterion_id: 'done', evidence_ids: [evidenceId] }]
  });
  assert.equal(completed.directive.state, 'CHECK');
});

test('continue trigger with remaining text creates a request revision', t => {
  const workspace = temporaryWorkspace(t);
  start(workspace);
  run(workspace, 'workflow.mjs', 'plan', simplePlan());
  const recovered = run(workspace, 'recover.mjs', null, {
    message: 'skill-continue-or-finalize add a new required output'
  });
  assert.equal(recovered.directive.state, 'PLAN_ONLY');
  assert.equal(recovered.directive.request_revision, 2);
  const request = fs.readFileSync(
    path.join(workspace, '.chatgpt-workflow', 'runs', recovered.directive.run_id, 'requests', '0002.md'),
    'utf8'
  );
  assert.equal(request.trim(), 'add a new required output');
});

test('legacy state fails closed', t => {
  const workspace = temporaryWorkspace(t);
  const state = path.join(workspace, '.chatgpt-workflow');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'active.json'), JSON.stringify({ version: 1, run_id: 'legacy' }));
  const result = run(workspace, 'recover.mjs', null, {
    message: 'skill-continue-or-finalize'
  }, 1);
  assert.equal(result.error.code, 'LEGACY_STATE_UNVERIFIABLE');
});

test('invalidated evidence cannot be restored by ordinary verification', t => {
  const workspace = temporaryWorkspace(t);
  start(workspace);
  const planned = run(workspace, 'workflow.mjs', 'plan', simplePlan());
  const evidenceId = requestEvidence(workspace);
  run(workspace, 'evidence.mjs', 'invalidate', { id: evidenceId, reason: 'source withdrawn' });
  const verified = run(workspace, 'evidence.mjs', 'verify', { id: evidenceId }, 1);
  assert.equal(verified.error.code, 'EVIDENCE_INVALID');
  const completed = run(workspace, 'workflow.mjs', 'complete', {
    execution_token: planned.directive.execution_token,
    criterion_results: [{ criterion_id: 'done', evidence_ids: [evidenceId] }]
  }, 1);
  assert.equal(completed.error.code, 'EVIDENCE_REQUIRED');
});
