import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createControlPlane } from '../control-plane/server.mjs';
import { createWorkerServer } from '../worker/server.mjs';
import { DockerRuntimeManager, dockerError } from '../control-plane/docker-runtime.mjs';
import { normalizeClaudeEvent } from '../worker/adapters/claude.mjs';
import { normalizeOpenCodeEvent } from '../worker/adapters/opencode.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function beginPartialJsonRequest(url, { method, first, rest }) {
  let request;
  let ended = false;
  let markSent;
  const sent = new Promise((resolve) => { markSent = resolve; });
  const response = new Promise((resolve, reject) => {
    request = httpRequest(url, {
      method,
      headers: {
        'content-type': 'application/json',
        'transfer-encoding': 'chunked'
      }
    }, (incoming) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = {};
        try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
        resolve({ status: incoming.statusCode, body });
      });
    });
    request.on('error', reject);
    request.write(first, markSent);
  });
  return {
    sent,
    response,
    finish() {
      if (ended) return;
      ended = true;
      request.end(rest);
    },
    abort() {
      ended = true;
      request.destroy();
    }
  };
}

async function within(promise, message, timeoutMs = 2_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function createStatusWorker({ workerId, token, authenticated }) {
  return createServer((req, res) => {
    if (req.url === '/v1/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
    if (req.url === '/v1/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        apiVersion: 'agent-wrapper/v1',
        agent: { id: workerId, adapter: { id: 'claude-code', provider: 'anthropic', displayName: 'Claude Code' } },
        authentication: { authenticated, phase: authenticated ? 'authenticated' : 'unauthenticated' },
        task: { active: null },
        usage: { totals: { requests: 0 }, quotaWindows: [] }
      }));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
}

class FakeRuntimeManager {
  constructor(definitions) {
    this.definitions = [...definitions];
    this.provisioned = [];
    this.started = [];
    this.stopped = [];
    this.destroyed = [];
    this.recreated = [];
    this.createdDataVolumes = [];
    this.deletedDataVolumes = [];
    this.directoryListings = [];
    this.recreateDelay = null;
    this.onRecreate = null;
    this.image = 'agent-dock-worker:v1';
  }

  async provision({ agentId, adapter }) {
    const definition = this.definitions.shift();
    if (!definition) throw new Error('No fake runtime available');
    const suffix = this.provisioned.length + 1;
    const runtime = {
      id: `runtime-${suffix}`,
      adapter,
      kind: 'managed-dedicated',
      managed: true,
      dedicated: true,
      workerId: definition.workerId,
      workerUrl: definition.workerUrl,
      workerToken: definition.token,
      containerId: `container-${suffix}`,
      containerName: `agent-dock-runtime-${suffix}`,
      image: this.image,
      imageId: this.image,
      volumes: {
        auth: `auth-${suffix}`,
        binary: `binary-${suffix}`,
        telemetry: `telemetry-${suffix}`,
        workspace: `workspace-${suffix}`
      },
      appliedAttachmentIds: [],
      workingDirectory: '/workspace',
      state: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      agentId
    };
    this.provisioned.push(runtime);
    return runtime;
  }

  async inspect(runtime) {
    return { state: runtime.state, health: 'healthy', image: runtime.image ?? null, imageId: runtime.imageId ?? null, containerId: runtime.containerId };
  }

  // The tag does not move on a rebuild; the image id does. Mirrors the real
  // manager so drift can be exercised without Docker.
  async currentImageId() { return this.image; }

  // Mirrors the real manager: a new container id, the same name and volumes, and
  // the currently configured image. Volumes are never touched.
  async recreate(runtime, { agentId = null, attachments = [], previousAttachments = attachments } = {}) {
    this.onRecreate?.(runtime);
    if (this.recreateDelay) await this.recreateDelay;
    this.recreated.push({ id: runtime.id, agentId, volumes: runtime.volumes, attachments, previousAttachments });
    return {
      containerId: `container-${runtime.id}-${this.recreated.length}`,
      containerName: runtime.containerName,
      workerUrl: runtime.workerUrl,
      image: this.image,
      imageId: this.image,
      volumes: runtime.volumes,
      appliedAttachmentIds: attachments.map((attachment) => attachment.id),
      workingDirectory: attachments.find((attachment) => attachment.purpose === 'working-directory')?.target ?? '/workspace',
      state: 'starting',
      updatedAt: new Date().toISOString()
    };
  }
  async materializeAttachments({ attachments, sources }) {
    return attachments.map((attachment) => {
      const source = sources.get(attachment.dataSourceId);
      if (!source) throw new Error('Data source missing');
      return {
        ...attachment,
        mount: {
          Type: source.kind === 'managed-volume' ? 'volume' : 'bind',
          Source: source.volumeName ?? `/approved/${source.rootId}/${source.relativePath}`,
          Target: attachment.target,
          ReadOnly: attachment.access === 'read-only'
        }
      };
    });
  }
  async createManagedDataVolume(dataSourceId) {
    const volume = `managed-${dataSourceId}`;
    this.createdDataVolumes.push(volume);
    return volume;
  }
  async deleteManagedDataVolume(dataSourceId, volumeName) {
    this.deletedDataVolumes.push({ dataSourceId, volumeName });
  }
  async listHostDirectories(request) {
    this.directoryListings.push(request);
    const prefix = request.relativePath === '.' ? '' : `${request.relativePath}/`;
    return {
      relativePath: request.relativePath,
      directories: [{ name: 'child', relativePath: `${prefix}child` }],
      truncated: false
    };
  }
  async start(runtime) { runtime.state = 'running'; this.started.push(runtime.id); }
  async stop(runtime) { runtime.state = 'stopped'; this.stopped.push(runtime.id); }
  async destroy(runtime) { this.destroyed.push(runtime.id); }
}

test('control plane speaks the vendor-neutral v1 wrapper contract', async (t) => {
  const token = 'test-worker-secret';
  const worker = createWorkerServer({ token, demoMode: true, workspace: process.cwd() });
  const workerUrl = await listen(worker);
  const control = createControlPlane({
    workerUrl,
    workerToken: token,
    claudeWorkerUrl: workerUrl,
    claudeWorkerToken: token
  });
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
  assert.equal(initialAgents[0].runtime.binding, 'shared-legacy');
  assert.equal(initialAgents[0].runtime.dedicated, false);
  assert.equal(initialAgents[0].runtime.credentials, 'shared-worker-local');
  assert.deepEqual(initialAgents[0].runtime.storage, {
    auth: 'shared', binary: 'shared', telemetry: 'shared', workspace: 'shared', attachments: 0
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
      runtime: { mode: 'attach', id: 'legacy-claude-code' }
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
  assert.match(agentPage, /Mapped folders/);
  assert.match(agentPage, /Map folder/);

  const deleteResponse = await fetch(`${controlUrl}/api/v1/agents/${created.id}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runtimeAction: 'retain' })
  });
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

test('two same-adapter agents receive exclusive runtimes and different authentication states', async (t) => {
  const firstWorker = createStatusWorker({ workerId: 'claude-isolated-1', token: 'token-one', authenticated: true });
  const secondWorker = createStatusWorker({ workerId: 'claude-isolated-2', token: 'token-two', authenticated: false });
  const firstUrl = await listen(firstWorker);
  const secondUrl = await listen(secondWorker);
  const manager = new FakeRuntimeManager([
    { workerId: 'claude-isolated-1', token: 'token-one', workerUrl: firstUrl },
    { workerId: 'claude-isolated-2', token: 'token-two', workerUrl: secondUrl }
  ]);
  const control = createControlPlane({
    workerUrl: firstUrl,
    workerToken: 'legacy-token',
    runtimeManager: manager,
    dataPath: null
  });
  const controlUrl = await listen(control);
  t.after(() => Promise.all([
    new Promise((resolve) => control.close(resolve)),
    new Promise((resolve) => firstWorker.close(resolve)),
    new Promise((resolve) => secondWorker.close(resolve))
  ]));

  const create = (name) => fetch(`${controlUrl}/api/v1/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, adapter: 'claude-code', runtime: { mode: 'provision' } })
  });
  const firstResponse = await create('Claude Isolated One');
  const secondResponse = await create('Claude Isolated Two');
  assert.equal(firstResponse.status, 201);
  assert.equal(secondResponse.status, 201);
  const first = (await firstResponse.json()).agent;
  const second = (await secondResponse.json()).agent;

  assert.notEqual(first.runtime.id, second.runtime.id);
  assert.notEqual(first.runtime.workerId, second.runtime.workerId);
  assert.equal(first.runtime.binding, 'dedicated');
  assert.equal(second.runtime.binding, 'dedicated');
  assert.equal(first.runtime.credentials, 'isolated-worker-local');
  assert.deepEqual(first.runtime.storage, {
    auth: 'isolated', binary: 'isolated', telemetry: 'isolated', workspace: 'isolated', attachments: 0
  });
  assert.doesNotMatch(JSON.stringify([first, second]), /token-one|token-two|auth-1|auth-2|container-1|container-2|127\.0\.0\.1/);
  for (const volumeType of ['auth', 'binary', 'telemetry', 'workspace']) {
    assert.notEqual(manager.provisioned[0].volumes[volumeType], manager.provisioned[1].volumes[volumeType]);
  }

  const firstStatus = await (await fetch(`${controlUrl}/api/v1/agents/${first.id}/status`)).json();
  const secondStatus = await (await fetch(`${controlUrl}/api/v1/agents/${second.id}/status`)).json();
  assert.equal(firstStatus.agent.id, 'claude-isolated-1');
  assert.equal(firstStatus.authentication.authenticated, true);
  assert.equal(secondStatus.agent.id, 'claude-isolated-2');
  assert.equal(secondStatus.authentication.authenticated, false);

  const crossAttach = await fetch(`${controlUrl}/api/v1/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Forbidden Shared Agent',
      adapter: 'claude-code',
      runtime: { mode: 'attach', id: first.runtime.id }
    })
  });
  assert.equal(crossAttach.status, 409);
  assert.match((await crossAttach.json()).error, /already bound/);

  const ambiguousDelete = await fetch(`${controlUrl}/api/v1/agents/${first.id}`, { method: 'DELETE' });
  assert.equal(ambiguousDelete.status, 400);
  const unsafeDelete = await fetch(`${controlUrl}/api/v1/agents/${first.id}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runtimeAction: 'destroy', confirmation: 'wrong-agent' })
  });
  assert.equal(unsafeDelete.status, 400);

  const retain = await fetch(`${controlUrl}/api/v1/agents/${first.id}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runtimeAction: 'retain' })
  });
  assert.equal(retain.status, 204);
  assert.deepEqual(manager.stopped, [first.runtime.id]);
  const retained = (await (await fetch(`${controlUrl}/api/v1/runtimes`)).json()).runtimes.find((runtime) => runtime.id === first.runtime.id);
  assert.equal(retained.binding, 'retained');
  assert.equal(retained.attachmentCount, 0);

  const reattach = await fetch(`${controlUrl}/api/v1/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Claude Reattached',
      adapter: 'claude-code',
      runtime: { mode: 'attach', id: first.runtime.id }
    })
  });
  assert.equal(reattach.status, 201);
  const reattached = (await reattach.json()).agent;
  assert.equal(reattached.runtime.binding, 'attached');
  assert.equal(reattached.runtime.dedicated, true);
  assert.deepEqual(manager.started, [first.runtime.id]);

  const destroy = await fetch(`${controlUrl}/api/v1/agents/${reattached.id}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runtimeAction: 'destroy', confirmation: reattached.id })
  });
  assert.equal(destroy.status, 204);
  assert.deepEqual(manager.destroyed, [first.runtime.id]);
});

test('schema-v1 singleton records migrate to one explicitly shared legacy runtime', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'agent-dock-migration-'));
  const dataPath = join(temporary, 'agents.json');
  const now = new Date().toISOString();
  await writeFile(dataPath, JSON.stringify({
    schemaVersion: 1,
    agents: [
      {
        id: 'claude-old-one', name: 'Claude Old One', adapter: 'claude-code', description: '', durablePrompt: '',
        workerUrl: 'http://shared-claude:7777', workerToken: 'legacy-secret', createdAt: now, updatedAt: now
      },
      {
        id: 'claude-old-two', name: 'Claude Old Two', adapter: 'claude-code', description: '', durablePrompt: '',
        workerUrl: 'http://shared-claude:7777', workerToken: 'legacy-secret', createdAt: now, updatedAt: now
      }
    ]
  }));
  const control = createControlPlane({
    workerUrl: 'http://unused:7777',
    workerToken: 'control-token',
    claudeWorkerUrl: 'http://shared-claude:7777',
    claudeWorkerToken: 'legacy-secret',
    dataPath
  });
  const controlUrl = await listen(control);
  t.after(async () => {
    await new Promise((resolve) => control.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  });

  const listed = (await (await fetch(`${controlUrl}/api/v1/agents`)).json()).agents;
  const migrated = listed.filter((agent) => agent.adapter === 'claude-code');
  assert.equal(migrated.length, 2);
  assert.equal(migrated[0].runtime.id, migrated[1].runtime.id);
  assert.equal(migrated[0].runtime.binding, 'shared-legacy');
  assert.equal(migrated[0].runtime.attachmentCount, 2);
  assert.doesNotMatch(JSON.stringify(migrated), /legacy-secret|shared-claude/);

  const persisted = JSON.parse(await readFile(dataPath, 'utf8'));
  assert.equal(persisted.schemaVersion, 4);
  assert.ok(Array.isArray(persisted.runtimes));
  assert.equal(persisted.agents.filter((agent) => agent.adapter === 'claude-code').every((agent) => !('workerToken' in agent)), true);
});

test('worker rejects unauthenticated direct API calls', async (t) => {
  const worker = createWorkerServer({ token: 'correct', demoMode: true, workspace: process.cwd() });
  const workerUrl = await listen(worker);
  t.after(() => new Promise((resolve) => worker.close(resolve)));
  const response = await fetch(`${workerUrl}/v1/status`, { headers: { authorization: 'Bearer wrong' } });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).apiVersion, 'agent-wrapper/v1');
});

test('worker advertises targeted cancellation and rejects a stale task id', async (t) => {
  const token = 'targeted-cancel-secret';
  const worker = createWorkerServer({ token, demoMode: true, workspace: process.cwd() });
  const workerUrl = await listen(worker);
  t.after(() => new Promise((resolve) => worker.close(resolve)));
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const taskResponse = fetch(`${workerUrl}/v1/tasks`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt: 'remain active long enough to cancel' })
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  let response = await fetch(`${workerUrl}/v1/status`, { headers: { authorization: `Bearer ${token}` } });
  const status = await response.json();
  assert.equal(status.capabilities.tasks.targetedCancellation, true);
  assert.ok(status.task.active?.id);

  response = await fetch(`${workerUrl}/v1/tasks/cancel`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ taskId: 'a-stale-task-id' })
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /no longer active/);

  const events = (await (await taskResponse).text()).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).data.status, 'succeeded', 'a stale cancellation must not affect the active task');
});

test('delegation refuses targeted cancellation against a legacy worker capability set', async (t) => {
  const token = 'legacy-worker-secret';
  let cancelCalls = 0;
  const legacyWorker = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
    if (req.method === 'GET' && req.url === '/v1/status') {
      return res.end(JSON.stringify({
        apiVersion: 'agent-wrapper/v1',
        capabilities: { tasks: { cancellation: true } },
        task: { active: { id: 'worker-task', status: 'running' } }
      }));
    }
    if (req.method === 'POST' && req.url === '/v1/tasks/cancel') cancelCalls += 1;
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: 'not found' }));
  });
  const workerUrl = await listen(legacyWorker);
  let finish;
  const control = createControlPlane({
    workerUrl,
    workerToken: token,
    dataPath: null,
    schedulerEnabled: false,
    delegationDispatch: (task, context) => {
      context.reportWorkerTaskId('worker-task');
      return new Promise((resolve) => { finish = resolve; });
    }
  });
  await listen(control);
  t.after(async () => {
    finish?.({ status: 'succeeded' });
    await new Promise((resolve) => control.close(resolve));
    await new Promise((resolve) => legacyWorker.close(resolve));
  });

  const caller = { id: 'oidc:user', type: 'user', agentId: null, isAdmin: false };
  const submitted = control.delegation.submit({ targetAgentId: 'worker-01', prompt: 'legacy cancellation test' }, caller);
  await assert.rejects(
    control.delegation.cancel(submitted.id, caller),
    (error) => error.status === 409 && /targeted cancellation/.test(error.message)
  );
  assert.equal(cancelCalls, 0, 'the control plane must not send an unsafe cancellation to an old worker');
  finish({ status: 'succeeded' });
  await control.delegation.whenIdle();
});

test('agent deletion is blocked while delegated work is in flight', async (t) => {
  let finish;
  const control = createControlPlane({
    workerUrl: 'http://127.0.0.1:1',
    workerToken: 'unused-worker-secret',
    dataPath: null,
    schedulerEnabled: false,
    delegationDispatch: () => new Promise((resolve) => { finish = resolve; })
  });
  const controlUrl = await listen(control);
  t.after(async () => {
    finish?.({ status: 'succeeded' });
    await new Promise((resolve) => control.close(resolve));
  });

  const caller = { id: 'oidc:user', type: 'user', agentId: null, isAdmin: false };
  control.delegation.submit({ targetAgentId: 'worker-01', prompt: 'keep the target alive' }, caller);
  let response = await fetch(`${controlUrl}/api/v1/agents/worker-01`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runtimeAction: 'retain' })
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /delegated work/);

  finish({ status: 'succeeded' });
  await control.delegation.whenIdle();
  response = await fetch(`${controlUrl}/api/v1/agents/worker-01`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runtimeAction: 'retain' })
  });
  assert.equal(response.status, 204);
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
    body: JSON.stringify({ name: 'Claude Worker', adapter: 'claude-code', runtime: { mode: 'attach', id: 'legacy-claude-code' } })
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
    body: JSON.stringify({ name: 'OpenCode Worker', adapter: 'opencode', runtime: { mode: 'attach', id: 'legacy-opencode' } })
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

test('data-source registry applies scoped mounts, persists them, and enforces exclusive writes', async (t) => {
  const token = 'storage-worker-secret';
  const worker = createStatusWorker({ workerId: 'storage-worker', token, authenticated: true });
  const workerUrl = await listen(worker);
  const manager = new FakeRuntimeManager([
    { workerId: 'storage-worker', workerUrl, token },
    { workerId: 'storage-worker', workerUrl, token }
  ]);
  const temporary = await mkdtemp(join(tmpdir(), 'agent-dock-storage-'));
  const dataPath = join(temporary, 'agents.json');
  const control = createControlPlane({
    workerUrl: 'http://127.0.0.1:1',
    workerToken: 'unused',
    runtimeManager: manager,
    dataPath,
    schedulerEnabled: false,
    attachmentRoots: {
      projects: { label: 'Projects', hostPath: '/Users/operator/Projects', allowWrite: true },
      reference: { label: 'Reference', hostPath: '/Users/operator/Reference', allowWrite: false }
    }
  });
  const controlUrl = await listen(control);
  t.after(() => Promise.all([
    new Promise((resolve) => control.close(resolve)),
    new Promise((resolve) => worker.close(resolve)),
    rm(temporary, { recursive: true, force: true })
  ]));

  const createAgent = async (name) => {
    const response = await fetch(`${controlUrl}/api/v1/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, adapter: 'claude-code', runtime: { mode: 'provision' } })
    });
    assert.equal(response.status, 201);
    return (await response.json()).agent;
  };
  const first = await createAgent('Writer one');
  const second = await createAgent('Writer two');

  let response = await fetch(`${controlUrl}/api/v1/attachment-roots`);
  assert.equal(response.status, 200);
  const rootPayload = await response.json();
  assert.deepEqual(rootPayload.roots, [
    { id: 'projects', label: 'Projects', allowWrite: true },
    { id: 'reference', label: 'Reference', allowWrite: false }
  ]);
  assert.equal(JSON.stringify(rootPayload).includes('/Users/operator'), false);

  response = await fetch(`${controlUrl}/api/v1/attachment-roots/projects/directories?agentId=${encodeURIComponent(first.id)}&path=agent-dock`);
  assert.equal(response.status, 200);
  const directoryPayload = await response.json();
  assert.deepEqual(directoryPayload, {
    root: { id: 'projects', label: 'Projects', allowWrite: true },
    relativePath: 'agent-dock',
    directories: [{ name: 'child', relativePath: 'agent-dock/child' }],
    truncated: false
  });
  assert.deepEqual(manager.directoryListings, [{ rootId: 'projects', relativePath: 'agent-dock', adapter: 'claude-code' }]);
  assert.equal(JSON.stringify(directoryPayload).includes('/Users/operator'), false);

  const createSource = async (body) => {
    const result = await fetch(`${controlUrl}/api/v1/data-sources`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    assert.equal(result.status, 201);
    return (await result.json()).dataSource;
  };
  const project = await createSource({
    id: 'project', name: 'Project', kind: 'host-directory', rootId: 'projects', relativePath: 'agent-dock'
  });
  const child = await createSource({
    id: 'project-child', name: 'Project child', kind: 'host-directory', rootId: 'projects', relativePath: 'agent-dock/packages/ui'
  });
  response = await fetch(`${controlUrl}/api/v1/data-sources/${project.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'renamed-behind-the-registry' })
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /id cannot be changed/);
  const scratch = await createSource({ id: 'scratch', name: 'Scratch', kind: 'managed-volume' });
  assert.deepEqual(manager.createdDataVolumes, ['managed-scratch']);
  response = await fetch(`${controlUrl}/api/v1/data-sources/${scratch.id}`, {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deleteVolume: true, confirmation: scratch.id })
  });
  assert.equal(response.status, 204);
  assert.deepEqual(manager.deletedDataVolumes, [{ dataSourceId: 'scratch', volumeName: 'managed-scratch' }]);
  assert.equal(JSON.stringify(project).includes('/Users/operator'), false);

  response = await fetch(`${controlUrl}/api/v1/agents/${first.id}/attachments`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      source: { name: 'Direct project mapping', rootId: 'projects', relativePath: 'agent-dock' },
      mountName: 'repo', access: 'read-write', purpose: 'working-directory'
    })
  });
  assert.equal(response.status, 201);
  const firstAttachment = (await response.json()).attachment;
  assert.equal(firstAttachment.target, '/data/repo');
  assert.equal(manager.recreated.at(-1).attachments[0].mount.Source, '/approved/projects/agent-dock');
  assert.equal(manager.recreated.at(-1).attachments[0].mount.ReadOnly, false);

  const firstAfterMount = (await (await fetch(`${controlUrl}/api/v1/agents/${first.id}`)).json()).agent;
  assert.equal(firstAfterMount.runtime.storage.attachments, 1);
  assert.equal(firstAfterMount.runtime.workingDirectory, '/data/repo');

  const recreatesBeforeConflict = manager.recreated.length;
  response = await fetch(`${controlUrl}/api/v1/agents/${second.id}/attachments`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      source: { name: 'Rejected direct mapping', rootId: 'projects', relativePath: 'agent-dock/packages/ui' },
      mountName: 'child', access: 'read-write', purpose: 'data'
    })
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /agent/);
  assert.equal(manager.recreated.length, recreatesBeforeConflict, 'a rejected write lease replaced a container');
  const sourcesAfterConflict = await (await fetch(`${controlUrl}/api/v1/data-sources`)).json();
  assert.equal(sourcesAfterConflict.dataSources.some((source) => source.name === 'Rejected direct mapping'), false);

  response = await fetch(`${controlUrl}/api/v1/agents/${first.id}/attachments/${firstAttachment.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ access: 'read-only' })
  });
  assert.equal(response.status, 200);
  assert.equal(manager.recreated.at(-1).attachments[0].mount.ReadOnly, true);

  response = await fetch(`${controlUrl}/api/v1/agents/${second.id}/attachments`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      dataSourceId: child.id, mountName: 'child', access: 'read-write', purpose: 'data'
    })
  });
  assert.equal(response.status, 201, 'a read-only overlapping mount incorrectly held the write lease');

  response = await fetch(`${controlUrl}/api/v1/agents/${first.id}`, {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runtimeAction: 'retain' })
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /Detach every data source/);

  response = await fetch(`${controlUrl}/api/v1/agents/${first.id}/attachments/${firstAttachment.id}`, { method: 'DELETE' });
  assert.equal(response.status, 204);
  const afterDetach = await (await fetch(`${controlUrl}/api/v1/agents/${first.id}/attachments`)).json();
  assert.deepEqual(afterDetach.attachments, []);
  assert.equal(afterDetach.workingDirectory, '/workspace');
  const sourcesAfterDetach = await (await fetch(`${controlUrl}/api/v1/data-sources`)).json();
  assert.equal(sourcesAfterDetach.dataSources.some((source) => source.name === 'Direct project mapping'), false);

  const persisted = JSON.parse(await readFile(dataPath, 'utf8'));
  assert.equal(persisted.schemaVersion, 4);
  assert.equal(persisted.dataSources.length, 2);
  assert.equal(persisted.dataAttachments.length, 1);
  assert.equal(JSON.stringify(persisted).includes('/Users/operator/Projects'), false, 'deployment roots leaked into the registry');
});

test('an inline attachment persistence failure restores the runtime without leaking its provisional source', async (t) => {
  const token = 'storage-rollback-secret';
  const worker = createStatusWorker({ workerId: 'rollback-worker', token, authenticated: true });
  const workerUrl = await listen(worker);
  const manager = new FakeRuntimeManager([{ workerId: 'rollback-worker', workerUrl, token }]);
  const temporary = await mkdtemp(join(tmpdir(), 'agent-dock-storage-rollback-'));
  const registryDirectory = join(temporary, 'registry');
  const dataPath = join(registryDirectory, 'agents.json');
  const control = createControlPlane({
    workerUrl: 'http://127.0.0.1:1',
    workerToken: 'unused',
    runtimeManager: manager,
    dataPath,
    schedulerEnabled: false,
    attachmentRoots: { projects: { label: 'Projects', hostPath: '/srv/projects', allowWrite: true } }
  });
  const controlUrl = await listen(control);
  t.after(() => Promise.all([
    new Promise((resolve) => control.close(resolve)),
    new Promise((resolve) => worker.close(resolve)),
    rm(temporary, { recursive: true, force: true })
  ]));

  let response = await fetch(`${controlUrl}/api/v1/agents`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      name: 'Rollback agent', adapter: 'claude-code', runtime: { mode: 'provision' }
    })
  });
  const agent = (await response.json()).agent;
  await rm(registryDirectory, { recursive: true, force: true });
  await writeFile(registryDirectory, 'blocks the registry directory');
  response = await fetch(`${controlUrl}/api/v1/agents/${agent.id}/attachments`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      source: { name: 'Rollback source', rootId: 'projects', relativePath: 'repo' },
      mountName: 'repo', access: 'read-write', purpose: 'working-directory'
    })
  });
  assert.equal(response.status, 500);
  assert.equal(manager.recreated.length, 2, 'the live runtime was not rolled back after the registry write failed');
  assert.equal(manager.recreated[0].attachments.length, 1);
  assert.equal(manager.recreated[1].attachments.length, 0);

  const state = await (await fetch(`${controlUrl}/api/v1/agents/${agent.id}/attachments`)).json();
  assert.deepEqual(state.attachments, []);
  assert.equal(state.workingDirectory, '/workspace');
  const provisionalSourceId = manager.recreated[0].attachments[0].dataSourceId;
  assert.equal((await fetch(`${controlUrl}/api/v1/data-sources/${provisionalSourceId}`)).status, 404);
});

test('simultaneous attachment requests cannot both acquire one write lease', async (t) => {
  const token = 'storage-concurrency-secret';
  const worker = createStatusWorker({ workerId: 'concurrency-worker', token, authenticated: true });
  const workerUrl = await listen(worker);
  const manager = new FakeRuntimeManager([
    { workerId: 'concurrency-worker', workerUrl, token },
    { workerId: 'concurrency-worker', workerUrl, token }
  ]);
  const control = createControlPlane({
    workerUrl: 'http://127.0.0.1:1',
    workerToken: 'unused',
    runtimeManager: manager,
    dataPath: null,
    schedulerEnabled: false,
    attachmentRoots: { projects: { label: 'Projects', hostPath: '/srv/projects', allowWrite: true } }
  });
  const controlUrl = await listen(control);
  t.after(() => Promise.all([
    new Promise((resolve) => control.close(resolve)),
    new Promise((resolve) => worker.close(resolve))
  ]));

  const agents = await Promise.all(['One', 'Two'].map(async (name) => {
    const response = await fetch(`${controlUrl}/api/v1/agents`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        name, adapter: 'claude-code', runtime: { mode: 'provision' }
      })
    });
    return (await response.json()).agent;
  }));
  let response = await fetch(`${controlUrl}/api/v1/data-sources`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      id: 'shared-repo', name: 'Shared repo', kind: 'host-directory', rootId: 'projects', relativePath: 'shared'
    })
  });
  assert.equal(response.status, 201);

  const results = await Promise.all(agents.map((agent, index) => fetch(`${controlUrl}/api/v1/agents/${agent.id}/attachments`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      dataSourceId: 'shared-repo', mountName: `repo-${index}`, access: 'read-write', purpose: 'data'
    })
  })));
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  assert.equal(manager.recreated.length, 1, 'both concurrent requests replaced a runtime');
});

test('disjoint agents replace their containers concurrently and serialize only registry commits', async (t) => {
  const token = 'storage-parallel-secret';
  const worker = createStatusWorker({ workerId: 'parallel-worker', token, authenticated: true });
  const workerUrl = await listen(worker);
  const manager = new FakeRuntimeManager([
    { workerId: 'parallel-worker', workerUrl, token },
    { workerId: 'parallel-worker', workerUrl, token }
  ]);
  const control = createControlPlane({
    workerUrl: 'http://127.0.0.1:1',
    workerToken: 'unused',
    runtimeManager: manager,
    dataPath: null,
    schedulerEnabled: false,
    attachmentRoots: { projects: { label: 'Projects', hostPath: '/srv/projects', allowWrite: true } }
  });
  const controlUrl = await listen(control);
  let releaseRecreates;
  const recreateDelay = new Promise((resolve) => { releaseRecreates = resolve; });
  t.after(() => {
    releaseRecreates?.();
    return Promise.all([
      new Promise((resolve) => control.close(resolve)),
      new Promise((resolve) => worker.close(resolve))
    ]);
  });

  const agents = await Promise.all(['Parallel one', 'Parallel two'].map(async (name) => {
    const response = await fetch(`${controlUrl}/api/v1/agents`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        name, adapter: 'claude-code', runtime: { mode: 'provision' }
      })
    });
    return (await response.json()).agent;
  }));
  const sources = [];
  for (const [index, relativePath] of ['repo-one', 'repo-two'].entries()) {
    const response = await fetch(`${controlUrl}/api/v1/data-sources`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        id: `parallel-${index}`, name: `Parallel ${index}`, kind: 'host-directory', rootId: 'projects', relativePath
      })
    });
    sources.push((await response.json()).dataSource);
  }

  manager.recreateDelay = recreateDelay;
  let markBothStarted;
  const bothStarted = new Promise((resolve) => { markBothStarted = resolve; });
  const started = new Set();
  manager.onRecreate = (runtime) => {
    started.add(runtime.id);
    if (started.size === 2) markBothStarted();
  };
  const requests = agents.map((agent, index) => fetch(`${controlUrl}/api/v1/agents/${agent.id}/attachments`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      dataSourceId: sources[index].id, mountName: `repo-${index}`, access: 'read-write', purpose: 'data'
    })
  }));

  await Promise.race([
    bothStarted,
    new Promise((_, reject) => setTimeout(() => reject(new Error('unrelated runtime replacements were serialized')), 500))
  ]);
  const sourceMutation = await fetch(`${controlUrl}/api/v1/data-sources/${sources[0].id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Must wait' })
  });
  assert.equal(sourceMutation.status, 409, 'a source changed while its replacement container was in flight');
  releaseRecreates();
  assert.deepEqual((await Promise.all(requests)).map((response) => response.status), [201, 201]);
});

test('caller-paced data-source mutations cannot overtake attachment reservations', async (t) => {
  const token = 'storage-source-race-secret';
  const worker = createStatusWorker({ workerId: 'source-race-worker', token, authenticated: true });
  const workerUrl = await listen(worker);
  const manager = new FakeRuntimeManager([{ workerId: 'source-race-worker', workerUrl, token }]);
  const control = createControlPlane({
    workerUrl: 'http://127.0.0.1:1',
    workerToken: 'unused',
    runtimeManager: manager,
    dataPath: null,
    schedulerEnabled: false,
    attachmentRoots: { projects: { label: 'Projects', hostPath: '/srv/projects', allowWrite: true } }
  });
  const controlUrl = await listen(control);
  let releaseRecreate;
  const partialRequests = [];
  t.after(() => {
    releaseRecreate?.();
    for (const partial of partialRequests) partial.abort();
    return Promise.all([
      new Promise((resolve) => control.close(resolve)),
      new Promise((resolve) => worker.close(resolve))
    ]);
  });

  const agent = (await (await fetch(`${controlUrl}/api/v1/agents`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      name: 'Source race', adapter: 'claude-code', runtime: { mode: 'provision' }
    })
  })).json()).agent;
  let response = await fetch(`${controlUrl}/api/v1/data-sources`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      id: 'source-race', name: 'Source race', kind: 'host-directory', rootId: 'projects', relativePath: 'repo'
    })
  });
  assert.equal(response.status, 201);

  async function raceMutationWithAttachment({ method, first, rest, mountName }) {
    const mutation = beginPartialJsonRequest(`${controlUrl}/api/v1/data-sources/source-race`, { method, first, rest });
    partialRequests.push(mutation);
    await within(mutation.sent, `${method} partial request never reached the socket`);
    // The first chunk has reached the socket. Give the server one event-loop
    // turn to enter readJson and block on the deliberately unfinished body.
    await new Promise((resolve) => setImmediate(resolve));

    let markRecreateStarted;
    const recreateStarted = new Promise((resolve) => { markRecreateStarted = resolve; });
    manager.recreateDelay = new Promise((resolve) => { releaseRecreate = resolve; });
    manager.onRecreate = markRecreateStarted;
    const attachment = fetch(`${controlUrl}/api/v1/agents/${agent.id}/attachments`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        dataSourceId: 'source-race', mountName, access: 'read-write', purpose: 'data'
      })
    }).then(async (result) => ({ status: result.status, body: await result.json() }));
    const firstOutcome = await within(Promise.race([
      recreateStarted.then(() => ({ kind: 'recreate' })),
      attachment.then((result) => ({ kind: 'response', result }))
    ]), `${method} attachment never reached runtime replacement`);
    assert.equal(
      firstOutcome.kind,
      'recreate',
      `${method} attachment failed before runtime replacement: ${JSON.stringify(firstOutcome.result)}`
    );
    mutation.finish();
    const mutationResult = await within(mutation.response, `${method} did not finish after its body was released`);
    assert.equal(mutationResult.status, 409, `${method} passed a reservation created while its body was streaming`);
    assert.match(mutationResult.body.error, /in-flight attachment change/);
    releaseRecreate();
    releaseRecreate = null;
    manager.recreateDelay = null;
    manager.onRecreate = null;
    const attachmentResponse = await within(attachment, `${method} attachment did not finish after runtime release`);
    assert.equal(attachmentResponse.status, 201);
    return attachmentResponse.body.attachment;
  }

  const patchedRace = await raceMutationWithAttachment({
    method: 'PATCH',
    first: '{"relativePath":',
    rest: '"moved"}',
    mountName: 'patch-race'
  });
  response = await fetch(`${controlUrl}/api/v1/data-sources/source-race`);
  assert.equal((await response.json()).dataSource.root.relativePath, 'repo', 'the rejected PATCH changed the source');
  response = await fetch(`${controlUrl}/api/v1/agents/${agent.id}/attachments/${patchedRace.id}`, { method: 'DELETE' });
  assert.equal(response.status, 204);
  response = await fetch(`${controlUrl}/api/v1/data-sources/source-race`);
  assert.equal(response.status, 200, 'detaching a shared source removed it before the DELETE race');

  await raceMutationWithAttachment({ method: 'DELETE', first: '{', rest: '}', mountName: 'delete-race' });
  response = await fetch(`${controlUrl}/api/v1/data-sources/source-race`);
  assert.equal(response.status, 200, 'the rejected DELETE orphaned the live attachment');
});

test('a task cannot start while its runtime mount set is being replaced', async (t) => {
  const token = 'storage-task-race-secret';
  const worker = createStatusWorker({ workerId: 'task-race-worker', token, authenticated: true });
  const workerUrl = await listen(worker);
  const manager = new FakeRuntimeManager([{ workerId: 'task-race-worker', workerUrl, token }]);
  const control = createControlPlane({
    workerUrl: 'http://127.0.0.1:1',
    workerToken: 'unused',
    runtimeManager: manager,
    dataPath: null,
    schedulerEnabled: false,
    attachmentRoots: { projects: { label: 'Projects', hostPath: '/srv/projects', allowWrite: true } }
  });
  const controlUrl = await listen(control);
  t.after(() => Promise.all([
    new Promise((resolve) => control.close(resolve)),
    new Promise((resolve) => worker.close(resolve))
  ]));

  let response = await fetch(`${controlUrl}/api/v1/agents`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      name: 'Task race', adapter: 'claude-code', runtime: { mode: 'provision' }
    })
  });
  const agent = (await response.json()).agent;
  response = await fetch(`${controlUrl}/api/v1/data-sources`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      id: 'task-race-source', name: 'Task race source', kind: 'host-directory', rootId: 'projects', relativePath: 'repo'
    })
  });
  assert.equal(response.status, 201);

  let releaseRecreate;
  let markStarted;
  t.after(() => releaseRecreate?.());
  manager.recreateDelay = new Promise((resolve) => { releaseRecreate = resolve; });
  const recreateStarted = new Promise((resolve) => { markStarted = resolve; });
  manager.onRecreate = markStarted;
  const attachmentRequest = fetch(`${controlUrl}/api/v1/agents/${agent.id}/attachments`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      dataSourceId: 'task-race-source', mountName: 'repo', access: 'read-write', purpose: 'working-directory'
    })
  });
  await recreateStarted;

  const taskResponse = await fetch(`${controlUrl}/api/v1/agents/${agent.id}/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'must not start' })
  });
  assert.equal(taskResponse.status, 409);
  assert.match((await taskResponse.json()).error, /runtime storage reconfiguration/);
  releaseRecreate();
  assert.equal((await attachmentRequest).status, 201);
});


test('refreshing a runtime replaces its container while retaining every volume', async (t) => {
  const token = 'refresh-worker-secret';
  const worker = createStatusWorker({ workerId: 'refresh-worker', token, authenticated: true });
  const workerUrl = await listen(worker);
  const manager = new FakeRuntimeManager([{ workerId: 'refresh-worker', workerUrl, token }]);
  const control = createControlPlane({
    workerUrl: 'http://127.0.0.1:1',
    workerToken: 'unused',
    runtimeManager: manager,
    dataPath: null
  });
  const controlUrl = await listen(control);
  t.after(() => Promise.all([
    new Promise((resolve) => control.close(resolve)),
    new Promise((resolve) => worker.close(resolve))
  ]));

  const created = (await (await fetch(`${controlUrl}/api/v1/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Refreshable', adapter: 'claude-code', runtime: { mode: 'provision' } })
  })).json()).agent;

  const before = created.runtime;
  assert.equal(before.managed, true);

  // A newer image is configured, exactly as it would be after a rebuild.
  manager.image = 'agent-dock-worker:v2';

  const response = await fetch(`${controlUrl}/api/v1/agents/${created.id}/runtime/refresh`, { method: 'POST' });
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.refreshed, true);
  assert.equal(body.runtime.image, 'agent-dock-worker:v2', 'the runtime did not move onto the current image');
  assert.equal(body.runtime.outdated, false, 'the response still reported drift it had just resolved');
  assert.equal(body.runtime.id, before.id, 'refreshing must not change runtime identity');
  assert.equal(body.runtime.binding, 'dedicated', 'exclusivity must survive a refresh');
  assert.equal(body.runtime.attachmentCount, 1);
  assert.equal(body.mcpReapplied, false, 'the stub worker unexpectedly accepted MCP configuration');
  assert.match(body.runtime.lastError, /MCP configuration could not be re-applied/);
  const afterFailedReapply = (await (await fetch(`${controlUrl}/api/v1/agents/${created.id}`)).json()).agent;
  assert.equal(
    afterFailedReapply.runtime.lastError,
    body.runtime.lastError,
    'the refresh failure disappeared after the mutating response'
  );

  // The credential lives in the auth volume. Retaining it is the entire point:
  // a refresh that dropped it would force a fresh provider login.
  assert.equal(manager.recreated.length, 1);
  assert.deepEqual(manager.recreated[0].volumes, manager.provisioned[0].volumes);
  assert.equal(manager.destroyed.length, 0, 'a refresh must never destroy volumes');
  assert.equal(manager.recreated[0].agentId, created.id);

  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes(token), 'refresh response disclosed the worker token');
  assert.ok(!serialized.includes(workerUrl), 'refresh response disclosed the worker URL');
});

test('a runtime refresh is refused while a task is running and for unmanaged runtimes', async (t) => {
  const token = 'busy-worker-secret';
  const busy = createServer((req, res) => {
    if (req.url === '/v1/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      apiVersion: 'agent-wrapper/v1',
      agent: { id: 'busy-worker', adapter: { id: 'claude-code', provider: 'anthropic', displayName: 'Claude Code' } },
      authentication: { authenticated: true, phase: 'authenticated' },
      task: { active: { id: 'task-1', status: 'running' } },
      usage: { totals: { requests: 0 }, quotaWindows: [] }
    }));
  });
  const workerUrl = await listen(busy);
  const manager = new FakeRuntimeManager([{ workerId: 'busy-worker', workerUrl, token }]);
  const control = createControlPlane({
    workerUrl,
    workerToken: token,
    claudeWorkerUrl: workerUrl,
    claudeWorkerToken: token,
    runtimeManager: manager,
    dataPath: null
  });
  const controlUrl = await listen(control);
  t.after(() => Promise.all([
    new Promise((resolve) => control.close(resolve)),
    new Promise((resolve) => busy.close(resolve))
  ]));

  const managed = (await (await fetch(`${controlUrl}/api/v1/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Busy', adapter: 'claude-code', runtime: { mode: 'provision' } })
  })).json()).agent;

  const refused = await fetch(`${controlUrl}/api/v1/agents/${managed.id}/runtime/refresh`, { method: 'POST' });
  assert.equal(refused.status, 409, 'a refresh must not interrupt a running task');
  assert.equal(manager.recreated.length, 0);

  // A bootstrap runtime is not ours to replace.
  const legacy = (await (await fetch(`${controlUrl}/api/v1/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Legacy', adapter: 'claude-code', runtime: { mode: 'attach', id: 'legacy-claude-code' } })
  })).json()).agent;

  const unmanaged = await fetch(`${controlUrl}/api/v1/agents/${legacy.id}/runtime/refresh`, { method: 'POST' });
  assert.equal(unmanaged.status, 409);
  assert.equal(manager.recreated.length, 0);
});


// The container spec is shared by provisioning and refreshing, so it is the one
// place where a silent omission changes every runtime the system creates. The
// FakeRuntimeManager cannot catch that — it fabricates its own shape — so this
// exercises the real manager with the network pinned so it needs no Docker.
// A module added to the control plane and left out of its Dockerfile is not a
// build failure. The image starts, dies on the first import, and the whole
// stack is down — which is how this was found, after the tests were green.
// A form control's `pattern` is compiled as a unicode-sets regular expression,
// where an unescaped `-` inside a character class is a syntax error. The browser
// reports it somewhere no test watches and then drops the constraint, so the
// field silently validates nothing while looking entirely normal. Compiling them
// the way the browser does is the only cheap way to see it.
// The wrapping key unwraps every stored credential, including ones belonging to
// agents on other runtimes. A container that runs an agent is a container a
// prompt injection can read `env` from, so the key crossing that boundary would
// turn "protects a copied backup" into protecting nothing.
test('the credential wrapping key is never given to a container that runs an agent', async () => {
  const compose = await readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  // Split on the characters Compose actually allows in a service key. A narrower
  // pattern silently absorbs an unmatched service into the chunk before it, and
  // since control-plane is first in the file, a service declared after it lands
  // inside the one chunk this loop skips — so the key would go unseen.
  const services = compose.split(/\n  (?=[A-Za-z0-9][A-Za-z0-9_.-]*:\n)/);
  for (const service of services) {
    const name = service.trimStart().split(':')[0];
    if (name === 'services' || name === 'control-plane') continue;
    assert.ok(
      !service.includes('CREDENTIAL_ENCRYPTION_KEY'),
      `${name} is given CREDENTIAL_ENCRYPTION_KEY; only the control plane may hold it`
    );
  }
  assert.ok(compose.includes('CREDENTIAL_ENCRYPTION_KEY'), 'the control plane is no longer given the key at all');
});

test('every form pattern compiles the way a browser compiles it', async () => {
  const markup = await readFile(new URL('../control-plane/public/index.html', import.meta.url), 'utf8');
  const patterns = [...markup.matchAll(/pattern="([^"]+)"/g)].map(([, value]) => value);
  assert.ok(patterns.length > 0, 'no pattern attributes found; this test has stopped covering anything');
  for (const pattern of patterns) {
    assert.doesNotThrow(() => new RegExp(pattern, 'v'), `pattern ${pattern} does not compile with the v flag`);
  }
});

// Covers every image, not just the control plane's: the same omission in the
// three worker Dockerfiles took down the whole fleet after the control-plane
// case had already been fixed and tested.
for (const [label, directory, dockerfile] of [
  ['control plane', '../control-plane/', 'Dockerfile'],
  ['codex worker', '../worker/', 'Dockerfile'],
  ['claude worker', '../worker/', 'Dockerfile.claude'],
  ['opencode worker', '../worker/', 'Dockerfile.opencode']
]) {
  test(`the ${label} image ships every module its entrypoint imports`, async () => {
    const root = new URL(directory, import.meta.url);
    const recipe = await readFile(new URL(dockerfile, root), 'utf8');
    const copied = recipe
      .split('\n')
      .filter((line) => line.startsWith('COPY '))
      .flatMap((line) => line.slice(5).trim().split(/\s+/).filter((entry) => !entry.startsWith('--')).slice(0, -1));

    // Resolve each specifier against the file that imports it, not against the
    // image root — nested modules reach siblings with ../ and would otherwise
    // resolve to paths that do not exist.
    const seen = new Set();
    const pending = [new URL('server.mjs', root)];
    while (pending.length) {
      const moduleUrl = pending.pop();
      const name = decodeURIComponent(moduleUrl.href.slice(root.href.length));
      if (seen.has(name)) continue;
      seen.add(name);
      const source = await readFile(moduleUrl, 'utf8');
      for (const [, specifier] of source.matchAll(/from '(\.[^']+)'/g)) {
        pending.push(new URL(specifier, moduleUrl));
      }
    }

    for (const name of seen) {
      const topLevel = name.includes('/') ? name.split('/')[0] : null;
      // An entry may be root-relative once a build context is the repository
      // root, so compare on the basename of the glob as well as the literal
      // entry, and let a copied directory cover the modules inside it.
      const shipped = copied.some((entry) => {
        const tail = entry.split('/').pop();
        if (entry === name || tail === name) return true;
        if (tail === '*.mjs' && name.endsWith('.mjs') && !name.includes('/')) return true;
        if (topLevel && (entry === topLevel || tail === topLevel)) return true;
        return false;
      });
      assert.ok(shipped, `${name} is imported by the ${label} but never copied into its image`);
    }
  });
}

test('the shared container spec carries every setting a worker needs', async () => {
  const manager = new DockerRuntimeManager({
    network: 'test-net',
    socketPath: '/nonexistent.sock',
    images: { 'claude-code': 'agent-dock-worker-claude:test' },
    mcpAllowedCommands: 'npx,uvx',
    usagePollIntervalMs: 60_000,
    allowUnsandboxed: '1'
  });

  const volumes = { auth: 'v-auth', binary: 'v-bin', telemetry: 'v-data', workspace: 'v-work' };
  const { image, body } = await manager.containerSpec({
    adapter: 'claude-code',
    workerId: 'worker-abc',
    workerToken: 'token-abc',
    volumes,
    labels: { 'com.agent-dock.managed': 'true' }
  });

  assert.equal(image, 'agent-dock-worker-claude:test');
  const env = Object.fromEntries(body.Env.map((entry) => {
    const index = entry.indexOf('=');
    return [entry.slice(0, index), entry.slice(index + 1)];
  }));

  // Every variable the worker reads must be present. Dropping one during a
  // refactor is invisible until the feature that depends on it stops working.
  for (const key of [
    'PORT',
    'WORKER_TOKEN',
    'WORKER_AUTH_MODE',
    'AGENT_ID',
    'ALLOW_UNSANDBOXED',
    'AGENT_DATA_PATH',
    'USAGE_POLL_INTERVAL_MS',
    'MCP_ALLOWED_COMMANDS',
    'AGENT_ADAPTER',
    'CLAUDE_VERSION'
  ]) {
    assert.ok(key in env, `${key} is missing from the container environment`);
  }
  assert.equal(env.MCP_ALLOWED_COMMANDS, 'npx,uvx');

  // Connector secrets reach a runtime by namespace; nothing outside it does.
  // Without this the MCP_SECRET_ namespace has no delivery path and a connector
  // credential cannot be provisioned at all.
  process.env.MCP_SECRET_TEST_CONNECTOR = 'connector-value';
  process.env.NOT_A_CONNECTOR_SECRET = 'should-not-cross';
  try {
    const { body: forwarded } = await manager.containerSpec({
      adapter: 'claude-code',
      workerId: 'worker-abc',
      workerToken: 'token-abc',
      volumes,
      labels: {}
    });
    const forwardedEnv = Object.fromEntries(forwarded.Env.map((entry) => {
      const index = entry.indexOf('=');
      return [entry.slice(0, index), entry.slice(index + 1)];
    }));
    assert.equal(forwardedEnv.MCP_SECRET_TEST_CONNECTOR, 'connector-value');
    assert.equal(forwardedEnv.NOT_A_CONNECTOR_SECRET, undefined, 'a non-namespaced variable crossed into a runtime');
  } finally {
    delete process.env.MCP_SECRET_TEST_CONNECTOR;
    delete process.env.NOT_A_CONNECTOR_SECRET;
  }
  assert.equal(env.WORKER_TOKEN, 'token-abc');
  assert.equal(env.WORKER_AUTH_MODE, 'jwt');
  assert.equal(env.AGENT_ID, 'worker-abc');

  // All four private volumes are mounted, and nothing from the host is.
  const mounts = body.HostConfig.Mounts;
  assert.equal(mounts.length, 4);
  assert.deepEqual(mounts.map((mount) => mount.Source).sort(), Object.values(volumes).sort());
  assert.ok(mounts.every((mount) => mount.Type === 'volume'), 'a bind mount reached a managed runtime');
  assert.equal(body.HostConfig.NetworkMode, 'test-net');
  assert.equal(body.User, '10001:10001', 'the worker UID drifted from the attachment validator UID');
  assert.ok(!body.HostConfig.Privileged);
});

test('Docker errors keep host-only details out of public messages', () => {
  const error = dockerError(500, JSON.stringify({ message: 'bind source path does not exist: /Users/operator/Projects/private' }), '/containers/create');
  assert.equal(error.status, 502);
  assert.match(error.message, /status 500/);
  assert.doesNotMatch(error.message, /Users\/operator/);
  assert.match(error.dockerMessage, /Users\/operator/);
  assert.equal(JSON.stringify({ error: error.message }).includes('/Users/operator'), false);
});

test('the attachment validator image is pulled once when a fresh engine lacks it', async () => {
  const manager = new DockerRuntimeManager({ network: 'test-net', socketPath: '/nonexistent.sock' });
  let inspections = 0;
  let pulls = 0;
  manager.request = async (method, path) => {
    if (method === 'GET' && path.startsWith('/images/')) {
      inspections += 1;
      if (inspections === 1) throw dockerError(404, '{"message":"No such image"}', path);
      return { Id: 'sha256:validator' };
    }
    if (method === 'POST' && path.startsWith('/images/create?')) {
      pulls += 1;
      return null;
    }
    throw new Error(`unexpected Docker call ${method} ${path}`);
  };

  await Promise.all([
    manager.ensureAttachmentValidatorImage(),
    manager.ensureAttachmentValidatorImage()
  ]);
  await manager.ensureAttachmentValidatorImage();
  assert.equal(pulls, 1);
  assert.equal(inspections, 2);
});

test('runtime replacement revalidates host mounts only after the old agent is gone', async () => {
  const manager = new DockerRuntimeManager({ network: 'test-net', socketPath: '/nonexistent.sock' });
  const events = [];
  manager.containerSpec = async ({ attachments }) => ({ image: 'worker:test', body: { attachments } });
  manager.resolveContainer = async () => ({ id: 'old-container' });
  manager.validateHostDirectory = async () => {
    events.push('validate');
    return '/approved/projects/repo';
  };
  manager.request = async (method, path, body) => {
    if (method === 'DELETE' && path.startsWith('/containers/old-container')) {
      events.push('delete-old');
      return null;
    }
    if (method === 'POST' && path.startsWith('/containers/create?')) {
      events.push('create-new');
      assert.equal(body.attachments[0].mount.Source, '/approved/projects/repo');
      return { Id: 'new-container' };
    }
    if (method === 'POST' && path === '/containers/new-container/start') return null;
    if (method === 'GET' && path === '/containers/new-container/json') return { Image: 'sha256:worker' };
    throw new Error(`unexpected Docker call ${method} ${path}`);
  };
  const runtime = {
    id: 'runtime-race', adapter: 'claude-code', workerId: 'worker-race', workerToken: 'token-race',
    containerId: 'old-container', containerName: 'agent-dock-runtime-race',
    volumes: { auth: 'auth', binary: 'binary', telemetry: 'telemetry', workspace: 'workspace' }
  };
  const attachment = {
    id: 'attachment-race', purpose: 'data', target: '/data/repo',
    mount: { Type: 'bind', Source: '/preflight/repo', Target: '/data/repo', ReadOnly: false },
    hostDirectory: { rootId: 'projects', relativePath: 'repo', access: 'read-write', adapter: 'claude-code' }
  };

  await manager.recreate(runtime, { agentId: 'agent-race', attachments: [attachment], previousAttachments: [] });
  assert.deepEqual(events, ['delete-old', 'validate', 'create-new']);
});

test('destructive runtime operations cannot overlap', async () => {
  const manager = new DockerRuntimeManager({ network: 'test-net', socketPath: '/nonexistent.sock' });

  // Docker recreates any named volume a container references but that does not
  // exist, so a destroy landing inside a refresh would hand the replacement
  // empty volumes and still look like it worked.
  const release = manager.claimRuntime('runtime-1', 'refreshed');
  assert.throws(() => manager.claimRuntime('runtime-1', 'destroyed'), (error) => {
    assert.equal(error.status, 409);
    assert.match(error.message, /already being refreshed/);
    return true;
  });

  // A different runtime is unaffected, and releasing frees the claim.
  const other = manager.claimRuntime('runtime-2', 'destroyed');
  other();
  release();
  manager.claimRuntime('runtime-1', 'destroyed')();
});


// Container identity has two keys with opposite failure modes: an id that is
// unambiguous but goes stale, and a name that survives replacement but can be
// reused by an unrelated container. These pin the resolution rules.
function stubDocker(manager, containers) {
  manager.request = async (method, path) => {
    const match = path.match(/^\/containers\/([^/]+)\/json$/);
    if (!match) throw new Error(`unexpected docker call ${method} ${path}`);
    const found = containers[decodeURIComponent(match[1])];
    if (!found) throw Object.assign(new Error('Docker API 404 for ' + path), { status: 409 });
    return found;
  };
}

test('a runtime resolves by id first and falls back to its stable name', async () => {
  const manager = new DockerRuntimeManager({ network: 'test-net', socketPath: '/nonexistent.sock' });
  const runtime = { id: 'rt-1', containerId: 'id-old', containerName: 'agent-dock-rt-1' };
  const ours = { Id: 'id-new', Config: { Labels: { 'com.agent-dock.runtime-id': 'rt-1' } }, State: { Running: true } };

  // Both present: the immutable id wins.
  stubDocker(manager, { 'id-old': { ...ours, Id: 'id-old' }, 'agent-dock-rt-1': ours });
  assert.equal((await manager.resolveContainer(runtime)).id, 'id-old');

  // The id has gone stale — a replaced container — so the name carries it.
  stubDocker(manager, { 'agent-dock-rt-1': ours });
  assert.equal((await manager.resolveContainer(runtime)).id, 'id-new');

  // Neither resolves.
  stubDocker(manager, {});
  assert.equal(await manager.resolveContainer(runtime), null);
});

test('a container holding the name but not the identity is never acted on', async () => {
  const manager = new DockerRuntimeManager({ network: 'test-net', socketPath: '/nonexistent.sock' });
  const runtime = { id: 'rt-1', containerId: 'id-gone', containerName: 'agent-dock-rt-1' };

  // Something unrelated has taken the name. Destructive calls resolve to
  // nothing rather than to the impostor.
  stubDocker(manager, {
    'agent-dock-rt-1': { Id: 'id-someone-else', Config: { Labels: { 'com.agent-dock.runtime-id': 'rt-other' } }, State: { Running: true } }
  });
  assert.equal(await manager.resolveContainer(runtime, { requireIdentity: true }), null);
  assert.equal(await manager.resolveContainer(runtime), null, 'a mismatched label is never ours, read or write');

  // An unlabelled container answering to the name is not provably ours either,
  // so it is readable but never destroyable.
  stubDocker(manager, {
    'agent-dock-rt-1': { Id: 'id-unlabelled', Config: { Labels: {} }, State: { Running: true } }
  });
  assert.equal((await manager.resolveContainer(runtime)).id, 'id-unlabelled');
  assert.equal(await manager.resolveContainer(runtime, { requireIdentity: true }), null);

  // stop() must not touch anything it could not verify.
  let stopped = false;
  manager.request = async (method, path) => {
    if (path.endsWith('/json')) throw Object.assign(new Error('Docker API 404'), { status: 409 });
    stopped = true;
    return null;
  };
  await manager.stop(runtime);
  assert.equal(stopped, false, 'stop acted on a container it could not verify');
});
