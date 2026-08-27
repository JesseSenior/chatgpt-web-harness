import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { permissionDigest, readEvents } from '../scripts/audit.mjs';
import {
  finishSimpleWorkflow, prepareSimpleRelease, run, simplePlan, start, temporaryWorkspace
} from './helpers.mjs';

function statePaths(workspace, runId) {
  const root = path.join(workspace, '.chatgpt-workflow');
  return {
    active: path.join(root, 'active.json'),
    events: path.join(root, 'runs', runId, 'events')
  };
}

function readActive(workspace) {
  return JSON.parse(fs.readFileSync(path.join(workspace, '.chatgpt-workflow', 'active.json'), 'utf8'));
}

test('version 3 persists canonical permissions and denied calls have no side effects', t => {
  const workspace = temporaryWorkspace(t);
  const started = start(workspace);
  const paths = statePaths(workspace, started.directive.run_id);
  const activeBefore = fs.readFileSync(paths.active, 'utf8');
  const eventsBefore = fs.readdirSync(paths.events);
  const active = JSON.parse(activeBefore);

  assert.equal(active.version, 3);
  assert.equal(active.permission_revision, 1);
  assert.deepEqual(active.allowed_next_calls, ['workflow.plan']);
  assert.equal(active.permission_sha256, permissionDigest(1, ['workflow.plan']));
  const permission = readEvents(path.dirname(paths.events)).at(-1);
  assert.equal(permission.type, 'permissions_issued');
  assert.deepEqual(permission.payload.allowed_next_calls, ['workflow.plan']);

  const denied = run(workspace, 'observe.mjs', 'capture', {
    statement: 'This call is too early.'
  }, 1);
  assert.equal(denied.error.code, 'INVALID_TRANSITION');
  assert.deepEqual(denied.error.allowed_next_calls, ['workflow.plan']);
  assert.equal(fs.readFileSync(paths.active, 'utf8'), activeBefore);
  assert.deepEqual(fs.readdirSync(paths.events), eventsBefore);
});

test('repairable failures preserve the permission revision and event chain', t => {
  const workspace = temporaryWorkspace(t);
  const started = start(workspace);
  const paths = statePaths(workspace, started.directive.run_id);
  const activeBefore = fs.readFileSync(paths.active, 'utf8');
  const eventsBefore = fs.readdirSync(paths.events);

  const invalid = run(workspace, 'workflow.mjs', 'plan', {
    ...simplePlan(),
    items: [{ id: 'work', kind: 'execution', objective: 'Work.', depends_on: [], acceptance: [] }]
  }, 1);
  assert.equal(invalid.error.code, 'INVALID_PLAN');
  assert.deepEqual(invalid.error.allowed_next_calls, ['workflow.plan']);
  assert.equal(fs.readFileSync(paths.active, 'utf8'), activeBefore);
  assert.deepEqual(fs.readdirSync(paths.events), eventsBefore);

  const planned = run(workspace, 'workflow.mjs', 'plan', simplePlan());
  const activeAfterPlan = fs.readFileSync(paths.active, 'utf8');
  const eventsAfterPlan = fs.readdirSync(paths.events);
  const missing = run(workspace, 'workflow.mjs', 'complete', {
    execution_token: planned.directive.execution_token,
    criterion_results: []
  }, 1);
  assert.equal(missing.error.code, 'EVIDENCE_REQUIRED');
  assert.deepEqual(missing.error.allowed_next_calls, planned.directive.allowed_next_calls);
  assert.equal(fs.readFileSync(paths.active, 'utf8'), activeAfterPlan);
  assert.deepEqual(fs.readdirSync(paths.events), eventsAfterPlan);
});

test('recover requires permission or the continuation trigger and restores the full execution matrix', t => {
  const workspace = temporaryWorkspace(t);
  start(workspace);
  const planned = run(workspace, 'workflow.mjs', 'plan', simplePlan());
  const denied = run(workspace, 'recover.mjs', null, { message: 'continue' }, 1);
  assert.equal(denied.error.code, 'INVALID_TRANSITION');

  const recovered = run(workspace, 'recover.mjs', null, {
    message: 'skill-continue-or-finalize'
  });
  assert.notEqual(recovered.directive.execution_token, planned.directive.execution_token);
  assert.deepEqual(recovered.directive.allowed_next_calls, planned.directive.allowed_next_calls);
  assert.ok(recovered.directive.allowed_next_calls.includes('workflow.snapshot'));
});

test('pending effect permissions survive evidence recording and reject repeated completion', t => {
  const workspace = temporaryWorkspace(t);
  start(workspace);
  run(workspace, 'workflow.mjs', 'plan', simplePlan());
  const recovered = run(workspace, 'recover.mjs', null, {
    message: 'skill-continue-or-finalize'
  });
  run(workspace, 'workflow.mjs', 'effect_prepare', {
    execution_token: recovered.directive.execution_token,
    operation_id: 'send-1',
    idempotency_key: 'send-1',
    target: 'external-service'
  });
  const evidence = run(workspace, 'evidence.mjs', 'record', {
    type: 'request',
    request_revision: 1,
    workflow_item_id: 'work'
  });
  assert.ok(evidence.directive.allowed_next_calls.includes('workflow.effect_complete'));
  assert.ok(!evidence.directive.allowed_next_calls.includes('workflow.complete'));

  const completed = run(workspace, 'workflow.mjs', 'effect_complete', {
    operation_id: 'send-1',
    evidence_id: evidence.directive.evidence.id
  });
  assert.deepEqual(completed.directive.allowed_next_calls, ['workflow.complete']);
  const repeated = run(workspace, 'workflow.mjs', 'effect_complete', {
    operation_id: 'send-1',
    evidence_id: evidence.directive.evidence.id
  }, 1);
  assert.equal(repeated.error.code, 'INVALID_TRANSITION');
});

test('active permissions must match the last permission event', t => {
  const workspace = temporaryWorkspace(t);
  start(workspace);
  const activeFile = path.join(workspace, '.chatgpt-workflow', 'active.json');
  const active = JSON.parse(fs.readFileSync(activeFile, 'utf8'));
  active.allowed_next_calls = ['observe.capture', 'workflow.plan'];
  active.permission_sha256 = permissionDigest(active.permission_revision, active.allowed_next_calls);
  fs.writeFileSync(activeFile, `${JSON.stringify(active, null, 2)}\n`);

  const result = run(workspace, 'workflow.mjs', 'plan', simplePlan(), 1);
  assert.equal(result.error.code, 'RUNTIME_ERROR');
  assert.match(result.error.detail, /permission (hash|calls) mismatch/);
});

test('version 3 state without permission fields fails closed', t => {
  const workspace = temporaryWorkspace(t);
  const state = path.join(workspace, '.chatgpt-workflow');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'active.json'), JSON.stringify({ version: 3, run_id: 'missing-permission' }));

  const result = run(workspace, 'recover.mjs', null, {
    message: 'skill-continue-or-finalize'
  }, 1);
  assert.equal(result.error.code, 'LEGACY_STATE_UNVERIFIABLE');
});

test('major workflow states reject unadvertised actions', t => {
  const executionWorkspace = temporaryWorkspace(t);
  start(executionWorkspace);
  const planned = run(executionWorkspace, 'workflow.mjs', 'plan', simplePlan());
  assert.equal(run(executionWorkspace, 'check.mjs', 'open', {}, 1).error.code, 'INVALID_TRANSITION');
  const evidence = run(executionWorkspace, 'evidence.mjs', 'record', {
    type: 'request',
    request_revision: 1,
    workflow_item_id: 'work'
  });
  run(executionWorkspace, 'workflow.mjs', 'complete', {
    execution_token: planned.directive.execution_token,
    criterion_results: [{ criterion_id: 'done', evidence_ids: [evidence.directive.evidence.id] }]
  });
  assert.equal(
    run(executionWorkspace, 'observe.mjs', 'capture', { statement: 'Too late.' }, 1).error.code,
    'INVALID_TRANSITION'
  );

  const readyWorkspace = temporaryWorkspace(t);
  prepareSimpleRelease(readyWorkspace);
  assert.equal(
    run(readyWorkspace, 'workflow.mjs', 'stage', { mode: 'final', content: 'Again.' }, 1).error.code,
    'INVALID_TRANSITION'
  );

  const consumedWorkspace = temporaryWorkspace(t);
  finishSimpleWorkflow(consumedWorkspace);
  assert.equal(
    run(consumedWorkspace, 'workflow.mjs', 'status', {}, 1).error.code,
    'INVALID_TRANSITION'
  );
});
