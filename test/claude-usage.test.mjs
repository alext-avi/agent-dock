import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWorkerServer } from '../worker/server.mjs';
import {
  ClaudeUsageError,
  MAX_RETRY_AFTER_SECONDS,
  fetchClaudeUsage,
  minimizeClaudeUsage,
  normalizeClaudeQuotaWindows,
  readClaudeOAuthToken,
  retryAfterSeconds
} from '../worker/adapters/claude-usage.mjs';

const ACCESS_TOKEN = 'sk-ant-oat-test-do-not-disclose';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

async function claudeHomeWithCredential(t, credential = { claudeAiOauth: { accessToken: ACCESS_TOKEN } }) {
  const home = await mkdtemp(join(tmpdir(), 'agent-dock-claude-'));
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude', '.credentials.json'), JSON.stringify(credential));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test('Claude usage normalization prefers limits[] and drops unrecognized buckets', async () => {
  const windows = normalizeClaudeQuotaWindows(await fixture('claude-usage-limits'));

  assert.deepEqual(windows.map((window) => window.id), ['session', 'weekly_all', 'weekly_scoped:fable']);

  const session = windows[0];
  assert.equal(session.scope, 'primary');
  assert.equal(session.usedPercent, 0);
  assert.equal(session.windowDurationMinutes, 300);
  assert.equal(session.resetsAt, null);
  assert.equal(session.reached, false);

  // An exhausted plan is a successful reading, not an error.
  const weekly = windows[1];
  assert.equal(weekly.scope, 'secondary');
  assert.equal(weekly.usedPercent, 100);
  assert.equal(weekly.reached, true);
  assert.equal(weekly.windowDurationMinutes, 10_080);
  assert.equal(typeof weekly.resetsAt, 'number', 'resetsAt is epoch seconds, not an ISO string');
  assert.ok(weekly.resetsAt > 1_700_000_000 && weekly.resetsAt < 4_000_000_000);

  assert.equal(windows[2].label, 'Weekly · Fable');

  // The payload also carries buckets under rotating internal codenames. None of
  // them may reach an operator.
  const serialized = JSON.stringify(windows);
  for (const codename of ['tangelo', 'nimbus_quill', 'iguana_necktie', 'cinder_cove', 'amber_ladder', 'juniper_tide', 'omelette']) {
    assert.ok(!serialized.includes(codename), `codenamed bucket ${codename} leaked into quota windows`);
  }
});

test('Claude usage normalization falls back to the legacy flat buckets', async () => {
  const windows = normalizeClaudeQuotaWindows(await fixture('claude-usage-legacy'));

  assert.deepEqual(windows.map((window) => window.id), ['session', 'weekly_all']);
  assert.equal(windows[0].usedPercent, 42.5);
  assert.equal(windows[1].usedPercent, 12);
  // The legacy branch computes resetsAt and reached separately from limits[].
  assert.equal(typeof windows[0].resetsAt, 'number');
  assert.ok(windows[0].resetsAt > 1_700_000_000 && windows[0].resetsAt < 4_000_000_000);
  assert.equal(typeof windows[1].resetsAt, 'number');
  assert.equal(windows[0].reached, false);
  assert.equal(windows[1].reached, false);
  assert.ok(!JSON.stringify(windows).includes('juniper_tide'));
});

test('Claude usage normalization fails closed on an unrecognized payload', async () => {
  assert.deepEqual(normalizeClaudeQuotaWindows(await fixture('claude-usage-unrecognized')), []);
  assert.deepEqual(normalizeClaudeQuotaWindows({}), []);
  assert.deepEqual(normalizeClaudeQuotaWindows(null), []);
  assert.deepEqual(normalizeClaudeQuotaWindows('nope'), []);
  assert.deepEqual(normalizeClaudeQuotaWindows({ limits: 'not-an-array' }), []);
});

test('Claude usage normalization merges a partially migrated payload', async () => {
  // The migration is bucket by bucket, so a response can carry a migrated
  // session window and a not-yet-migrated flat weekly one at the same time.
  // Reading only whichever shape appears first drops a real window.
  const windows = normalizeClaudeQuotaWindows({
    limits: [{ kind: 'session', percent: 5, severity: 'normal', resets_at: null }],
    seven_day: { utilization: 80, resets_at: '2026-09-01T00:00:00Z' }
  });

  assert.deepEqual(windows.map((window) => window.id), ['session', 'weekly_all']);
  assert.equal(windows[1].usedPercent, 80, 'the un-migrated weekly window was dropped');

  // Where both shapes describe the same window, limits[] is authoritative.
  const overlapping = normalizeClaudeQuotaWindows({
    limits: [{ kind: 'weekly_all', percent: 30, severity: 'normal', resets_at: null }],
    seven_day: { utilization: 99, resets_at: null }
  });
  assert.deepEqual(overlapping.map((window) => [window.id, window.usedPercent]), [['weekly_all', 30]]);
});

test('Claude usage normalization never invents a reading', async () => {
  // Number(null) is 0. An explicit null must drop the window, exactly as an
  // absent key does — not report a confident 0% used.
  assert.deepEqual(normalizeClaudeQuotaWindows({ limits: [{ kind: 'session', percent: null }] }), []);
  assert.deepEqual(normalizeClaudeQuotaWindows({ five_hour: { utilization: null } }), []);
  assert.deepEqual(normalizeClaudeQuotaWindows({ limits: [{ kind: 'session' }] }), []);
  assert.deepEqual(normalizeClaudeQuotaWindows({ limits: [{ kind: 'session', percent: 'abc' }] }), []);

  // Garbage from an undocumented endpoint is clamped, not passed through.
  const [high] = normalizeClaudeQuotaWindows({ limits: [{ kind: 'session', percent: 140 }] });
  assert.equal(high.usedPercent, 100);
  const [low] = normalizeClaudeQuotaWindows({ limits: [{ kind: 'session', percent: -3 }] });
  assert.equal(low.usedPercent, 0);
  assert.equal(low.reached, false);
});

test('Claude usage normalization keeps colliding windows distinct', async () => {
  const windows = normalizeClaudeQuotaWindows({
    limits: [
      { kind: 'weekly_scoped', percent: 10, scope: { model: { display_name: 'Claude Opus 4' } } },
      { kind: 'weekly_scoped', percent: 90, scope: { model: { display_name: 'Claude  Opus  4!!' } } }
    ]
  });
  assert.equal(windows.length, 2, 'a slug collision silently merged two different limits');
  assert.equal(new Set(windows.map((window) => window.id)).size, 2, 'window ids must be unique');
});

test('Claude usage persists only the fields the normalizer reads', async () => {
  const payload = await fixture('claude-usage-limits');
  const minimal = minimizeClaudeUsage(payload);
  const serialized = JSON.stringify(minimal);

  // Account and billing state is not quota telemetry and must not be retained.
  for (const field of ['spend', 'extra_usage', 'member_dashboard_available', 'amount_minor', 'org_level_disabled_until']) {
    assert.ok(!serialized.includes(field), `${field} was persisted`);
  }
  // Minimizing must not change what the operator sees.
  assert.deepEqual(normalizeClaudeQuotaWindows(minimal), normalizeClaudeQuotaWindows(payload));
});

test('Retry-After is parsed in both legal forms and capped', async () => {
  assert.equal(retryAfterSeconds('120'), 120);
  assert.equal(retryAfterSeconds('  90 '), 90);
  assert.equal(retryAfterSeconds('0'), null);
  assert.equal(retryAfterSeconds('-5'), null);
  assert.equal(retryAfterSeconds(''), null);
  assert.equal(retryAfterSeconds(null), null);

  // RFC 7231 allows an HTTP-date. Reading only the numeric form would silently
  // shorten a long backoff to the default interval.
  const soon = new Date(Date.now() + 300_000).toUTCString();
  const parsed = retryAfterSeconds(soon);
  assert.ok(parsed > 250 && parsed <= 300, `expected ~300s, got ${parsed}`);
  assert.equal(retryAfterSeconds(new Date(Date.now() - 60_000).toUTCString()), null);

  // An absurd value must not wedge polling effectively forever.
  assert.equal(retryAfterSeconds('999999999999'), MAX_RETRY_AFTER_SECONDS);
});

test('Claude credential reading fails closed on an unfamiliar shape', async (t) => {
  const good = await claudeHomeWithCredential(t);
  assert.equal(await readClaudeOAuthToken([join(good, '.claude', '.credentials.json')]), ACCESS_TOKEN);

  const missing = await claudeHomeWithCredential(t, { someOtherProvider: { token: 'sk-ant-decoy' } });
  await assert.rejects(
    () => readClaudeOAuthToken([join(missing, '.claude', '.credentials.json')]),
    (error) => {
      assert.ok(error instanceof ClaudeUsageError);
      assert.equal(error.kind, 'malformed');
      // It must not go hunting for anything token-shaped elsewhere in the file.
      assert.ok(!error.message.includes('sk-ant-decoy'));
      return true;
    }
  );

  await assert.rejects(
    () => readClaudeOAuthToken(['/definitely/not/here/.credentials.json']),
    (error) => error.kind === 'malformed'
  );
});

test('Claude usage fetch classifies every failure of an undocumented endpoint', async (t) => {
  const home = await claudeHomeWithCredential(t);
  const credentialPaths = [join(home, '.claude', '.credentials.json')];

  const cases = [
    { name: 'expired credential', impl: () => jsonResponse({ error: 'unauthorized' }, { status: 401 }), kind: 'unauthenticated' },
    { name: 'revoked credential', impl: () => jsonResponse({ error: 'forbidden' }, { status: 403 }), kind: 'unauthenticated' },
    { name: 'server error', impl: () => jsonResponse({ error: 'boom' }, { status: 503 }), kind: 'http' },
    { name: 'transport failure', impl: () => { throw Object.assign(new Error('socket hang up'), { name: 'TypeError' }); }, kind: 'network' },
    { name: 'undecodable body', impl: () => new Response('<html>maintenance</html>', { status: 200, headers: { 'content-type': 'text/html' } }), kind: 'malformed' },
    { name: 'schema moved', impl: async () => jsonResponse(await fixture('claude-usage-unrecognized')), kind: 'malformed' }
  ];

  for (const { name, impl, kind } of cases) {
    await assert.rejects(
      () => fetchClaudeUsage({ credentialPaths, fetchImpl: impl }),
      (error) => {
        assert.ok(error instanceof ClaudeUsageError, `${name} produced ${error.name}`);
        assert.equal(error.kind, kind, `${name} classified as ${error.kind}`);
        assert.ok(!error.message.includes(ACCESS_TOKEN), `${name} leaked the access token`);
        return true;
      }
    );
  }

  // A 429 from the telemetry endpoint is a source failure, distinct from an
  // exhausted plan, and carries the backoff the server must honour.
  await assert.rejects(
    () => fetchClaudeUsage({
      credentialPaths,
      fetchImpl: () => jsonResponse({ error: 'slow down' }, { status: 429, headers: { 'retry-after': '120' } })
    }),
    (error) => {
      assert.equal(error.kind, 'throttled');
      assert.equal(error.retryAfterSeconds, 120);
      return true;
    }
  );
});

test('Claude usage fetch sends the credentials and beta header the endpoint requires', async (t) => {
  const home = await claudeHomeWithCredential(t);
  let seen = null;
  const payload = await fixture('claude-usage-limits');

  const returned = await fetchClaudeUsage({
    credentialPaths: [join(home, '.claude', '.credentials.json')],
    fetchImpl: (url, init) => {
      seen = { url, headers: init.headers };
      return jsonResponse(payload);
    }
  });

  assert.equal(seen.url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(seen.headers.authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.equal(seen.headers['anthropic-beta'], 'oauth-2025-04-20');
  // The raw envelope is returned for the worker to persist and normalize on read.
  assert.equal(returned.limits.length, 3);
});

test('the Claude worker keeps the experimental quota source off unless enabled', async (t) => {
  const token = 'claude-usage-off';
  const worker = createWorkerServer({
    token,
    adapter: 'claude-code',
    demoMode: true,
    workspace: process.cwd(),
    dataPath: null
  });
  const workerUrl = await listen(worker);
  t.after(() => new Promise((resolve) => worker.close(resolve)));

  const status = await (await fetch(`${workerUrl}/v1/status`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(status.capabilities.usage.quotaWindows, false);
  assert.equal(status.capabilities.usage.quotaWindowSource, undefined);
  assert.deepEqual(status.usage.quotaWindows, []);

  const refreshed = await (await fetch(`${workerUrl}/v1/usage/refresh`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` }
  })).json();
  assert.deepEqual(refreshed.usage.quotaWindows, []);
  assert.equal(refreshed.usage.pollError, null);
});

test('the Claude worker reports experimental quota windows without disclosing the token', async (t) => {
  const token = 'claude-usage-on';
  const home = await claudeHomeWithCredential(t);
  const payload = await fixture('claude-usage-limits');
  let calls = 0;

  const worker = createWorkerServer({
    token,
    adapter: 'claude-code',
    demoMode: true,
    workspace: process.cwd(),
    dataPath: null,
    claudeHome: home,
    claudeOAuthUsage: true,
    usagePollIntervalMs: 60_000,
    claudeUsageFetch: () => {
      calls += 1;
      return jsonResponse(payload);
    }
  });
  const workerUrl = await listen(worker);
  t.after(() => new Promise((resolve) => worker.close(resolve)));

  const response = await fetch(`${workerUrl}/v1/usage/refresh`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` }
  });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.ok(!body.includes(ACCESS_TOKEN), 'the access token reached a wrapper response');
  assert.ok(!body.includes('claudeAiOauth'), 'the raw credential envelope reached a wrapper response');

  const refreshed = JSON.parse(body);
  assert.equal(refreshed.usage.pollError, null);
  assert.equal(refreshed.usage.pollErrorKind, null);
  assert.deepEqual(refreshed.usage.quotaWindows.map((window) => window.id), ['session', 'weekly_all', 'weekly_scoped:fable']);
  assert.equal(refreshed.usage.quotaWindows[1].reached, true);

  const status = await (await fetch(`${workerUrl}/v1/status`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(status.capabilities.usage.quotaWindows, true);
  assert.equal(status.capabilities.usage.quotaWindowSource, 'experimental-oauth');

  // Polling an undocumented endpoint stays bounded even when callers force it.
  await fetch(`${workerUrl}/v1/usage/refresh`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  assert.equal(calls, 1, 'the usage endpoint was polled more than once inside the poll interval');
});

test('the experimental source is polled no harder than its own floor', async (t) => {
  const token = 'claude-usage-floor';
  const home = await claudeHomeWithCredential(t);
  const payload = await fixture('claude-usage-limits');
  let calls = 0;

  const worker = createWorkerServer({
    token,
    adapter: 'claude-code',
    demoMode: true,
    workspace: process.cwd(),
    dataPath: null,
    claudeHome: home,
    claudeOAuthUsage: true,
    // A fast general interval must not drag the provider call along with it:
    // the Claude floor is the larger of the two.
    usagePollIntervalMs: 1,
    claudeUsageIntervalMs: 60_000,
    claudeUsageFetch: () => {
      calls += 1;
      return jsonResponse(payload);
    }
  });
  const workerUrl = await listen(worker);
  t.after(() => new Promise((resolve) => worker.close(resolve)));

  const headers = { authorization: `Bearer ${token}` };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await fetch(`${workerUrl}/v1/usage/refresh`, { method: 'POST', headers });
    await fetch(`${workerUrl}/v1/status`, { headers });
  }
  assert.equal(calls, 1, `the endpoint was called ${calls} times inside one floor window`);
});

test('the worker honours a 429 backoff instead of retrying immediately', async (t) => {
  const token = 'claude-usage-429';
  const home = await claudeHomeWithCredential(t);
  let calls = 0;

  const worker = createWorkerServer({
    token,
    adapter: 'claude-code',
    demoMode: true,
    workspace: process.cwd(),
    dataPath: null,
    claudeHome: home,
    claudeOAuthUsage: true,
    // No floor of its own: the backoff must be what stops the second call.
    usagePollIntervalMs: 0,
    claudeUsageIntervalMs: 0,
    claudeUsageFetch: () => {
      calls += 1;
      return jsonResponse({ error: 'slow down' }, { status: 429, headers: { 'retry-after': '600' } });
    }
  });
  const workerUrl = await listen(worker);
  t.after(() => new Promise((resolve) => worker.close(resolve)));

  const headers = { authorization: `Bearer ${token}` };
  const first = await (await fetch(`${workerUrl}/v1/usage/refresh`, { method: 'POST', headers })).json();
  assert.equal(first.usage.pollErrorKind, 'throttled');

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await fetch(`${workerUrl}/v1/usage/refresh`, { method: 'POST', headers });
  }
  assert.equal(calls, 1, `the endpoint was called ${calls} times while backing off`);
});

test('a failed poll keeps the last good windows and marks them stale', async (t) => {
  const token = 'claude-usage-stale';
  const home = await claudeHomeWithCredential(t);
  const payload = await fixture('claude-usage-limits');
  let healthy = true;

  const worker = createWorkerServer({
    token,
    adapter: 'claude-code',
    demoMode: true,
    workspace: process.cwd(),
    dataPath: null,
    claudeHome: home,
    claudeOAuthUsage: true,
    usagePollIntervalMs: 0,
    claudeUsageIntervalMs: 0,
    claudeUsageFetch: () => (healthy
      ? jsonResponse(payload)
      : jsonResponse({ error: 'unauthorized' }, { status: 401 }))
  });
  const workerUrl = await listen(worker);
  t.after(() => new Promise((resolve) => worker.close(resolve)));

  const headers = { authorization: `Bearer ${token}` };
  const good = await (await fetch(`${workerUrl}/v1/usage/refresh`, { method: 'POST', headers })).json();
  assert.equal(good.usage.quotaWindows.length, 3);
  assert.ok(good.usage.lastSuccessAt, 'a successful read must record when it happened');

  healthy = false;
  const degraded = await (await fetch(`${workerUrl}/v1/usage/refresh`, { method: 'POST', headers })).json();

  // The windows survive — discarding them would blank the display on any
  // transient failure — but the failure is classified so the UI can mark them.
  assert.equal(degraded.usage.pollErrorKind, 'unauthenticated');
  assert.deepEqual(
    degraded.usage.quotaWindows.map((window) => window.id),
    ['session', 'weekly_all', 'weekly_scoped:fable']
  );
  assert.equal(degraded.usage.lastSuccessAt, good.usage.lastSuccessAt, 'a failed poll must not advance data freshness');
});

test('a failing telemetry source keeps local request history intact', async (t) => {
  const token = 'claude-usage-degraded';
  const home = await claudeHomeWithCredential(t);

  const worker = createWorkerServer({
    token,
    adapter: 'claude-code',
    demoMode: true,
    workspace: process.cwd(),
    dataPath: null,
    claudeHome: home,
    claudeOAuthUsage: true,
    usagePollIntervalMs: 0,
    claudeUsageFetch: () => jsonResponse({ error: 'unauthorized' }, { status: 401 })
  });
  const workerUrl = await listen(worker);
  t.after(() => new Promise((resolve) => worker.close(resolve)));

  const run = await fetch(`${workerUrl}/v1/tasks`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'count my tokens' })
  });
  assert.equal(run.status, 200);
  await run.text();

  const usage = await (await fetch(`${workerUrl}/v1/usage`, { headers: { authorization: `Bearer ${token}` } })).json();

  // The account source is broken and says so, classified so the UI can explain it.
  assert.equal(usage.usage.pollErrorKind, 'unauthenticated');
  assert.deepEqual(usage.usage.quotaWindows, []);

  // Local per-request telemetry is a separate source and must survive.
  assert.equal(usage.usage.totals.requests, 1);
  assert.ok(usage.usage.totals.totalTokens > 0);
  assert.equal(usage.usage.history.length, 1);
});
