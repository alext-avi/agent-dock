import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createControlPlane } from '../control-plane/server.mjs';
import { createWorkerServer } from '../worker/server.mjs';
import { normalizeClaudeEvent } from '../worker/adapters/claude.mjs';
import { normalizeOpenCodeEvent } from '../worker/adapters/opencode.mjs';

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
  assert.deepEqual(initialAgents[0].runtime, {
    binding: 'included-singleton', dedicated: false, credentials: 'worker-local'
  });
  assert.deepEqual(initialAgents[0].modelPolicy, {
    mode: 'provider-default', primary: null, fallbacks: [], externalFallback: false
  });
  assert.equal('workerUrl' in initialAgents[0], false);
  assert.equal('hasWorkerToken' in initialAgents[0], false);
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
  assert.equal('workerUrl' in created, false);
  assert.equal('hasWorkerToken' in created, false);
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
  assert.equal('workerUrl' in patched, false);
  assert.equal('hasWorkerToken' in patched, false);
  assert.equal('workerToken' in patched, false);

  const agentPage = await (await fetch(`${controlUrl}/agents/${created.id}`)).text();
  assert.doesNotMatch(agentPage, /Worker URL|Worker token/);
  assert.match(agentPage, /Tools &amp; MCP/);
  assert.match(agentPage, /Attach data or volume/);

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
    body: JSON.stringify({
      durablePrompt: 'This durable profile comes from the registry.',
      modelPolicy: { mode: 'pinned', primary: 'ollama/qwen3-coder:30b', fallbacks: [], externalFallback: false }
    })
  });
  assert.equal(patch.status, 200);

  const run = await fetch(`${controlUrl}/api/v1/agents/worker-01/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: 'This message is ephemeral.',
      instructions: 'Do not accept this override.',
      modelPolicy: { mode: 'provider-default' }
    })
  });
  assert.equal(run.status, 200);
  await run.text();
  assert.equal(receivedTask.prompt, 'This message is ephemeral.');
  assert.equal(receivedTask.instructions, 'This durable profile comes from the registry.');
  assert.deepEqual(receivedTask.modelPolicy, {
    mode: 'pinned', primary: 'ollama/qwen3-coder:30b', fallbacks: [], externalFallback: false
  });
});

test('worker rejects unauthenticated direct API calls', async (t) => {
  const worker = createWorkerServer({ token: 'correct', demoMode: true, workspace: process.cwd() });
  const workerUrl = await listen(worker);
  t.after(() => new Promise((resolve) => worker.close(resolve)));
  const response = await fetch(`${workerUrl}/v1/status`, { headers: { authorization: 'Bearer wrong' } });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).apiVersion, 'agent-wrapper/v1');
});

test('Claude Code implements the same wrapper contract and normalizes stream usage', async (t) => {
  const token = 'claude-worker-secret';
  const worker = createWorkerServer({ token, adapter: 'claude-code', demoMode: true, workspace: process.cwd() });
  const workerUrl = await listen(worker);
  const control = createControlPlane({
    workerUrl,
    workerToken: token,
    claudeWorkerUrl: workerUrl,
    claudeWorkerToken: token,
    dataPath: null
  });
  const controlUrl = await listen(control);
  t.after(() => Promise.all([
    new Promise((resolve) => control.close(resolve)),
    new Promise((resolve) => worker.close(resolve))
  ]));

  const createdResponse = await fetch(`${controlUrl}/api/v1/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Claude Worker', adapter: 'claude-code' })
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).agent;

  const status = await (await fetch(`${controlUrl}/api/v1/agents/${created.id}/status`)).json();
  assert.equal(status.agent.adapter.id, 'claude-code');
  assert.equal(status.agent.adapter.provider, 'anthropic');
  assert.equal(status.capabilities.authentication.refresh, false);
  assert.equal(status.capabilities.usage.quotaWindows, false);
  assert.equal(status.authentication.method, 'browser_oauth');
  assert.equal(status.authentication.session.canForceRefresh, false);

  const runResponse = await fetch(`${controlUrl}/api/v1/agents/${created.id}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'hello Claude worker' })
  });
  const events = (await runResponse.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events[1].type, 'message.completed');
  assert.equal(events[1].data.text, 'Demo worker received: hello Claude worker');
  assert.ok(events.some((event) => event.type === 'usage.observed'));
  assert.equal(events.at(-1).data.status, 'succeeded');

  const normalized = normalizeClaudeEvent({
    type: 'result',
    usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, output_tokens: 3 }
  });
  assert.deepEqual(normalized.data.request, {
    inputTokens: 17,
    cachedInputTokens: 7,
    outputTokens: 3,
    totalTokens: 20
  });
});

test('OpenCode discovers Ollama and executes a durable pinned model policy', async (t) => {
  const token = 'opencode-worker-secret';
  const temporary = await mkdtemp(join(tmpdir(), 'agent-dock-opencode-'));
  const opencodeConfigPath = join(temporary, 'opencode-provider.json');
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const worker = createWorkerServer({
    token,
    adapter: 'opencode',
    demoMode: true,
    workspace: process.cwd(),
    opencodeConfigPath,
    ollamaModels: [{ name: 'qwen3-coder:30b', contextLength: 32768, capabilities: ['completion', 'tools'] }]
  });
  const workerUrl = await listen(worker);
  const control = createControlPlane({
    workerUrl,
    workerToken: token,
    opencodeWorkerUrl: workerUrl,
    opencodeWorkerToken: token,
    dataPath: null
  });
  const controlUrl = await listen(control);
  t.after(() => Promise.all([
    new Promise((resolve) => control.close(resolve)),
    new Promise((resolve) => worker.close(resolve))
  ]));

  const createdResponse = await fetch(`${controlUrl}/api/v1/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'OpenCode Worker', adapter: 'opencode' })
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).agent;
  const status = await (await fetch(`${controlUrl}/api/v1/agents/${created.id}/status`)).json();
  assert.equal(status.agent.adapter.id, 'opencode');
  assert.equal(status.agent.adapter.provider, 'multi-provider');
  assert.equal(status.authentication.method, 'provider_device_code');
  assert.equal(status.capabilities.usage.accountActivity, false);
  assert.equal(status.capabilities.models.selection, true);

  const providersResponse = await fetch(`${controlUrl}/api/v1/agents/${created.id}/providers`);
  assert.equal(providersResponse.status, 200);
  const providers = await providersResponse.json();
  assert.equal(providers.modelSelection.fallbackPolicy, 'explicit-only');
  assert.equal(providers.connections[0].type, 'ollama');
  assert.equal(providers.connections[0].status, 'ready');
  assert.equal(providers.connections[0].models[0].id, 'ollama/qwen3-coder:30b');
  assert.equal(providers.connections[0].models[0].contextLength, 32768);
  assert.equal('baseUrl' in providers.connections[0], false);
  assert.doesNotMatch(JSON.stringify(providers), /host\.docker\.internal|11434/);
  const generatedConfig = JSON.parse(await readFile(opencodeConfigPath, 'utf8'));
  assert.equal(generatedConfig.provider.ollama.options.baseURL, 'http://host.docker.internal:11434/v1');
  assert.deepEqual(generatedConfig.provider.ollama.models['qwen3-coder:30b'].limit, { context: 32768, output: 8192 });

  const policyResponse = await fetch(`${controlUrl}/api/v1/agents/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      modelPolicy: { mode: 'pinned', primary: 'ollama/qwen3-coder:30b', fallbacks: [], externalFallback: false }
    })
  });
  assert.equal(policyResponse.status, 200);
  assert.equal((await policyResponse.json()).agent.modelPolicy.primary, 'ollama/qwen3-coder:30b');

  const runResponse = await fetch(`${controlUrl}/api/v1/agents/${created.id}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'use the local model' })
  });
  assert.equal(runResponse.status, 200);
  const events = (await runResponse.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events[0].type, 'task.started');
  assert.equal(events[0].data.model, 'ollama/qwen3-coder:30b');
  const usage = await (await fetch(`${controlUrl}/api/v1/agents/${created.id}/usage`)).json();
  assert.equal(usage.usage.lastRequest.model, 'ollama/qwen3-coder:30b');

  const normalized = normalizeOpenCodeEvent({
    type: 'step_finish',
    part: {
      type: 'step-finish',
      tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 80, write: 2 } },
      cost: 0
    }
  });
  assert.deepEqual(normalized.data.request, {
    inputTokens: 182,
    cachedInputTokens: 82,
    outputTokens: 25,
    totalTokens: 207
  });
  assert.equal(normalizeOpenCodeEvent({ type: 'text', part: { type: 'text', text: 'hello' } }).data.text, 'hello');
});
