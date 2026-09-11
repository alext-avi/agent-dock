import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFleetUsageCache } from '../control-plane/fleet-usage.mjs';

const agents = [
  { id: 'codex', name: 'Codex analyst', adapter: 'codex-cli' },
  { id: 'claude', name: 'Claude reviewer', adapter: 'claude-code' },
  { id: 'open', name: 'OpenCode local', adapter: 'opencode' }
];

function status(agent, provider, capabilities, usage) {
  return {
    agent: { id: agent.id, adapter: { id: agent.adapter, provider } },
    capabilities: { usage: capabilities },
    usage
  };
}

test('fleet usage cache normalizes mixed providers and marks retained provider data stale', () => {
  let now = new Date('2026-09-10T12:00:00.000Z');
  const cache = createFleetUsageCache({ clock: () => now, staleAfterMs: 60_000 });
  cache.observe(agents[0], status(agents[0], 'worker-controlled-provider-text', {
    requestTokens: true, quotaWindows: true, accountActivity: true
  }, {
    updatedAt: '2026-09-10T11:59:30.000Z',
    lastPollAt: '2026-09-10T11:59:45.000Z',
    lastSuccessAt: '2026-09-10T11:59:45.000Z',
    pollError: 'raw provider text must not escape',
    pollErrorKind: null,
    totals: { requests: 3, inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, totalTokens: 15, durationMs: 800 },
    quotaWindows: [{
      id: 'five-hour', label: 'Session', scope: 'primary', usedPercent: 75,
      windowDurationMinutes: 300, resetsAt: Date.parse('2026-09-10T12:20:00.000Z') / 1000, reached: false,
      unrestrictedVendorPayload: 'must not escape'
    }],
    account: { lifetimeTokens: 250, peakDailyTokens: 90, longestRunningTaskSeconds: 7 },
    secret: 'must not escape'
  }));
  cache.observe(agents[1], status(agents[1], 'anthropic', {
    requestTokens: true, quotaWindows: true, accountActivity: false
  }, {
    updatedAt: '2026-09-10T11:58:00.000Z',
    lastPollAt: '2026-09-10T11:59:50.000Z',
    lastSuccessAt: '2026-09-10T11:58:00.000Z',
    pollError: 'Bearer secret-value failed at vendor.example',
    pollErrorKind: 'throttled',
    totals: { requests: 1, totalTokens: 20 },
    quotaWindows: [{
      id: 'weekly', label: 'Weekly', usedPercent: 100, windowDurationMinutes: 10_000,
      resetsAt: Date.parse('2026-09-11T12:00:00.000Z') / 1000, reached: true
    }]
  }));
  cache.observe(agents[2], status(agents[2], 'multi-provider', {
    requestTokens: true, quotaWindows: false, accountActivity: false, monetaryBudget: true
  }, {
    updatedAt: null,
    totals: { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    quotaWindows: [],
    account: null,
    budget: { currency: 'usd', used: 1.25, available: 8.75, limit: 10 }
  }));

  const result = cache.list(agents);
  assert.equal(result.schemaVersion, 1);
  assert.deepEqual(result.cache, { strategy: 'opportunistic', staleAfterSeconds: 60, workerRequestsMade: 0 });

  const codex = result.agents[0];
  assert.equal(codex.provider, 'openai', 'provider identity comes from the registered adapter, not worker text');
  assert.equal(codex.telemetry.state, 'available');
  assert.equal(codex.telemetry.fresh, true);
  assert.equal(codex.totals.totalTokens, 15);
  assert.equal(codex.quotaWindows[0].duration, '5h');
  assert.equal(codex.quotaWindows[0].remainingPercent, 25);
  assert.equal(codex.quotaWindows[0].refresh, 'refreshes in 20 min');
  assert.equal(codex.account.lifetimeTokens, 250);

  const claude = result.agents[1];
  assert.equal(claude.provider, 'anthropic');
  assert.equal(claude.telemetry.state, 'stale');
  assert.equal(claude.telemetry.fresh, false);
  assert.equal(claude.quotaWindows[0].duration, '1w');
  assert.equal(claude.quotaWindows[0].refresh, null, 'stale reset timestamps must not produce a live countdown');
  assert.equal(claude.error, 'Usage source is rate limited');

  const open = result.agents[2];
  assert.equal(open.telemetry.state, 'available');
  assert.equal(open.telemetry.support.quotaWindows, false);
  assert.deepEqual(open.quotaWindows, []);
  assert.equal(open.account, null);
  assert.equal(open.totals.requests, 0, 'a supported zero reading remains a real zero');
  assert.deepEqual(open.budget, { currency: 'USD', used: 1.25, available: 8.75, limit: 10 });

  assert.doesNotMatch(JSON.stringify(result), /secret-value|vendor\.example|unrestrictedVendorPayload|must not escape|worker-controlled-provider-text/);
});

test('fleet usage contains unavailable and unsupported agents without failing the response', () => {
  let now = new Date('2026-09-10T12:00:00.000Z');
  const cache = createFleetUsageCache({ clock: () => now, staleAfterMs: 60_000 });
  const unavailable = { id: 'offline', name: 'Offline worker', adapter: 'codex-cli' };
  const failed = { id: 'failed', name: 'Failed worker', adapter: 'claude-code' };
  const unsupported = { id: 'unsupported', name: 'No telemetry', adapter: 'future-cli' };
  const aging = { id: 'aging', name: 'Old snapshot', adapter: 'opencode' };

  cache.observeError(failed, Object.assign(new Error('http://worker.internal bearer private-value'), { status: 503 }));
  cache.observe(unsupported, status(unsupported, 'future', {
    requestTokens: false, quotaWindows: false, accountActivity: false, monetaryBudget: false
  }, {
    totals: { requests: 99, totalTokens: 99 }, quotaWindows: []
  }));
  cache.observe(aging, status(aging, 'multi-provider', { requestTokens: true }, {
    totals: { requests: 2, totalTokens: 40 }
  }));
  now = new Date('2026-09-10T12:01:01.000Z');

  const result = cache.list([unavailable, failed, unsupported, aging]);
  const unavailableResult = result.agents.find((agent) => agent.agentId === 'offline');
  assert.equal(unavailableResult.telemetry.state, 'unavailable');
  assert.equal(unavailableResult.provider, 'openai', 'known provider identity does not depend on a live worker');
  const failedResult = result.agents.find((agent) => agent.agentId === 'failed');
  assert.equal(failedResult.telemetry.state, 'unavailable');
  assert.equal(failedResult.error, 'Worker usage request returned HTTP 503');
  const unsupportedResult = result.agents.find((agent) => agent.agentId === 'unsupported');
  assert.equal(unsupportedResult.telemetry.state, 'unsupported');
  assert.equal(unsupportedResult.totals, null, 'unsupported telemetry must never be represented as zero');
  assert.equal(result.agents.find((agent) => agent.agentId === 'aging').telemetry.state, 'stale');
  assert.doesNotMatch(JSON.stringify(result), /worker\.internal|private-value/);
});
