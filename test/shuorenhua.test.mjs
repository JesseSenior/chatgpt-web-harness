import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SHUORENHUA_SOURCE, auditShuorenhua
} from '../scripts/shuorenhua.mjs';
import {
  prepareSimpleRelease, requestEvidence, run, simplePlan, start, temporaryWorkspace
} from './helpers.mjs';

function completeSimpleWork(workspace) {
  start(workspace);
  const planned = run(workspace, 'workflow.mjs', 'plan', simplePlan());
  const evidenceId = requestEvidence(workspace);
  run(workspace, 'workflow.mjs', 'complete', {
    execution_token: planned.directive.execution_token,
    criterion_results: [{ criterion_id: 'done', evidence_ids: [evidenceId] }]
  });
  return { evidenceId, runId: planned.directive.run_id };
}

function stage(workspace, evidenceId, content, expectedStatus = 0) {
  return run(workspace, 'workflow.mjs', 'stage', {
    mode: 'final',
    content,
    coverage: [{ criterion_id: 'final', evidence_ids: [evidenceId] }]
  }, expectedStatus);
}

test('the offline CLI accepts direct Chinese and English final copy', t => {
  const workspace = temporaryWorkspace(t);
  const chinese = run(workspace, 'shuorenhua.mjs', 'audit', {
    content: '已更新 README，并运行了 16 项测试。所有测试通过。'
  });
  const english = run(workspace, 'shuorenhua.mjs', 'audit', {
    content: 'Updated the README and ran 16 tests. All tests passed.'
  });

  assert.equal(chinese.audit.pass, true);
  assert.equal(english.audit.pass, true);
  assert.equal(chinese.audit.source_commit, SHUORENHUA_SOURCE.commit);
  assert.match(chinese.audit.audit_sha256, /^[a-f0-9]{64}$/);
  assert.ok(chinese.audit.semantic_checks.length >= 7);
});

test('one audit returns every deterministic violation without rewriting content', t => {
  const workspace = temporaryWorkspace(t);
  const content = '好问题！值得注意的是，这项方案赋能团队。研究表明它具有重要意义。综上所述，未来可期。';
  const result = run(workspace, 'shuorenhua.mjs', 'audit', { content }, 1);
  const ids = new Set(result.error.violations.map(item => item.rule_id));

  assert.equal(result.error.code, 'SHUORENHUA_FAILED');
  assert.deepEqual(ids, new Set([
    'zh-sycophancy',
    'zh-opening-boilerplate',
    'zh-business-jargon',
    'zh-unsourced-authority',
    'zh-inflated-significance',
    'zh-summary-template',
    'zh-self-media-template'
  ]));
  assert.ok(result.error.violations.every(item => item.line === 1 && item.column > 0 && item.action));
  assert.ok(result.error.violations.every(item => item.excerpt === content));
  assert.equal('rewritten_content' in result.error, false);
});

test('protected code, quotations, URLs, paths, commands, logs, and errors are not audited as prose', () => {
  const content = [
    '> 好问题！研究表明。',
    '',
    'The literal phrase “Great question” is part of the quoted source.',
    '',
    '`综上所述` and `studies show` are identifiers in this example.',
    '',
    'https://example.com/值得注意的是',
    '/tmp/综上所述/output.txt',
    'node scripts/tool.mjs --label=研究表明',
    'ERROR: Great question',
    '',
    '```text',
    '未来可期。',
    '```'
  ].join('\n');

  assert.equal(auditShuorenhua(content).pass, true);
});

test('density and structural thresholds fail closed', () => {
  const tierTwo = auditShuorenhua('此外，任务继续。然而，结果还没有验证。');
  const tierThree = auditShuorenhua('The robust tool produced a robust result with a robust interface.');
  const contrast = auditShuorenhua('这不是速度问题，而是容量问题。这不是代码问题，而是配置问题。');

  assert.ok(tierTwo.violations.some(item => item.rule_id === 'tier-2-density'));
  assert.ok(tierThree.violations.some(item => item.rule_id === 'tier-3-density'));
  assert.ok(contrast.violations.some(item => item.rule_id === 'binary-contrast-density'));
});

test('scope changes at 1000 language units', () => {
  assert.equal(auditShuorenhua('字'.repeat(999)).scope, 'structural');
  assert.equal(auditShuorenhua('字'.repeat(1000)).scope, 'bounded');
});

test('failed stage returns every writing violation and preserves its permission', t => {
  const workspace = temporaryWorkspace(t);
  const { evidenceId, runId } = completeSimpleWork(workspace);

  const failed = stage(workspace, evidenceId, 'Great question! Studies show this is a game-changer.', 1);
  const outbox = path.join(workspace, '.chatgpt-workflow', 'runs', runId, 'outbox');

  assert.equal(failed.error.code, 'SHUORENHUA_FAILED');
  assert.equal(failed.error.state, 'CHECK');
  assert.deepEqual(failed.error.allowed_next_calls, ['workflow.stage']);
  assert.ok(failed.error.violations.length >= 3);
  assert.equal(fs.existsSync(path.join(outbox, 'draft.md')), false);
  assert.equal(fs.existsSync(path.join(outbox, 'draft.json')), false);
});

test('check re-audits the frozen draft and reports post-stage replacement', t => {
  const workspace = temporaryWorkspace(t);
  const { evidenceId, runId } = completeSimpleWork(workspace);
  stage(workspace, evidenceId, 'Task completed.');
  const outbox = path.join(workspace, '.chatgpt-workflow', 'runs', runId, 'outbox');
  const bodyFile = path.join(outbox, 'draft.md');
  const metaFile = path.join(outbox, 'draft.json');
  const tamperedBody = 'Great question! This is a game-changer.';
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  meta.body_sha256 = crypto.createHash('sha256').update(tamperedBody).digest('hex');
  fs.writeFileSync(bodyFile, tamperedBody);
  fs.writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);

  const result = run(workspace, 'check.mjs', 'open', {}, 1);
  assert.equal(result.error.code, 'CHECK_FAILED');
  assert.deepEqual(result.error.allowed_next_calls, ['workflow.next']);
  assert.deepEqual(JSON.parse(fs.readFileSync(
    path.join(workspace, '.chatgpt-workflow', 'active.json'),
    'utf8'
  )).allowed_next_calls, ['workflow.next']);
  assert.ok(result.error.missing.some(value => value.startsWith('shuorenhua:')));
  assert.ok(result.error.violations.some(value => value.rule_id === 'en-sycophancy'));
  assert.ok(result.error.violations.some(value => value.rule_id === 'en-business-jargon'));
});

test('release requires the disclosed shuorenhua semantic check', t => {
  const workspace = temporaryWorkspace(t);
  const { evidenceId } = completeSimpleWork(workspace);
  stage(workspace, evidenceId, 'Task completed.');
  const opened = run(workspace, 'check.mjs', 'open');
  const style = opened.directive.checks.find(check => check.id === 'shuorenhua-style');

  assert.equal(style.source_commit, SHUORENHUA_SOURCE.commit);
  assert.match(style.audit_sha256, /^[a-f0-9]{64}$/);
  assert.ok(style.checklist.some(item => item.id === 'protected-spans'));

  const result = run(workspace, 'check.mjs', 'submit', {
    check_id: opened.directive.check_id,
    answers: [
      { id: 'destination-answer', answer: 'yes', evidence_ids: [evidenceId] },
      { id: 'user-constraints', answer: 'yes', evidence_ids: [evidenceId] },
      { id: 'grounded-claims', answer: 'yes', evidence_ids: [evidenceId] }
    ]
  }, 1);
  assert.equal(result.error.code, 'CHECK_FAILED');
  assert.ok(result.error.missing.includes('shuorenhua-style'));
});

test('consume rejects a release body and metadata replaced after check', t => {
  const workspace = temporaryWorkspace(t);
  const { submitted } = prepareSimpleRelease(workspace);
  const releaseDir = path.join(
    workspace,
    '.chatgpt-workflow',
    'runs',
    submitted.directive.run_id,
    'releases'
  );
  const bodyFile = path.join(releaseDir, '000001.md');
  const metaFile = path.join(releaseDir, '000001.json');
  const body = 'Great question! This is a game-changer.';
  const writingAudit = auditShuorenhua(body);
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  meta.body_sha256 = crypto.createHash('sha256').update(body).digest('hex');
  meta.shuorenhua_audit_sha256 = writingAudit.audit_sha256;
  fs.writeFileSync(bodyFile, body);
  fs.writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);

  const result = run(workspace, 'check.mjs', 'consume', {
    release_token: submitted.directive.release_token
  }, 1);
  assert.equal(result.error.code, 'RUNTIME_ERROR');
  assert.ok(result.error.missing.some(value => value.startsWith('shuorenhua:')));
  assert.ok(result.error.missing.includes('check_ready body'));
});
