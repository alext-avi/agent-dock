// Experimental Claude subscription quota telemetry.
//
// PROVENANCE. The endpoint, the `anthropic-beta` header value, the credential
// locations, and the 401/403-versus-429 error split were all established by the
// TokenEater project (https://github.com/AThevon/TokenEater) — specifically
// Shared/Services/APIClient.swift, Shared/Services/TokenProvider.swift, and
// Shared/Models/UsageModels.swift. This module is an independent JavaScript
// reimplementation of those findings; no TokenEater code is copied.
//
// THIS IS NOT A DOCUMENTED ANTHROPIC INTEGRATION. Anthropic publishes no
// third-party OAuth flow and no scoped usage-only token, so the endpoint, the
// beta header, the credential schema, and the response schema may all change
// without notice. Every path here fails closed: an unfamiliar credential shape,
// an unexpected payload, or any transport failure yields zero quota windows and
// a recorded error, never a guess. Local per-request token history is
// independent of this source and keeps working when it is unavailable.
//
// Disabled unless CLAUDE_OAUTH_USAGE=1. See docs/adapter-contract.md.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const CLAUDE_USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
export const CLAUDE_USAGE_BETA_HEADER = 'oauth-2025-04-20';

// Claude Code's own credential file, inside this worker's private auth volume.
export function claudeCredentialPaths(claudeHome, configDir = null) {
  const dir = configDir ?? path.join(claudeHome, '.claude');
  return [path.join(dir, '.credentials.json')];
}

// Longest backoff worth honouring. RFC 7231 puts no ceiling on Retry-After, so a
// buggy proxy or a hostile intermediary can send a value that would otherwise
// wedge polling effectively forever — and it would survive a restart.
export const MAX_RETRY_AFTER_SECONDS = 3600;

// Retry-After is either delta-seconds or an HTTP-date. Reading only the numeric
// form silently shortens a long date-form backoff to the default interval.
export function retryAfterSeconds(header) {
  if (typeof header !== 'string' || !header.trim()) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds)) {
    if (seconds <= 0) return null;
    return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
  }
  const when = Date.parse(header);
  if (!Number.isFinite(when)) return null;
  const delta = Math.ceil((when - Date.now()) / 1000);
  if (delta <= 0) return null;
  return Math.min(delta, MAX_RETRY_AFTER_SECONDS);
}

export class ClaudeUsageError extends Error {
  // kind distinguishes a telemetry-source failure from an exhausted plan.
  // An exhausted plan is a *successful* response with utilization at 100 — it is
  // never an error. These are all failures to read the source at all.
  //   unauthenticated - 401/403; the CLI's token is expired or was revoked
  //   throttled       - 429 from the usage endpoint itself
  //   http            - any other non-2xx
  //   network         - DNS, TLS, connection, or timeout
  //   malformed       - unfamiliar credential shape or undecodable payload
  constructor(kind, message, { retryAfterSeconds = null, status = null } = {}) {
    super(message);
    this.name = 'ClaudeUsageError';
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
    this.status = status;
  }
}

export async function readClaudeOAuthToken(candidatePaths) {
  const problems = [];
  for (const file of candidatePaths) {
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      problems.push(`${file}: ${error.code ?? error.message}`);
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      problems.push(`${file}: not valid JSON`);
      continue;
    }
    // Fail closed on an unfamiliar shape rather than hunting for anything
    // token-shaped elsewhere in the file.
    const token = parsed?.claudeAiOauth?.accessToken;
    if (typeof token === 'string' && token.length > 0) return token;
    problems.push(`${file}: no claudeAiOauth.accessToken`);
  }
  throw new ClaudeUsageError('malformed', `No usable Claude OAuth credential (${problems.join('; ')})`);
}

// Windows Agent Dock is willing to surface. The response also carries buckets
// under rotating internal codenames (observed: tangelo, nimbus_quill,
// iguana_necktie, cinder_cove, amber_ladder, juniper_tide, omelette_*). Those
// are unstable and meaningless to an operator, so unknown kinds are dropped
// rather than displayed.
const WINDOW_KINDS = {
  session: { label: 'Session', scope: 'primary', windowDurationMinutes: 300 },
  weekly_all: { label: 'Weekly', scope: 'secondary', windowDurationMinutes: 10_080 },
  weekly_scoped: { label: 'Weekly', scope: 'additional', windowDurationMinutes: 10_080 }
};

// The contract carries resetsAt as epoch seconds; the provider sends ISO 8601,
// with and without fractional seconds.
function epochSeconds(value) {
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function percentOf(value) {
  // Number(null) is 0, which would turn "the provider sent no reading" into a
  // confident 0% used. An absent value and an explicit null mean the same thing
  // and must both drop the window rather than invent one.
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, number));
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function windowFrom(kind, { id, labelSuffix = '', usedPercent, resetsAt, reached }) {
  const definition = WINDOW_KINDS[kind];
  if (!definition || usedPercent === null) return null;
  return {
    id,
    label: labelSuffix ? `${definition.label} · ${labelSuffix}` : definition.label,
    scope: definition.scope,
    usedPercent,
    windowDurationMinutes: definition.windowDurationMinutes,
    resetsAt,
    reached
  };
}

// Pure. Accepts the raw /api/oauth/usage payload, returns contract-shaped
// quotaWindows[]. Never throws — an unrecognized payload yields [].
export function normalizeClaudeQuotaWindows(payload) {
  if (!payload || typeof payload !== 'object') return [];

  // Both shapes are read and merged. Anthropic is migrating buckets into
  // `limits[]` one at a time, so a response can legitimately carry a migrated
  // session window alongside a not-yet-migrated flat weekly one. Preferring
  // whichever shape appears first and ignoring the other silently drops real
  // windows — a confident partial reading, which is worse than failing.
  const byId = new Map();
  const add = (window) => {
    if (!window) return;
    let id = window.id;
    // Distinct windows must not collapse into one id: two entries scoped to
    // models whose names slug identically are still two different limits.
    for (let suffix = 2; byId.has(id); suffix += 1) id = `${window.id}#${suffix}`;
    byId.set(id, { ...window, id });
  };

  if (Array.isArray(payload.limits)) {
    for (const limit of payload.limits) {
      const kind = limit?.kind;
      if (!WINDOW_KINDS[kind]) continue;
      const model = limit?.scope?.model?.display_name;
      const usedPercent = percentOf(limit.percent);
      add(windowFrom(kind, {
        id: kind === 'weekly_scoped' && model ? `${kind}:${slug(model)}` : kind,
        labelSuffix: kind === 'weekly_scoped' && model ? model : '',
        usedPercent,
        resetsAt: epochSeconds(limit.resets_at),
        reached: limit.severity === 'critical' || (usedPercent !== null && usedPercent >= 100)
      }));
    }
  }

  // Legacy flat shape. Only the two documented buckets are read, and only when
  // `limits[]` has not already supplied that window.
  for (const [key, kind] of [['five_hour', 'session'], ['seven_day', 'weekly_all']]) {
    if (byId.has(kind)) continue;
    const bucket = payload[key];
    if (!bucket || typeof bucket !== 'object') continue;
    const usedPercent = percentOf(bucket.utilization);
    add(windowFrom(kind, {
      id: kind,
      usedPercent,
      resetsAt: epochSeconds(bucket.resets_at),
      reached: usedPercent !== null && usedPercent >= 100
    }));
  }

  return [...byId.values()];
}

// The response also carries account and billing state — credit balance, spend
// limits, organization lock reasons, dashboard availability — that no quota
// window uses. The worker persists whatever this returns, so reduce it to the
// fields the normalizer actually reads rather than retaining account data at
// rest for no purpose.
export function minimizeClaudeUsage(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const minimal = {};
  if (Array.isArray(payload.limits)) {
    minimal.limits = payload.limits
      .filter((limit) => WINDOW_KINDS[limit?.kind])
      .map((limit) => {
        const model = limit?.scope?.model?.display_name;
        return {
          kind: limit.kind,
          percent: limit.percent ?? null,
          severity: limit.severity ?? null,
          resets_at: limit.resets_at ?? null,
          ...(model ? { scope: { model: { display_name: model } } } : {})
        };
      });
  }
  for (const key of ['five_hour', 'seven_day']) {
    const bucket = payload[key];
    if (bucket && typeof bucket === 'object') {
      minimal[key] = { utilization: bucket.utilization ?? null, resets_at: bucket.resets_at ?? null };
    }
  }
  return minimal;
}

// Impure. Reads the worker-local credential and calls the endpoint, returning the
// raw provider envelope for the worker to persist — normalization happens at read
// time, the same way provider events are translated. The token never leaves this
// function: it is not returned, logged, persisted, or included in any error message.
export async function fetchClaudeUsage({
  credentialPaths,
  endpoint = CLAUDE_USAGE_ENDPOINT,
  timeoutMs = 15_000,
  fetchImpl = fetch
} = {}) {
  const token = await readClaudeOAuthToken(credentialPaths);

  let response;
  try {
    response = await fetchImpl(endpoint, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': CLAUDE_USAGE_BETA_HEADER,
        accept: 'application/json'
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new ClaudeUsageError('network', `Usage endpoint unreachable: ${error.name}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new ClaudeUsageError('unauthenticated', 'Claude credential was rejected; sign in again', { status: response.status });
  }
  if (response.status === 429) {
    throw new ClaudeUsageError('throttled', 'Usage endpoint is rate limiting telemetry polling', {
      status: 429,
      retryAfterSeconds: retryAfterSeconds(response.headers.get('retry-after'))
    });
  }
  if (!response.ok) {
    throw new ClaudeUsageError('http', `Usage endpoint returned ${response.status}`, { status: response.status });
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ClaudeUsageError('malformed', 'Usage endpoint returned an undecodable payload');
  }

  // Fail closed: if the schema moved far enough that nothing normalizes, report
  // the source as broken rather than persisting an envelope that renders empty.
  if (!normalizeClaudeQuotaWindows(payload).length) {
    throw new ClaudeUsageError('malformed', 'Usage payload contained no recognizable quota windows');
  }
  return minimizeClaudeUsage(payload);
}
