import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

export const PROJECT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function temporaryWorkspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-workflow-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

export function run(workspace, script, action, input = {}, expectedStatus = 0) {
  const args = [path.join(PROJECT, 'scripts', script)];
  if (action) args.push(action);
  args.push(JSON.stringify(input));
  const result = spawnSync(process.execPath, args, { cwd: workspace, encoding: 'utf8' });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  assert.ok(result.stdout.trim(), `${script} produced no JSON output`);
  return JSON.parse(result.stdout);
}

export function start(workspace, request = 'Complete the durable task.') {
  return run(workspace, 'workflow.mjs', 'start', { request, workspace });
}

export function simplePlan(overrides = {}) {
  return {
    destination: {
      objective: 'Complete the durable task.',
      constraints: [],
      success_criteria: [{
        id: 'final',
        text: 'The final response completes the task.',
        evidence_types: ['request']
      }]
    },
    items: [{
      id: 'work',
      kind: 'execution',
      objective: 'Complete the task.',
      depends_on: [],
      acceptance: [{
        id: 'done',
        text: 'The task work is complete.',
        evidence_types: ['request']
      }]
    }],
    fog: [],
    ...overrides
  };
}

export function requestEvidence(workspace, itemId = 'work') {
  return run(workspace, 'evidence.mjs', 'record', {
    type: 'request',
    request_revision: 1,
    workflow_item_id: itemId
  }).directive.evidence.id;
}

export function prepareSimpleRelease(workspace) {
  start(workspace);
  const planned = run(workspace, 'workflow.mjs', 'plan', simplePlan());
  const evidenceId = requestEvidence(workspace);
  run(workspace, 'workflow.mjs', 'complete', {
    execution_token: planned.directive.execution_token,
    criterion_results: [{ criterion_id: 'done', evidence_ids: [evidenceId] }]
  });
  run(workspace, 'workflow.mjs', 'stage', {
    mode: 'final',
    content: 'Durable final response.',
    coverage: [{ criterion_id: 'final', evidence_ids: [evidenceId] }]
  });
  const opened = run(workspace, 'check.mjs', 'open');
  const submitted = run(workspace, 'check.mjs', 'submit', {
    check_id: opened.directive.check_id,
    answers: [
      { id: 'destination-answer', answer: 'yes', evidence_ids: [evidenceId] },
      { id: 'user-constraints', answer: 'yes', evidence_ids: [evidenceId] },
      { id: 'grounded-claims', answer: 'yes', evidence_ids: [evidenceId] }
    ]
  });
  return { evidenceId, submitted };
}

export function finishSimpleWorkflow(workspace) {
  const { evidenceId, submitted } = prepareSimpleRelease(workspace);
  const consumed = run(workspace, 'check.mjs', 'consume', {
    release_token: submitted.directive.release_token
  });
  return { evidenceId, consumed };
}
