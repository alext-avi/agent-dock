// Per-agent runtime limits, as the control plane stores and validates them.
//
// Deliberately a second implementation of the same provider-neutral shape the
// wrapper validates, for the same reason `modelPolicy` is validated on both
// sides: the two are separate deployables, the control-plane image contains no
// worker code, and a limit the registry accepts but the wrapper rejects is a
// worse failure than a duplicated range check. The wrapper remains the authority
// on what is actually enforced — this side only decides what may be saved.

export const RUNTIME_LIMIT_FIELDS = Object.freeze({
  taskWallTimeoutMs: { kind: 'duration', min: 10, max: 86_400_000 },
  taskIdleTimeoutMs: { kind: 'duration', min: 10, max: 86_400_000 },
  terminationGraceMs: { kind: 'duration', min: 0, max: 120_000 },
  maxHarnessTurns: { kind: 'count', min: 1, max: 1_000 },
  childCommandTimeoutMs: { kind: 'duration', min: 10, max: 3_600_000 },
  childCommandMaxTimeoutMs: { kind: 'duration', min: 10, max: 3_600_000 },
  maxConcurrentSubagents: { kind: 'count', min: 0, max: 32 },
  maxSubagentDepth: { kind: 'count', min: 0, max: 8 },
  allowBackgroundTasks: { kind: 'flag' }
});

export const RUNTIME_LIMIT_DEFAULTS = Object.freeze({
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

// `inner` must not exceed `ceiling`. Both supplied and contradictory is refused;
// otherwise the inherited default yields to the value the caller actually asked
// for, so tightening one bound never fails on the other's default.
function reconcile(limits, supplied, inner, ceiling, message) {
  if (limits[inner] <= limits[ceiling]) return limits[inner];
  if (supplied.has(inner)) throw invalid(message);
  return limits[ceiling];
}

export function normalizeRuntimeLimits(value = {}, defaults = RUNTIME_LIMIT_DEFAULTS) {
  if (value === null || value === undefined) value = {};
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('runtimeLimits must be an object');
  for (const key of Object.keys(value)) {
    if (!RUNTIME_LIMIT_FIELDS[key]) throw invalid(`runtimeLimits.${key} is not a runtime limit`);
  }
  const base = { ...RUNTIME_LIMIT_DEFAULTS, ...defaults };
  const supplied = new Set(Object.keys(value).filter((key) => value[key] !== undefined && value[key] !== null));
  const limits = {};
  for (const [name, field] of Object.entries(RUNTIME_LIMIT_FIELDS)) {
    const supplied = value[name];
    if (supplied === undefined || supplied === null) {
      limits[name] = base[name];
      continue;
    }
    if (field.kind === 'flag') {
      if (typeof supplied !== 'boolean') throw invalid(`runtimeLimits.${name} must be true or false`);
      limits[name] = supplied;
      continue;
    }
    const number = Number(supplied);
    if (!Number.isInteger(number)) throw invalid(`runtimeLimits.${name} must be a whole number`);
    if (number < field.min || number > field.max) {
      throw invalid(`runtimeLimits.${name} must be between ${field.min} and ${field.max}`);
    }
    limits[name] = number;
  }
  // Same reconciliation the wrapper applies: two contradictory supplied values
  // are an operator error, but a supplied value never fails because of the
  // default it was tightening against.
  limits.taskIdleTimeoutMs = reconcile(
    limits, supplied, 'taskIdleTimeoutMs', 'taskWallTimeoutMs',
    'runtimeLimits.taskIdleTimeoutMs must not exceed runtimeLimits.taskWallTimeoutMs'
  );
  limits.childCommandTimeoutMs = reconcile(
    limits, supplied, 'childCommandTimeoutMs', 'childCommandMaxTimeoutMs',
    'runtimeLimits.childCommandTimeoutMs must not exceed runtimeLimits.childCommandMaxTimeoutMs'
  );
  return limits;
}
