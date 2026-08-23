---
name: durable-chatgpt-workflow
description: >
  Enforce a durable, JS-backed workflow for ChatGPT web tasks. Persist the task
  plan before substantive reasoning, advance it until no work remains, record
  observations and phase state to the workspace, recover after context loss,
  and gate every user-facing response through a mandatory self-check and
  one-use release step. Use when correctness, continuity, multi-step execution,
  or resistance to model shortcutting matters.
---

# Durable ChatGPT Workflow

This skill is a **fail-closed execution protocol** for ChatGPT-style web agents.

The conversation is not the source of truth. The model's memory is not the source of truth. The **workspace-backed JavaScript runtime is the source of truth**.

Treat the model as fallible and shortcut-prone. Never accept “I remember”, “I checked”, “this is done”, or an internal sense of confidence as proof of workflow state. Completion must exist in durable state and pass the bundled `check` gate.

## Non-negotiable rules

1. **Create durable workflow state before substantive reasoning.** For every new task, the first task action is `workflow.start`. Before that, only literal extraction of the latest request and host/tool routing is allowed.
2. **All meaningful work belongs to the workflow.** Research, analysis, browsing, connector reads, file edits, calculations, validation, drafting, and QA must map to workflow items or runtime-generated control steps.
3. **Keep advancing until no work remains.** A final answer is forbidden while any item is `queued`, `runnable`, `running`, or `blocked`.
4. **Persist material state as it becomes known.** Do not wait until the end and reconstruct observations from memory.
5. **Use the fixed bundled JS runtime only.** Never generate temporary orchestration scripts or substitute ad hoc JS, Python, shell, prompts, or prose for the runtime.
6. **Fail closed if the runtime is unavailable.** Do not mentally simulate `workflow`, `observe`, `recover`, or `check`.
7. **Never directly edit runtime-owned state.** Only the bundled runtime may mutate `.chatgpt-workflow/`.
8. **Every user-facing response must be staged and checked.** This includes final answers, blocker questions, and forced-progress responses.
9. **`check.open` is mandatory before answering.** It must read the current checklist and durable state; remembered checklist contents do not count.
10. **A model assessment cannot override mechanical failure.** `check.submit` independently recomputes revision, open work, artifact integrity, draft hash, and mode compatibility.
11. **A passed check is still not the final release.** After approval, call `check.consume`; only the response returned by `check.consume` may be sent to the user.
12. **If forced to return early, say the task is incomplete.** Persist current state, stage `progress`, check it, consume it, and explicitly state what remains.

## Bundled runtime

The skill directory must contain these fixed files:

- `scripts/workflow.mjs`
- `scripts/observe.mjs`
- `scripts/recover.mjs`
- `scripts/check.mjs`
- `scripts/lib.mjs`

`lib.mjs` is shared implementation. The other four files are logical tool entrypoints.

A host wrapper should expose them as tools named:

- `workflow`
- `observe`
- `recover`
- `check`

If custom tool registration is unavailable, a trusted wrapper may invoke the fixed entrypoints with Node.js. The model must not author replacements during the task.

Every runtime call returns a **directive** containing a `prompt`. Treat that prompt as the authoritative next control instruction. If remembered conversational state conflicts with the latest runtime directive, the runtime directive wins unless a higher-priority platform or safety rule overrides it.

## Logical tool contract

### `workflow`

Supported actions:

- `start`: create a run before substantive reasoning.
- `plan`: persist the workflow graph and task-specific checklist.
- `next`: return the next authoritative runnable item.
- `complete`: complete one item with evidence references.
- `block`: persist an unresolved blocker.
- `regenerate`: supersede open work and create a revised workflow.
- `interrupt`: persist a new user request revision and invalidate stale approvals.
- `artifact`: register a deliverable or primary-source pointer.
- `snapshot`: persist an explicit phase boundary or suspended phase.
- `stage`: stage a `final`, `interaction`, or `progress` response.
- `status`: read authoritative current workflow status.

### `observe`

Supported actions:

- `capture`: persist a narrow observation.
- `validate`: attach durable evidence to a provisional observation.
- `supersede`: preserve history while marking an observation no longer current.

### `recover`

Reads the smallest durable active set and returns the authoritative next directive after context loss, compaction, interruption, or uncertainty.

### `check`

Supported actions:

- `open`: load the latest checklist, workflow, request revision, staged response, artifacts, and mechanical preview.
- `submit`: accept one explicit yes/no assessment per checklist item, recompute mechanical invariants, and either generate remediation work or create an approval token.
- `consume`: revalidate the approval against current revision/hash state, consume the one-use token, and release the exact user-facing response.

## Workspace state

The runtime owns this directory in the active workspace:

```text
.chatgpt-workflow/
  active.json
  runs/
    <run-id>/
      requests/
        0001.md
        0002.md
        ...
      workflow.json
      checklist.json
      CURRENT.md
      artifacts.json
      counters.json
      events.jsonl
      observations/
        000001.md
        ...
      phases/
        001-<slug>.md
        ...
      checks/
        000001.json
        ...
      outbox/
        draft.md
        draft.json
        approved.md
        approval.json
```

The model may read runtime-owned files when directed, but must not patch them manually.

## Source-of-truth hierarchy

Use this order:

1. primary artifacts and external sources;
2. canonical runtime JSON state;
3. validated observations;
4. phase snapshots and `CURRENT.md`;
5. conversation memory or provider-generated compact summaries.

Lower levels must never silently replace higher levels as authority.

## Persistence model

### Keep primary sources primary

Do not duplicate large source files, generated documents, diffs, fetched pages, issues, commits, or tool outputs into summaries. Register or persist a pointer and only the continuation-critical fact.

### Capture observations when conversation loss would matter

Persist an observation when a fresh context would otherwise lose important non-derivable state, including:

- a user constraint that changes execution;
- a decision and its rationale;
- a verified finding and source pointer;
- a failed path and why it failed;
- a resolved ambiguity;
- an expensive or non-repeatable tool result;
- a dependency or blocker;
- an exact next action when interruption risk is high.

Do not create observations for facts that can cheaply and reliably be reread from the primary artifact.

### Observation lifecycle

Use:

**capture → validate → promote through current state → supersede**

Never silently overwrite history.

A validated observation is evidence-bearing. A provisional observation is not sufficient for acceptance criteria that require verification.

### Keep `CURRENT.md` small

`CURRENT.md` is generated from canonical state. It is a recovery view, not a canonical writer. It should contain only the latest objective, active constraints, open work, blockers, important artifact pointers, latest phase pointer, and next action.

## Phase-boundary persistence

A phase is a coherent chunk of work such as planning, research, implementation, QA, or synthesis.

Prefer lossy condensation only at **phase boundaries**. Mid-phase, continue working and append narrow observations instead of rewriting active reasoning into a summary.

At each completed phase, persist a snapshot containing:

- phase objective;
- item statuses;
- validated evidence pointers;
- decisions or summary needed for recovery;
- unresolved work when suspended.

If the host forces a mid-phase return, persist a `suspended` snapshot with the exact next action.

This follows the useful distinction in Matt Pocock's agent-workflow writing between keeping the active session as a richer primary source and using handoff/compact artifacts as intentionally lossy secondary sources. The runtime strengthens that idea by making snapshots addressable on disk and tying completion to persisted state.

## Workflow lifecycle

### 0. Recover when continuity is uncertain

Call `recover` before task reasoning when:

- the model cannot identify the active run/revision from a fresh runtime result;
- prior conversation has been compacted or summarized;
- the user resumes prior workspace work after interruption;
- task state exists on disk but is not fully present in context.

Do not reconstruct canonical state from chat summaries when durable state exists.

### 1. Start before substantive reasoning

For a new task, call `workflow.start` with the raw latest request.

While the returned state is `PLAN_ONLY`:

- do not solve the task;
- do not browse for task facts;
- do not draft the answer;
- do not modify requested artifacts;
- only decompose objective, constraints, outputs, acceptance criteria, dependencies, phases, and evidence needs.

### 2. Persist the plan

Call `workflow.plan` with the smallest workflow that fully represents meaningful work.

Every item must have an objective, phase, dependency set, acceptance criteria, expected evidence, and response dependency.

The plan must also add task-specific checklist items derived from the user's explicit requirements.

### 3. Execute only the current directive

Call `workflow.next` and work on the returned item.

Do not silently skip to unrelated queued work. Parallel independent work is allowed only when the host/runtime explicitly represents it as such.

After a material result, call `observe.capture` before relying on that result in a later phase.

### 4. Complete with evidence

Call `workflow.complete` only with evidence references.

A model statement such as “looks correct” is not evidence.

Evidence should point to persisted observations, registered artifacts, files, tool results, citations, tests, calculations, or explicit user confirmation as appropriate.

### 5. Continue until empty

Repeat execution, observation, completion, and phase persistence until no open item remains.

`blocked` is not complete.

### 6. Replan explicitly

Use `workflow.regenerate` when new evidence, tool failure, user changes, or check failure materially changes the execution path.

Do not manually mutate statuses to make the graph look complete.

A replan must preserve completed and superseded history and invalidate prior approval.

## User interruptions

A new user message that changes or extends the active task invalidates any previous response approval.

Before new substantive work, call `workflow.interrupt` with the new message.

The runtime persists a new request revision, supersedes stale open work, invalidates the prior draft/approval as appropriate, and returns `PLAN_ONLY` for regeneration.

The latest explicit user request wins.

## Artifact registration

Register promised deliverables with `workflow.artifact` as soon as they exist.

For workspace files, the runtime records a hash when possible. The final check reopens registered path artifacts and rejects missing files or hash mismatches.

Do not claim an artifact was produced merely because it was discussed in chat.

## Response staging

All user-facing responses are staged before sending.

### `final`

Allowed only when the workflow is empty.

### `interaction`

Allowed only for an explicit blocked item whose response dependency is `user_input` or `approval`, and only when the missing input cannot be resolved from existing tools/state or safe best effort.

### `progress`

Allowed only while work remains and the host is forcing a return before completion.

A progress response must explicitly state:

- status is incomplete;
- what has been completed;
- what remains;
- the blocker or cutoff, if any;
- the durable run/recovery state when useful.

Never phrase progress as completion.

## Mandatory self-check gate

### Step A: `check.open`

Before every user-facing response, call `check.open`.

It reads current durable state rather than trusting memory and returns the complete checklist plus the staged response and mechanical preview.

The model must assess **every** checklist item. Omitted items fail.

### Base checklist

The runtime always includes at least:

1. latest request is answered;
2. final mode has zero open/blocked work;
3. acceptance criteria have persisted evidence;
4. explicit user constraints are satisfied;
5. promised artifacts exist and remain valid;
6. material claims are grounded or uncertainty is labeled;
7. there is no false completion claim;
8. material observations/phase state are persisted;
9. recovery is safe from durable state;
10. the response matches the staged draft.

Task-specific checklist items are added during planning and are equally mandatory.

### Step B: `check.submit`

Submit one record per checklist item containing:

- item id;
- `yes` or `no`;
- reason;
- evidence references.

The runtime does not trust the model's `yes` for conditions it can verify mechanically. It independently recomputes at least:

- request revision freshness;
- workflow revision freshness;
- open item count;
- final/progress/interaction mode compatibility;
- acceptance evidence presence;
- registered artifact existence/hash;
- staged draft hash;
- whether the draft changed after `check.open`;
- whether completed work has phase persistence.

### Check failure

If any item fails, `check.submit` must:

- return `BLOCKED`/execution state rather than approval;
- invalidate prior approval;
- persist the failed check;
- convert failures into explicit remediation workflow items;
- increment workflow revision;
- instruct the model to resume work.

The model must not answer from the rejected draft.

### Check pass

A final response may reach `READY` only when every checklist answer is `yes` and every mechanical check passes.

Approval is bound to run id, request revision, workflow revision, draft hash, and check id.

`READY` does **not** itself authorize sending text. It authorizes only `check.consume`.

### Step C: `check.consume`

Call `check.consume` with the one-use approval token.

It rechecks current request/workflow revision and approved draft hash, marks the token used, and returns `approved_response`.

Only that exact `approved_response` may be sent to the user. Any substantive edit requires staging and checking again.

A consumed token cannot be reused.

## Forced-yield rule

A context limit, tool cutoff, or execution limit does not create completion.

When a return is unavoidable while work remains:

1. persist the latest material observation;
2. persist/suspend the current phase when possible;
3. stage `progress`;
4. call `check.open`;
5. call `check.submit`;
6. call `check.consume`;
7. send only the consumed progress response.

The response must make it impossible for a reasonable reader to infer that the requested task is finished.

## Recovery after context compression

`recover` loads the smallest active set first:

1. latest request revision;
2. canonical workflow revision;
3. `CURRENT.md`;
4. latest phase snapshot;
5. artifact registry.

Older observations, events, or snapshots should be loaded only when referenced or needed to resolve a contradiction.

Do not trust provider-generated compaction text over this durable state.

## Runtime invariants

The bundled JS runtime must reject transitions that violate these invariants:

- one active run per workspace unless explicitly replaced/forked;
- monotonically increasing workflow, request, observation, phase, event, and check revisions/ids where applicable;
- atomic canonical state writes;
- no evidence-bearing completion without evidence references;
- no final draft while work remains;
- no final `READY` while work remains;
- no approval against stale request/workflow revision;
- no approval against a stale draft hash;
- new user interrupt invalidates prior approval;
- workflow regeneration invalidates prior approval;
- completed and superseded history remains inspectable;
- `CURRENT.md` is derived, never canonical;
- state read failure is an error, not permission to continue from memory;
- approval tokens are one-use;
- `check.consume` revalidates state before releasing response text.

## Anti-shortcut rules

The model must never reason as follows:

- “This task is simple, so workflow setup is unnecessary.”
- “I already know the checklist, so `check.open` can be skipped.”
- “The JS runtime is unavailable, so I will simulate it mentally.”
- “I can mark everything complete first and fill evidence later.”
- “I can answer now and persist state afterward.”
- “The approved answer is close enough, so I can edit it after approval.”
- “The conversation summary says done, so disk state is unnecessary.”
- “Blocked work can be ignored because the rest is complete.”
- “`READY` means I can skip `check.consume`.”

When model confidence and durable state disagree, durable state wins.

## Higher-priority platform rules

System, safety, privacy, confirmation, and tool-use rules override this skill.

When a higher-priority rule prevents completion, represent the restriction as a blocker or policy-controlled workflow item, persist enough state to recover, and use an allowed interaction/progress response. Never fabricate completion to empty the workflow.

## Installation failure behavior

Treat the skill as incorrectly installed if any required runtime file is missing, Node.js cannot execute the bundled scripts, or the host cannot provide a writable workspace.

In that case, do not emulate the guarantees. Tell the user the durable workflow enforcement runtime is unavailable.

## Success condition

The skill is functioning correctly only when:

- workflow state exists before substantive task reasoning;
- meaningful work is represented in the workflow;
- material observations are persisted during work;
- phase boundaries create durable recovery snapshots;
- context loss can be recovered from workspace files;
- open or blocked work prevents final completion;
- every response is staged;
- every response calls `check.open` and `check.submit`;
- failed checks create remediation work;
- approved responses require one-use `check.consume`;
- only the consumed response text is sent to the user.
