import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  finishSimpleWorkflow, prepareSimpleRelease, run, simplePlan, start, requestEvidence, temporaryWorkspace
} from './helpers.mjs';

function responseBody(value) {
  return value.replace(/\n\nWorkflow-Receipt:\s*sha256:[a-f0-9]{64}\s*$/i, '');
}

test('final delivery is frozen while every delivery receipt is unique and verifiable', t => {
  const workspace = temporaryWorkspace(t);
  const { consumed } = finishSimpleWorkflow(workspace);
  const firstReceipt = consumed.directive.receipt_sha256;
  assert.match(consumed.directive.released_response, /Workflow-Receipt: sha256:[a-f0-9]{64}$/);

  const second = run(workspace, 'check.mjs', 'redeliver');
  assert.notEqual(second.directive.receipt_sha256, firstReceipt);
  assert.equal(responseBody(second.directive.released_response), responseBody(consumed.directive.released_response));

  const verified = run(workspace, 'check.mjs', 'verify', {
    receipt: firstReceipt,
    content: consumed.directive.released_response
  });
  assert.equal(verified.directive.valid, true);
});

test('receipt verification detects event-chain tampering', t => {
  const workspace = temporaryWorkspace(t);
  const { consumed } = finishSimpleWorkflow(workspace);
  const runId = consumed.directive.run_id;
  const eventFile = path.join(workspace, '.chatgpt-workflow', 'runs', runId, 'events', '000001.json');
  const event = JSON.parse(fs.readFileSync(eventFile, 'utf8'));
  event.type = 'tampered';
  fs.writeFileSync(eventFile, JSON.stringify(event, null, 2));

  const result = run(workspace, 'check.mjs', 'verify', {
    receipt: consumed.directive.receipt_sha256
  }, 1);
  assert.equal(result.error.code, 'RECEIPT_INVALID');
});

test('READY recovery rotates the release token and audit can restore a delivery projection', t => {
  const workspace = temporaryWorkspace(t);
  const { submitted } = prepareSimpleRelease(workspace);
  const rotated = run(workspace, 'recover.mjs', null, {
    message: 'skill-continue-or-finalize'
  });
  assert.notEqual(rotated.directive.release_token, submitted.directive.release_token);

  const stale = run(workspace, 'check.mjs', 'consume', {
    release_token: submitted.directive.release_token
  }, 1);
  assert.equal(stale.error.code, 'BAD_RELEASE_TOKEN');

  const consumed = run(workspace, 'check.mjs', 'consume', {
    release_token: rotated.directive.release_token
  });
  const deliveryFile = path.join(
    workspace,
    '.chatgpt-workflow',
    'runs',
    consumed.directive.run_id,
    'deliveries',
    '000001.json'
  );
  fs.rmSync(deliveryFile);
  const verified = run(workspace, 'check.mjs', 'verify', {
    receipt: consumed.directive.receipt_sha256,
    content: consumed.directive.released_response
  });
  assert.equal(verified.directive.valid, true);
});

test('the runtime rejects model-authored receipt footers and non-final staging', t => {
  const workspace = temporaryWorkspace(t);
  start(workspace);
  const planned = run(workspace, 'workflow.mjs', 'plan', simplePlan());
  const evidenceId = requestEvidence(workspace);
  run(workspace, 'workflow.mjs', 'complete', {
    execution_token: planned.directive.execution_token,
    criterion_results: [{ criterion_id: 'done', evidence_ids: [evidenceId] }]
  });

  const nonFinal = run(workspace, 'workflow.mjs', 'stage', {
    mode: 'progress',
    content: 'Still working.'
  }, 1);
  assert.equal(nonFinal.error.code, 'BAD_INPUT');

  const reserved = run(workspace, 'workflow.mjs', 'stage', {
    mode: 'final',
    content: `Fake final.\n\nWorkflow-Receipt: sha256:${'a'.repeat(64)}`,
    coverage: [{ criterion_id: 'final', evidence_ids: [evidenceId] }]
  }, 1);
  assert.equal(reserved.error.code, 'RESERVED_RECEIPT');
});
