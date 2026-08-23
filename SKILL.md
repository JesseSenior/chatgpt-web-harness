---
name: durable-chatgpt-workflow
description: Run a fixed durable workflow when explicitly requested; also resume an active run when a message contains skill-continue-or-finalize.
---

# Durable ChatGPT Workflow

Use the fixed scripts from this skill directory as the only workflow runtime.

For a new task, call `workflow.start` before task reasoning, then make only the calls returned in `allowed_next_calls`.

When a user message contains `skill-continue-or-finalize`, pass the entire message to `recover` before any other task action. The runtime treats remaining text as a request revision.

Treat runtime state, tokens, evidence results, and errors as authoritative. Apply only the repair named by an error.

Use `evidence` and `observe` for durable facts. Use normal host tools only while the current execution token is active.

The runtime owns `.chatgpt-workflow/`. Read it only when directed; mutate it only through the bundled scripts.

Only final responses use the release gate. Send exactly the `released_response` returned by `check.consume` or `check.redeliver`; it includes the script-generated receipt.

If any runtime file, Node.js, or writable workspace is unavailable, stop and report that the durable runtime is unavailable.
