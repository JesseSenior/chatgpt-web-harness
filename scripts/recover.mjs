#!/usr/bin/env node
import path from 'node:path';
import { loadRun, loadWorkflow, readText, latestFile, loadArtifacts, openItems, nextRunnable, directive, emit, fail } from './lib.mjs';

try {
  const { active, dir } = loadRun();
  const wf = loadWorkflow(dir);
  const current = readText(path.join(dir,'CURRENT.md'), '(CURRENT.md missing)');
  const latestPhase = latestFile(path.join(dir,'phases'));
  const phaseText = latestPhase ? readText(latestPhase) : null;
  const artifacts = loadArtifacts(dir);
  const open = openItems(wf);
  const state = open.length ? (nextRunnable(wf) ? 'EXECUTE' : 'WAIT_USER') : 'CHECK';
  const prompt = open.length
    ? `Recover from durable state, not from conversation memory. Resume with ${nextRunnable(wf)?.id || 'the recorded blocker/dependency'}. Read primary artifacts by reference when needed; do not treat phase summaries as more authoritative than their sources.`
    : 'The workflow is empty. Recover the latest staged state, then stage/check a response if no approved response exists. Do not infer READY from memory.';
  emit(directive({ active, wf, state, next_item:nextRunnable(wf), allowed:['workflow.next','workflow.stage','check.open'], forbidden:['reconstructing state from chat summary alone','claiming completion without check READY'], prompt,
    extra:{ current_state:current, latest_phase_path:latestPhase, latest_phase:phaseText, artifacts:artifacts.artifacts || [], open_items:open } }));
} catch (e) {
  fail(e?.stack || String(e), e?.message === 'NO_ACTIVE_RUN' ? 'NO_ACTIVE_RUN' : 'RUNTIME_ERROR');
}
