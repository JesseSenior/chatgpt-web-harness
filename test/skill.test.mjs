import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROJECT } from './helpers.mjs';

test('SKILL.md stays short and routes continuation to the runtime', () => {
  const skill = fs.readFileSync(path.join(PROJECT, 'SKILL.md'), 'utf8');
  assert.ok(skill.split('\n').length <= 40);
  assert.match(skill, /^---\nname: durable-chatgpt-workflow\n/m);
  assert.match(skill, /skill-continue-or-finalize/);
  assert.doesNotMatch(skill, /references\//);
});

test('package exposes version 0.2 and the Node test command', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(PROJECT, 'package.json'), 'utf8'));
  assert.equal(packageJson.version, '0.2.0');
  assert.equal(packageJson.scripts.test, 'node --test');
});
