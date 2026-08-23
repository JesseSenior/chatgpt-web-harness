# durable-chatgpt-workflow

A ChatGPT-web-oriented skill that treats a workspace-backed JavaScript runtime as the canonical task ledger.

## Contents

- `SKILL.md` — model-facing protocol and invariants.
- `scripts/workflow.mjs` — workflow lifecycle, artifacts, phase snapshots, response staging.
- `scripts/observe.mjs` — durable observations.
- `scripts/recover.mjs` — context-loss recovery.
- `scripts/check.mjs` — mandatory checklist, mechanical validation, remediation, one-use response release.
- `scripts/lib.mjs` — shared state/IO helpers.

The runtime uses only Node.js built-ins and writes task state under `.chatgpt-workflow/` in the current workspace.

## Integration

Expose the four entrypoints as logical host tools (`workflow`, `observe`, `recover`, `check`) or invoke the fixed scripts through a trusted wrapper. Do not let the model create replacement scripts during a task.

Each entrypoint accepts an action plus a JSON payload and returns a JSON directive whose `prompt` is the authoritative next control instruction.

## Requirement

Node.js 20+ is recommended.
