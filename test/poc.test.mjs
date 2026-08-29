import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createControlPlane } from '../control-plane/server.mjs';
import { createWorkerServer } from '../worker/server.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

test('control plane speaks the vendor-neutral v1 wrapper contract', async (t) => {
  const token = 'test-worker-secret';
  const worker = createWorkerServer({ token, demoMode: true, workspace: process.cwd() });
  const workerUrl = await listen(worker);
  const control = createControlPlane({ workerUrl, workerToken: token });
  const controlUrl = await listen(control);
  t.after(() => Promise.all([
    new Promise((resolve) => control.close(resolve)),
    new Promise((resolve) => worker.close(resolve))
  ]));

  const statusResponse = await fetch(`${controlUrl}/api/v1/status`);
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.apiVersion, 'agent-wrapper/v1');
  assert.equal(status.service, 'agent-wrapper');
  assert.equal(status.agent.adapter.id, 'codex-cli');
  assert.equal(status.agent.adapter.provider, 'openai');
  assert.equal(status.agent.version, 'codex-cli demo');
  assert.equal(status.authentication.authenticated, true);
  assert.equal(status.task.active, null);
  assert.equal(status.usage.totals.requests, 0);
  assert.equal(status.authentication.session.authMode, 'chatgpt');
  assert.equal(status.authentication.session.canForceRefresh, true);
  assert.ok(status.authentication.session.accessTokenExpiresAt);

  const agentsResponse = await fetch(`${controlUrl}/api/v1/agents`);
  assert.equal(agentsResponse.status, 200);
  const initialAgents = (await agentsResponse.json()).agents;
  assert.equal(initialAgents.length, 1);
  assert.equal(initialAgents[0].id, 'worker-01');
  assert.equal(initialAgents[0].hasWorkerToken, true);
  assert.equal('workerToken' in initialAgents[0], false);

  const scopedStatusResponse = await fetch(`${controlUrl}/api/v1/agents/worker-01/status`);
  assert.equal(scopedStatusResponse.status, 200);
  assert.equal((await scopedStatusResponse.json()).apiVersion, 'agent-wrapper/v1');

  const authRefreshResponse = await fetch(`${controlUrl}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(authRefreshResponse.status, 200);
  const authRefresh = await authRefreshResponse.json();
  assert.equal(authRefresh.apiVersion, 'agent-wrapper/v1');
  assert.equal(authRefresh.authentication.session.canForceRefresh, true);
  assert.ok(authRefresh.authentication.session.lastRefreshAt);
  assert.doesNotMatch(JSON.stringify(authRefresh), /access_token|refresh_token|account_id/);

  const workspaceResponse = await fetch(`${controlUrl}/api/v1/workspace`);
  assert.equal(workspaceResponse.status, 200);
  const workspace = await workspaceResponse.json();
  assert.equal(workspace.apiVersion, 'agent-wrapper/v1');
  assert.ok(workspace.workspace.entries.some((entry) => entry.path === 'README.md'));

  const runResponse = await fetch(`${controlUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'hello worker' })
  });
  assert.equal(runResponse.status, 200);
  assert.match(runResponse.headers.get('content-type'), /application\/x-ndjson/);
  const events = (await runResponse.text()).trim().split('\n').map(JSON.parse);
  assert.ok(events.every((event) => event.apiVersion === 'agent-wrapper/v1'));
  assert.equal(events[0].type, 'task.started');
  assert.equal(events[1].type, 'message.completed');
  assert.equal(events[1].data.text, 'Demo worker received: hello worker');
  assert.ok(events.some((event) => event.type === 'usage.observed'));
  assert.ok(events.some((event) => event.type === 'usage.updated'));
  assert.equal(events.at(-1).type, 'task.completed');
  assert.equal(events.at(-1).data.status, 'succeeded');

  const updatedStatus = await (await fetch(`${controlUrl}/api/v1/status`)).json();
  assert.equal(updatedStatus.usage.totals.requests, 1);
  assert.equal(updatedStatus.usage.totals.inputTokens, 12);
  assert.equal(updatedStatus.usage.totals.cachedInputTokens, 3);
  assert.equal(updatedStatus.usage.totals.outputTokens, 8);
  assert.equal(updatedStatus.usage.totals.totalTokens, 20);
  assert.equal(updatedStatus.usage.lastRequest.status, 'succeeded');
  assert.equal(updatedStatus.usage.quotaWindows[0].usedPercent, 18);
  assert.equal(updatedStatus.usage.quotaWindows[0].windowDurationMinutes, 300);
  assert.equal(updatedStatus.usage.account.lifetimeTokens, 20);

  const usageResponse = await fetch(`${controlUrl}/api/v1/usage`);
  assert.equal(usageResponse.status, 200);
  const usage = (await usageResponse.json()).usage;
  assert.equal(usage.history.length, 1);
  assert.equal(usage.quotaWindows[0].scope, 'primary');
  assert.equal(usage.account.peakDailyTokens, 20);
  assert.doesNotMatch(JSON.stringify(usage), /rateLimitsByLimitId|dailyUsageBuckets|longestRunningTurnSec/);

  const createResponse = await fetch(`${controlUrl}/api/v1/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Claude Research',
      description: 'Second registered runtime',
      adapter: 'claude-code',
      durablePrompt: 'Keep research concise.',
      workerUrl,
      workerToken: token
    })
  });
  assert.equal(createResponse.status, 201);
  const created = (await createResponse.json()).agent;
  assert.equal(created.adapter, 'claude-code');
  assert.equal(created.durablePrompt, 'Keep research concise.');
  assert.equal(created.hasWorkerToken, true);
  assert.equal('workerToken' in created, false);

  const patchResponse = await fetch(`${controlUrl}/api/v1/agents/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Claude Researcher', durablePrompt: 'Write concise, cited research.' })
  });
  assert.equal(patchResponse.status, 200);
  const patched = (await patchResponse.json()).agent;
  assert.equal(patched.name, 'Claude Researcher');
  assert.equal(patched.durablePrompt, 'Write concise, cited research.');
  assert.equal('workerToken' in patched, false);

  const deleteResponse = await fetch(`${controlUrl}/api/v1/agents/${created.id}`, { method: 'DELETE' });
  assert.equal(deleteResponse.status, 204);
  assert.equal((await fetch(`${controlUrl}/api/v1/agents/${created.id}`)).status, 404);
});

test('control plane injects the saved prompt and rejects a per-request override', async (t) => {
  let receivedTask = null;
  const token = 'registry-secret';
  const fakeWorker = createServer(async (req, res) => {
    if (req.url === '/v1/tasks' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      receivedTask = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      return res.end(`${JSON.stringify({ apiVersion: 'agent-wrapper/v1', type: 'task.completed', data: { status: 'succeeded' } })}\n`);
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
  });
  const workerUrl = await listen(fakeWorker);
  const control = createControlPlane({ workerUrl, workerToken: token, dataPath: null });
  const controlUrl = await listen(control);
  t.after(() => Promise.all([
    new Promise((resolve) => control.close(resolve)),
    new Promise((resolve) => fakeWorker.close(resolve))
  ]));

  const patch = await fetch(`${controlUrl}/api/v1/agents/worker-01`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ durablePrompt: 'This durable profile comes from the registry.' })
  });
  assert.equal(patch.status, 200);

  const run = await fetch(`${controlUrl}/api/v1/agents/worker-01/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'This message is ephemeral.', instructions: 'Do not accept this override.' })
  });
  assert.equal(run.status, 200);
  await run.text();
  assert.equal(receivedTask.prompt, 'This message is ephemeral.');
  assert.equal(receivedTask.instructions, 'This durable profile comes from the registry.');
});

test('worker rejects unauthenticated direct API calls', async (t) => {
  const worker = createWorkerServer({ token: 'correct', demoMode: true, workspace: process.cwd() });
  const workerUrl = await listen(worker);
  t.after(() => new Promise((resolve) => worker.close(resolve)));
  const response = await fetch(`${workerUrl}/v1/status`, { headers: { authorization: 'Bearer wrong' } });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).apiVersion, 'agent-wrapper/v1');
});
