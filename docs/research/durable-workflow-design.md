# Durable Workflow Design Research

## Question

How should a model-facing skill use progressive disclosure, durable execution,
mechanical evidence, and final-response receipts without relying on large prompt
documents or user approvals?

## Findings

### Progressive disclosure

The Agent Skills specification defines three loading levels: catalog metadata,
the selected `SKILL.md`, and resources loaded or executed only when needed.
Codex follows the same sequence. The practical consequence for this runtime is
that `SKILL.md` should contain only the instructions required on every run.
State-specific rules belong in deterministic scripts. Invalid calls should return
the specific missing field, current state, allowed next calls, and repair.

Moving the former protocol into several Markdown references would reduce the
initial load but retain duplicated behavioral sources. The runtime therefore uses
scripts and short error records as the third disclosure level. It does not expose
model-facing reference documents.

Sources:

- [Agent Skills specification](https://agentskills.io/specification)
- [Agent Skills best practices](https://agentskills.io/skill-creation/best-practices)
- [OpenAI Codex: Build skills](https://developers.openai.com/codex/build-skills)
- [OpenAI Codex customization](https://developers.openai.com/codex/customization/overview)

### Durable state and changing knowledge

Temporal records commands and events in workflow history so execution can recover
from persisted state. LangGraph persists graph-state checkpoints and resumes a
thread from those checkpoints. Both models separate durable state from transient
conversation context.

The local runtime applies that principle with a stable destination, an executable
frontier, and non-executable fog. Knowledge-producing items must reconcile their
findings before the next item is issued. High-confidence observations may alter
open work. Only validated knowledge may invalidate completed work or satisfy
final acceptance. Invalidated dependencies are preserved and replaced by explicit
re-evaluation work.

Sources:

- [Temporal workflow execution](https://docs.temporal.io/workflow-execution)
- [Temporal workflows](https://docs.temporal.io/workflows)
- [Temporal retry policies](https://docs.temporal.io/encyclopedia/retry-policies)
- [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)
- [LangGraph interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)

### Automatic enforcement

OpenAI distinguishes automatic guardrails from human approval. Guardrails validate
input, output, and tool behavior and can block execution. Human review pauses a
run for a person or policy. This runtime uses automatic validation and fail-closed
errors. It does not use approval as a response dependency.

Source:

- [OpenAI guardrails and approvals](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals)

### Receipt scope

SHA-256 detects whether bytes differ from the bytes represented by a stored
digest. It does not prove who produced those bytes or protect against an actor
that can rewrite the record and recompute every digest.

The runtime therefore describes its footer as a locally verifiable delivery
receipt. Verification recomputes the event chain, receipt material, release body,
revisions, and delivery event. Strong third-party provenance would require a
signature key or an external append-only log, which is outside this dependency-free
skill.

Sources:

- [Node.js crypto](https://nodejs.org/api/crypto.html)
- [NIST FIPS 180-4](https://csrc.nist.gov/pubs/fips/180-4/upd1/final)
- [NIST SHA-256 glossary](https://csrc.nist.gov/glossary/term/secure_hash_algorithm_256)
- [NIST SP 800-171 Rev. 3](https://csrc.nist.gov/pubs/sp/800/171/r3/final)

## Applied decisions

- Keep `SKILL.md` below 40 lines and do not create model-facing references.
- Reject invalid state transitions instead of explaining the entire protocol.
- Bind execution to one-use tokens and each acceptance criterion to verified
  evidence.
- Keep the destination stable while evidence may revise the route.
- Resume from durable state when a message contains
  `skill-continue-or-finalize`.
- Freeze one final body and generate a unique receipt for every delivery attempt.
