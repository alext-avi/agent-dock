import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWorkerServer } from '../worker/server.mjs';
import {
  ClaudeUsageError,
  fetchClaudeUsage,
  normalizeClaudeQuotaWindows,
  readClaudeOAuthToken
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
  assert.ok(!JSON.stringify(windows).includes('juniper_tide'));
});

test('Claude usage normalization fails closed on an unrecognized payload', async () => {
  assert.deepEqual(normalizeClaudeQuotaWindows(await fixture('claude-usage-unrecognized')), []);
  assert.deepEqual(normalizeClaudeQuotaWindows({}), []);
  assert.deepEqual(normalizeClaudeQuotaWindows(null), []);
  assert.deepEqual(normalizeClaudeQuotaWindows('nope'), []);
  assert.deepEqual(normalizeClaudeQuotaWindows({ limits: 'not-an-array' }), []);
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
