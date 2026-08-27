import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROJECT } from './helpers.mjs';

test('SKILL.md stays short and routes continuation to the runtime', () => {
  const skill = fs.readFileSync(path.join(PROJECT, 'SKILL.md'), 'utf8');
  assert.ok(skill.split('\n').length <= 40);
  assert.match(skill, /^---\nname: chatgpt-web-harness\n/m);
  assert.match(skill, /skill-continue-or-finalize/);
  assert.doesNotMatch(skill, /references\//);
});

test('package exposes version 0.3 and the Node test command', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(PROJECT, 'package.json'), 'utf8'));
  assert.equal(packageJson.version, '0.3.0');
  assert.equal(packageJson.scripts.test, 'node --test');
});

test('the bundled auditor records its pinned MIT source without network access', () => {
  const script = fs.readFileSync(path.join(PROJECT, 'scripts', 'shuorenhua.mjs'), 'utf8');
  const notices = fs.readFileSync(path.join(PROJECT, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.match(script, /1a97697fb2b1744ea7850a12cf23b9c0aa7200a1/);
  assert.doesNotMatch(script, /from 'node:https'|\bfetch\s*\(/);
  assert.match(notices, /Copyright \(c\) 2026 MrGeDiao/);
  assert.match(notices, /Permission is hereby granted/);
});
