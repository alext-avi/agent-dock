// Provider-neutral runtime limits for one harness task.
//
// Two different things bound a task, and conflating them is how an operator ends
// up believing a limit is in force when nothing enforces it:
//
//   * Agent Dock process supervision — the wall-clock timeout, the idle timeout,
//     and the graceful-then-forced termination of the harness process tree. The
//     wrapper owns these, so every adapter has them.
//   * Provider-native limits — turn counts, child-command timeouts, subagent
//     concurrency and depth, background-task policy. Only a harness that exposes
//     a control can enforce one, and an adapter declares which it exposes.
//
// A configured value for a control its adapter does not expose is kept (so the
// setting survives a move to a runtime that can honour it) but reported as not
// effective. Nothing here invents enforcement that is not happening.

export const RUNTIME_POLICY_FIELDS = Object.freeze({
  // Wrapper-supervised. Deliberately generous minimums: a test or a deliberate
  // operator experiment may want a very short bound, and refusing one would only
  // push the bound outside the policy where nothing reports it.
  taskWallTimeoutMs: { kind: 'duration', min: 10, max: 86_400_000, enforcedBy: 'wrapper' },
  taskIdleTimeoutMs: { kind: 'duration', min: 10, max: 86_400_000, enforcedBy: 'wrapper' },
  terminationGraceMs: { kind: 'duration', min: 0, max: 120_000, enforcedBy: 'wrapper' },
  // Harness-native. Supported only where an adapter says so.
  maxHarnessTurns: { kind: 'count', min: 1, max: 1_000, enforcedBy: 'harness' },
  childCommandTimeoutMs: { kind: 'duration', min: 10, max: 3_600_000, enforcedBy: 'harness' },
  childCommandMaxTimeoutMs: { kind: 'duration', min: 10, max: 3_600_000, enforcedBy: 'harness' },
  maxConcurrentSubagents: { kind: 'count', min: 0, max: 32, enforcedBy: 'harness' },
  maxSubagentDepth: { kind: 'count', min: 0, max: 8, enforcedBy: 'harness' },
  allowBackgroundTasks: { kind: 'flag', enforcedBy: 'harness' }
});

export const RUNTIME_POLICY_FIELD_NAMES = Object.freeze(Object.keys(RUNTIME_POLICY_FIELDS));

// Conservative on purpose. The failure this exists to prevent — issue #44 — was a
// child subtree idling for more than ten minutes at near-zero CPU while the
// parent stayed healthy and the account kept being billed. Silence is the signal
// that something is wrong, so the idle bound is much tighter than the wall bound.
export const RUNTIME_POLICY_DEFAULTS = Object.freeze({
  taskWallTimeoutMs: 1_800_000,
  taskIdleTimeoutMs: 300_000,
  terminationGraceMs: 10_000,
  maxHarnessTurns: 40,
  childCommandTimeoutMs: 120_000,
  childCommandMaxTimeoutMs: 600_000,
  maxConcurrentSubagents: 2,
  maxSubagentDepth: 1,
  allowBackgroundTasks: false
});

function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function integerField(value, name, { min, max }) {
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number)) {
    throw invalid(`runtimeLimits.${name} must be a whole number`);
  }
  if (number < min || number > max) {
    throw invalid(`runtimeLimits.${name} must be between ${min} and ${max}`);
  }
  return number;
}

// `inner` must not exceed `ceiling`. Both supplied and contradictory is refused;
// otherwise the inherited default yields to the value the caller actually asked
// for, so tightening one bound never fails on the other's default.
function reconcile(policy, supplied, inner, ceiling, message) {
  if (policy[inner] <= policy[ceiling]) return policy[inner];
  if (supplied.has(inner)) throw invalid(message);
  return policy[ceiling];
}

export function normalizeRuntimePolicy(value = {}, { defaults = RUNTIME_POLICY_DEFAULTS } = {}) {
  if (value === null || value === undefined) value = {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('runtimeLimits must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!RUNTIME_POLICY_FIELDS[key]) throw invalid(`runtimeLimits.${key} is not a runtime limit`);
  }
  const base = { ...RUNTIME_POLICY_DEFAULTS, ...defaults };
  // Which bounds the caller actually asked for, as opposed to inherited.
  const supplied = new Set(Object.keys(value).filter((key) => value[key] !== undefined && value[key] !== null));
  const policy = {};
  for (const [name, field] of Object.entries(RUNTIME_POLICY_FIELDS)) {
    const supplied = value[name];
    if (supplied === undefined || supplied === null) {
      policy[name] = base[name];
      continue;
    }
    if (field.kind === 'flag') {
      if (typeof supplied !== 'boolean') throw invalid(`runtimeLimits.${name} must be true or false`);
      policy[name] = supplied;
      continue;
    }
    policy[name] = integerField(supplied, name, field);
  }
  // Cross-field rules. An idle bound above the wall bound can never fire, and a
  // default child timeout above the ceiling is a contradiction the harness would
  // resolve silently in whichever direction it happened to prefer.
  //
  // How that is resolved depends on who asked for it. Two explicitly supplied
  // values that contradict each other are an operator error and are refused.
  // A supplied value that contradicts an inherited default is not: tightening
  // the wall bound to thirty seconds must not be rejected because the idle
  // default is five minutes, so the inherited side is clamped to the asked-for
  // one, which is always the tighter reading.
  policy.taskIdleTimeoutMs = reconcile(
    policy, supplied, 'taskIdleTimeoutMs', 'taskWallTimeoutMs',
    'runtimeLimits.taskIdleTimeoutMs must not exceed runtimeLimits.taskWallTimeoutMs'
  );
  policy.childCommandTimeoutMs = reconcile(
    policy, supplied, 'childCommandTimeoutMs', 'childCommandMaxTimeoutMs',
    'runtimeLimits.childCommandTimeoutMs must not exceed runtimeLimits.childCommandMaxTimeoutMs'
  );
  return Object.freeze(policy);
}

// What an adapter's harness natively enforces. `harnessControls` names policy
// fields; anything absent is reported unsupported rather than quietly dropped.
export function runtimePolicySupport(adapterRuntimeLimits = {}) {
  const harnessControls = new Set(adapterRuntimeLimits.harnessControls ?? []);
  const support = {};
  for (const [name, field] of Object.entries(RUNTIME_POLICY_FIELDS)) {
    if (field.enforcedBy === 'wrapper') {
      support[name] = {
        supported: true,
        enforcedBy: 'wrapper',
        reason: null
      };
      continue;
    }
    const supported = harnessControls.has(name);
    support[name] = {
      supported,
      enforcedBy: supported ? 'harness' : null,
      reason: supported ? null : 'This harness exposes no control for this limit; it is configured but not enforced.'
    };
  }
  return support;
}

// The subset that is actually in force. An unsupported control reads as null, so
// a consumer cannot mistake a stored preference for an applied bound.
export function effectiveRuntimePolicy(policy, support) {
  const effective = {};
  for (const name of RUNTIME_POLICY_FIELD_NAMES) {
    effective[name] = support[name]?.supported ? policy[name] : null;
  }
  return effective;
}

export function describeRuntimeLimits(policy, adapterRuntimeLimits) {
  const support = runtimePolicySupport(adapterRuntimeLimits);
  return {
    configured: { ...policy },
    effective: effectiveRuntimePolicy(policy, support),
    support
  };
}

// A stall is not yet a timeout: it is the point at which an operator should be
// able to see that nothing is happening, well before the wrapper acts on it.
export function stallThresholdMs(policy) {
  return Math.max(1, Math.floor(policy.taskIdleTimeoutMs / 2));
}

// Worker-level defaults, so an operator can set a floor for a whole runtime
// without the control plane. A malformed value is rejected here rather than
// silently becoming NaN and removing the bound it was meant to tighten.
export function runtimePolicyFromEnv(env = {}) {
  const raw = {};
  const numeric = {
    taskWallTimeoutMs: 'RUNTIME_TASK_WALL_TIMEOUT_MS',
    taskIdleTimeoutMs: 'RUNTIME_TASK_IDLE_TIMEOUT_MS',
    terminationGraceMs: 'RUNTIME_TERMINATION_GRACE_MS',
    maxHarnessTurns: 'RUNTIME_MAX_HARNESS_TURNS',
    childCommandTimeoutMs: 'RUNTIME_CHILD_COMMAND_TIMEOUT_MS',
    childCommandMaxTimeoutMs: 'RUNTIME_CHILD_COMMAND_MAX_TIMEOUT_MS',
    maxConcurrentSubagents: 'RUNTIME_MAX_CONCURRENT_SUBAGENTS',
    maxSubagentDepth: 'RUNTIME_MAX_SUBAGENT_DEPTH'
  };
  for (const [field, name] of Object.entries(numeric)) {
    const value = env[name];
    if (value === undefined || value === '') continue;
    raw[field] = Number(value);
  }
  if (env.RUNTIME_ALLOW_BACKGROUND_TASKS !== undefined && env.RUNTIME_ALLOW_BACKGROUND_TASKS !== '') {
    const value = String(env.RUNTIME_ALLOW_BACKGROUND_TASKS).trim();
    if (value !== '0' && value !== '1') {
      throw invalid('RUNTIME_ALLOW_BACKGROUND_TASKS must be 0 or 1');
    }
    raw.allowBackgroundTasks = value === '1';
  }
  return normalizeRuntimePolicy(raw);
}
