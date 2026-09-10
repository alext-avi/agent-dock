const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;
const POLL_ERRORS = Object.freeze({
  unauthenticated: 'Usage source authentication failed',
  throttled: 'Usage source is rate limited',
  network: 'Usage source is unreachable',
  http: 'Usage source returned an error',
  malformed: 'Usage source returned an unrecognized response',
  provider: 'Provider usage query failed',
  unknown: 'Usage source failed'
});
const PROVIDERS_BY_ADAPTER = Object.freeze({
  'codex-cli': 'openai',
  'claude-code': 'anthropic',
  opencode: 'multi-provider'
});

function dateValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function iso(value) {
  return dateValue(value)?.toISOString() ?? null;
}

function number(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) return null;
  return Math.min(max, Math.max(min, normalized));
}

function text(value, max = 160) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function supportFlag(value) {
  return typeof value === 'boolean' ? value : null;
}

function providerForAdapter(adapter) {
  return PROVIDERS_BY_ADAPTER[adapter] ?? null;
}

function durationLabel(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes >= 6.5 * 24 * 60) return `${Math.max(1, Math.round(minutes / (7 * 24 * 60)))}w`;
  if (minutes >= 24 * 60) return `${Math.max(1, Math.round(minutes / (24 * 60)))}d`;
  if (minutes >= 60) {
    const hours = minutes / 60;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1).replace(/\.0$/, '')}h`;
  }
  return `${Math.round(minutes)}m`;
}

function refreshLabel(resetsAt, now) {
  const reset = dateValue(resetsAt);
  if (!reset) return null;
  const delta = reset.getTime() - now.getTime();
  if (delta <= 0) return 'refreshing now';
  const minutes = Math.max(1, Math.ceil(delta / 60_000));
  if (minutes < 60) return `refreshes in ${minutes} min`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `refreshes in ${hours} hr`;
  const days = Math.ceil(hours / 24);
  if (days < 7) return `refreshes in ${days} day${days === 1 ? '' : 's'}`;
  const weeks = Math.ceil(days / 7);
  return `refreshes in ${weeks} week${weeks === 1 ? '' : 's'}`;
}

function normalizeTotals(value, supported) {
  if (supported === false || !value || typeof value !== 'object') return null;
  return {
    requests: number(value.requests) ?? 0,
    inputTokens: number(value.inputTokens) ?? 0,
    cachedInputTokens: number(value.cachedInputTokens) ?? 0,
    outputTokens: number(value.outputTokens) ?? 0,
    totalTokens: number(value.totalTokens) ?? 0,
    durationMs: number(value.durationMs) ?? 0
  };
}

function normalizeAccount(value, supported) {
  if (supported === false || !value || typeof value !== 'object') return null;
  return {
    lifetimeTokens: number(value.lifetimeTokens),
    peakDailyTokens: number(value.peakDailyTokens),
    longestRunningTaskSeconds: number(value.longestRunningTaskSeconds),
    currentStreakDays: number(value.currentStreakDays),
    longestStreakDays: number(value.longestStreakDays)
  };
}

function normalizeBudget(value, supported) {
  if (supported === false || !value || typeof value !== 'object') return null;
  const currency = text(value.currency, 12)?.toUpperCase() ?? null;
  const used = number(value.used);
  const available = number(value.available);
  const limit = number(value.limit);
  if (!currency && used === null && available === null && limit === null) return null;
  return { currency, used, available, limit };
}

function normalizeWindows(value, supported, now, stale) {
  if (supported === false || !Array.isArray(value)) return [];
  return value.slice(0, 50).map((window, index) => {
    const usedPercent = number(window?.usedPercent, { max: 100 });
    const windowDurationMinutes = number(window?.windowDurationMinutes, { min: 1 });
    const resetsAtEpoch = number(window?.resetsAt, { min: 1 });
    const resetsAt = resetsAtEpoch === null ? null : iso(resetsAtEpoch * 1000);
    return {
      id: text(window?.id) ?? `window-${index + 1}`,
      label: text(window?.label) ?? 'Quota window',
      scope: text(window?.scope, 80),
      usedPercent,
      remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
      windowDurationMinutes,
      duration: durationLabel(windowDurationMinutes),
      resetsAt,
      refresh: stale ? null : refreshLabel(resetsAt, now),
      reached: window?.reached === true
    };
  });
}

function normalizedSupport(capabilities, usage) {
  const source = capabilities && typeof capabilities === 'object' ? capabilities : {};
  return {
    requestTokens: supportFlag(source.requestTokens) ?? (usage?.totals ? true : null),
    quotaWindows: supportFlag(source.quotaWindows) ?? (usage?.quotaWindows?.length ? true : null),
    accountActivity: supportFlag(source.accountActivity) ?? (usage?.account ? true : null),
    monetaryBudget: supportFlag(source.monetaryBudget) ?? (usage?.budget ? true : null)
  };
}

function safeQuotaWindows(value) {
  if (!Array.isArray(value)) return null;
  return value.slice(0, 50).map((window) => ({
    id: text(window?.id),
    label: text(window?.label),
    scope: text(window?.scope, 80),
    usedPercent: number(window?.usedPercent, { max: 100 }),
    windowDurationMinutes: number(window?.windowDurationMinutes, { min: 1 }),
    resetsAt: number(window?.resetsAt, { min: 1 }),
    reached: window?.reached === true
  }));
}

function safeUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const pollErrorKind = text(value.pollErrorKind, 40);
  return {
    updatedAt: iso(value.updatedAt),
    lastPollAt: iso(value.lastPollAt),
    lastSuccessAt: iso(value.lastSuccessAt),
    pollErrorKind: pollErrorKind && Object.hasOwn(POLL_ERRORS, pollErrorKind) ? pollErrorKind : (pollErrorKind ? 'unknown' : null),
    totals: normalizeTotals(value.totals, true),
    quotaWindows: safeQuotaWindows(value.quotaWindows),
    account: normalizeAccount(value.account, true),
    budget: normalizeBudget(value.budget, true)
  };
}

function transportError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'Worker usage request timed out';
  const status = Number(error?.status);
  if (Number.isInteger(status) && status >= 400 && status <= 599) return `Worker usage request returned HTTP ${status}`;
  return 'Worker usage snapshot is unavailable';
}

export function createFleetUsageCache(options = {}) {
  const clock = options.clock ?? (() => new Date());
  const staleAfterMs = Number(options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 1_000 || staleAfterMs > 24 * 60 * 60 * 1000) {
    throw new Error('MCP usage staleAfterMs must be between 1000 and 86400000');
  }
  const records = new Map();

  function now() {
    const value = dateValue(clock());
    if (!value) throw new Error('Fleet usage clock returned an invalid date');
    return value;
  }

  function observe(agent, snapshot) {
    const usage = safeUsage(snapshot?.usage);
    if (!usage) return false;
    const previous = records.get(agent.id);
    records.set(agent.id, {
      observedAt: now().toISOString(),
      // Provider identity comes from the control plane's adapter allowlist, not
      // a free-form worker field that could be abused to echo sensitive text.
      provider: providerForAdapter(agent.adapter) ?? previous?.provider ?? null,
      capabilities: normalizedSupport(snapshot?.capabilities?.usage, usage),
      usage,
      error: null
    });
    return true;
  }

  function observeError(agent, error) {
    const previous = records.get(agent.id);
    records.set(agent.id, {
      observedAt: previous?.observedAt ?? null,
      provider: previous?.provider ?? null,
      capabilities: previous?.capabilities ?? null,
      usage: previous?.usage ?? null,
      error: transportError(error)
    });
  }

  function summarize(agent, at) {
    const record = records.get(agent.id);
    const support = normalizedSupport(record?.capabilities, record?.usage);
    const observed = dateValue(record?.observedAt);
    const ageSeconds = observed ? Math.max(0, Math.floor((at.getTime() - observed.getTime()) / 1000)) : null;
    const cacheStale = ageSeconds !== null && ageSeconds * 1000 > staleAfterMs;
    const pollError = record?.usage?.pollErrorKind;
    const entirelyUnsupported = Object.values(support).every((value) => value === false);
    let state;
    if (entirelyUnsupported) state = 'unsupported';
    else if (!record?.usage) state = 'unavailable';
    else if (record.error || pollError || cacheStale) state = 'stale';
    else state = 'available';
    const stale = state === 'stale';
    const error = record?.error
      ?? (pollError ? (POLL_ERRORS[pollError] ?? POLL_ERRORS.unknown) : null)
      ?? (cacheStale ? 'Cached usage snapshot is older than the freshness policy' : null)
      ?? (!record ? 'No cached usage snapshot is available' : null);

    return {
      agentId: agent.id,
      name: agent.name,
      adapter: agent.adapter,
      provider: record?.provider ?? providerForAdapter(agent.adapter),
      telemetry: {
        state,
        fresh: state === 'available',
        observedAt: record?.observedAt ?? null,
        updatedAt: record?.usage?.updatedAt ?? null,
        lastPollAt: record?.usage?.lastPollAt ?? null,
        lastSuccessAt: record?.usage?.lastSuccessAt ?? null,
        ageSeconds,
        support
      },
      totals: normalizeTotals(record?.usage?.totals, support.requestTokens),
      quotaWindows: normalizeWindows(record?.usage?.quotaWindows, support.quotaWindows, at, stale),
      account: normalizeAccount(record?.usage?.account, support.accountActivity),
      budget: normalizeBudget(record?.usage?.budget, support.monetaryBudget),
      error
    };
  }

  return {
    staleAfterMs,
    observe,
    observeError,
    remove: (agentId) => records.delete(agentId),
    list(agents = []) {
      const at = now();
      return {
        schemaVersion: 1,
        generatedAt: at.toISOString(),
        cache: {
          strategy: 'opportunistic',
          staleAfterSeconds: Math.ceil(staleAfterMs / 1000),
          workerRequestsMade: 0
        },
        agents: agents.map((agent) => summarize(agent, at))
      };
    }
  };
}
