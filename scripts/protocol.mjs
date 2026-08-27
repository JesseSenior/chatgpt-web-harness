const REPAIRS = {
  BAD_USAGE: 'Use one allowed action and provide its JSON input.',
  BAD_INPUT: 'Provide the missing or invalid fields and retry the same action.',
  NOT_FOUND: 'Use an identifier that exists in the current durable run.',
  NO_ACTIVE_RUN: 'Start a durable run before task work.',
  LEGACY_STATE_UNVERIFIABLE: 'Start a version 2 run; legacy evidence cannot be trusted automatically.',
  INVALID_TRANSITION: 'Read the current state and use one allowed next call.',
  INVALID_PLAN: 'Correct only the reported plan fields and submit the plan again.',
  INVALID_TOKEN: 'Recover the run to obtain a fresh token for the current item.',
  TOKEN_ALREADY_USED: 'Recover the run instead of reusing a consumed token.',
  EVIDENCE_REQUIRED: 'Record and verify the listed evidence, then retry.',
  EVIDENCE_INVALID: 'Replace or re-verify the listed evidence before continuing.',
  RECONCILE_REQUIRED: 'Reconcile the completed knowledge item before requesting more work.',
  INVALID_REPLAN_REASON: 'Use a supported evidence-backed reason without reducing the destination.',
  PENDING_EFFECT: 'Verify the prepared external effect before retrying or completing the item.',
  WORKFLOW_NOT_EMPTY: 'Complete or invalidate every open item and resolve active fog first.',
  RESERVED_RECEIPT: 'Remove the reserved Workflow-Receipt footer; the runtime adds it during delivery.',
  SHUORENHUA_FAILED: 'Revise every reported writing violation, then retry the same final response action.',
  CHECK_FAILED: 'Complete the generated remediation work, then stage a new final response.',
  NO_FINAL_RELEASE: 'Complete the final check before requesting delivery.',
  BAD_RELEASE_TOKEN: 'Use the current release token returned by the successful check.',
  RECEIPT_INVALID: 'Use a recorded receipt and unchanged final response content.',
  RUNTIME_ERROR: 'Stop and repair the runtime; do not simulate its result.'
};

export function success({ active, wf, allowed = [], nextItem = null, extra = {} }) {
  return {
    ok: true,
    directive: {
      run_id: active?.run_id ?? wf?.run_id ?? null,
      request_revision: active?.request_revision ?? wf?.request_revision ?? null,
      workflow_revision: wf?.revision ?? active?.workflow_revision ?? null,
      state: active?.state ?? null,
      current_item: nextItem?.id ?? wf?.current_item_id ?? null,
      allowed_next_calls: allowed,
      ...extra
    }
  };
}

export function failure(code, {
  active = null,
  wf = null,
  currentItem = null,
  missing = [],
  allowed = [],
  detail = '',
  violations = []
} = {}) {
  return {
    ok: false,
    error: {
      code,
      state: active?.state ?? null,
      current_item: currentItem?.id ?? wf?.current_item_id ?? null,
      missing,
      allowed_next_calls: allowed,
      repair: REPAIRS[code] || REPAIRS.RUNTIME_ERROR,
      ...(violations.length ? { violations } : {}),
      ...(detail ? { detail } : {})
    }
  };
}
