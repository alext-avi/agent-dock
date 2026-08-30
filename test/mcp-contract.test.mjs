import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createControlPlane } from '../control-plane/server.mjs';
import { createWorkerServer } from '../worker/server.mjs';
import { createMcpManager } from '../worker/mcp/manager.mjs';
import { applyCodexMcpServers } from '../worker/adapters/codex-mcp.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

const remoteDefinition = (name) => ({
  id: name,
  name,
  transport: 'http',
  command: null,
  args: [],
  cwd: null,
  url: `https://${name}.example.test/mcp`,
  environment: {},
  secretEnvironment: {},
  headers: {},
  secretHeaders: {},
  timeoutMs: 30_000,
  createdAt: '2026-08-30T12:00:00.000Z',
  updatedAt: '2026-08-30T12:00:00.000Z'
});

for (const adapter of ['codex-cli', 'claude-code', 'opencode']) {
  test(`${adapter} round-trips the same canonical MCP definitions through worker apply and inspect`, async (t) => {
    const temporary = await mkdtemp(join(tmpdir(), `agent-dock-${adapter}-mcp-`));
    const token = `${adapter}-secret`;
    const worker = createWorkerServer({
      token,
      adapter,
      demoMode: true,
      agentId: `test-${adapter}`,
      workspace: process.cwd(),
      mcpStatePath: join(temporary, 'state.json'),
      mcpConfigDir: temporary,
      opencodeConfigPath: join(temporary, 'opencode.json')
    });
    const workerUrl = await listen(worker);
    t.after(async () => {
      await new Promise((resolve) => worker.close(resolve));
      await rm(temporary, { recursive: true, force: true });
    });
    const servers = [remoteDefinition(`${adapter.replace(/[^a-z]/g, '-')}-docs`)];
    const apply = await fetch(`${workerUrl}/v1/mcp`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ servers })
    });
    assert.equal(apply.status, 200);
    const applied = (await apply.json()).mcp;
    assert.deepEqual(applied.servers, servers);
    assert.equal(applied.restartRequired, false);
    assert.equal(applied.activation, 'next-task');

    const inspect = await fetch(`${workerUrl}/v1/mcp`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(inspect.status, 200);
    const inspected = (await inspect.json()).mcp;
    assert.deepEqual(inspected.servers, servers);
    assert.deepEqual(JSON.parse(await readFile(join(temporary, 'state.json'), 'utf8')).servers, servers);

    const remove = await fetch(`${workerUrl}/v1/mcp`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{"servers":[]}'
    });
    assert.equal(remove.status, 200);
    assert.deepEqual((await remove.json()).mcp.servers, []);
  });
}

test('Claude task context creates its strict empty MCP file before the first task', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'agent-dock-claude-empty-mcp-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const manager = createMcpManager({
    adapterId: 'claude-code',
    environment: {},
    workspace: '/workspace',
    allowedCommands: [],
    statePath: join(temporary, 'state.json'),
    configDir: temporary,
    demoMode: false
  });

  const context = await manager.taskContext({ HOME: '/claude-home' });

  assert.deepEqual(context.args, ['--mcp-config', join(temporary, 'claude.json'), '--strict-mcp-config']);
  assert.deepEqual(JSON.parse(await readFile(join(temporary, 'claude.json'), 'utf8')), { mcpServers: {} });
});

test('OpenCode task context disables MCP servers merged from unmanaged config sources', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'agent-dock-opencode-authority-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const invocations = [];
  const manager = createMcpManager({
    adapterId: 'opencode',
    environment: {},
    workspace: '/workspace',
    allowedCommands: [],
    statePath: join(temporary, 'state.json'),
    providerConfigPath: join(temporary, 'opencode.json'),
    demoMode: false,
    run: async (command, args, options) => {
      invocations.push({ command, args, options });
      return {
        code: 0,
        output: JSON.stringify({
          model: 'ollama/qwen3',
          mcp: {
            'project.added': { type: 'remote', url: 'https://project.example.test/mcp' },
            'managed-docs': { type: 'remote', url: 'https://stale.example.test/mcp' }
          }
        })
      };
    }
  });
  await manager.apply([remoteDefinition('managed-docs')]);

  const context = await manager.taskContext({ HOME: '/opencode-home' });
  const inline = JSON.parse(context.env.OPENCODE_CONFIG_CONTENT);

  assert.deepEqual(invocations.map(({ command, args }) => ({ command, args })), [
    { command: 'opencode', args: ['debug', 'config', '--pure'] }
  ]);
  assert.deepEqual(inline.mcp['project.added'], { enabled: false });
  assert.equal(inline.mcp['managed-docs'].url, 'https://managed-docs.example.test/mcp');
  assert.equal(inline.mcp['managed-docs'].enabled, true);
});

test('OpenCode refuses to start a task when merged MCP configuration cannot be inspected', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'agent-dock-opencode-config-failure-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const manager = createMcpManager({
    adapterId: 'opencode',
    environment: {},
    workspace: '/workspace',
    allowedCommands: [],
    statePath: join(temporary, 'state.json'),
    providerConfigPath: join(temporary, 'opencode.json'),
    demoMode: false,
    run: async () => ({ code: 1, output: 'diagnostic with a potentially sensitive path' })
  });

  await assert.rejects(
    manager.taskContext({ HOME: '/opencode-home' }),
    (error) => error.status === 409
      && error.code === 'OPENCODE_CONFIG_UNAVAILABLE'
      && !error.message.includes('sensitive')
  );
});

test('Codex restores its previous native MCP configuration when an add fails', async () => {
  const previous = [remoteDefinition('previous-docs')];
  const desired = [remoteDefinition('next-docs'), remoteDefinition('rejected-docs')];
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'mcp' && args[1] === 'add' && args[2] === 'rejected-docs') return { code: 1, output: 'provider detail' };
    return { code: 0, output: '' };
  };

  await assert.rejects(
    applyCodexMcpServers(desired, { previousServers: previous, allowedCommands: [], run, env: {} }),
    (error) => error.status === 502 && error.code === 'CODEX_MCP_APPLY_FAILED'
  );

  assert.ok(calls.some((call) => call.join(' ') === 'codex mcp add previous-docs --url https://previous-docs.example.test/mcp'));
  assert.deepEqual(calls.slice(-4), [
    ['codex', 'mcp', 'remove', 'previous-docs'],
    ['codex', 'mcp', 'remove', 'next-docs'],
    ['codex', 'mcp', 'remove', 'rejected-docs'],
    ['codex', 'mcp', 'add', 'previous-docs', '--url', 'https://previous-docs.example.test/mcp']
  ]);
});

test('control-plane MCP definitions and bindings persist without credential values', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'agent-dock-control-mcp-'));
  const dataPath = join(temporary, 'registry.json');
  const token = 'worker-token';
  const worker = createWorkerServer({
    token,
    adapter: 'codex-cli',
    demoMode: true,
    workspace: process.cwd(),
    mcpStatePath: join(temporary, 'worker-state.json'),
    mcpConfigDir: join(temporary, 'worker-config')
  });
  const workerUrl = await listen(worker);
  let control = createControlPlane({ workerUrl, workerToken: token, dataPath });
  let controlUrl = await listen(control);
  t.after(async () => {
    if (control.listening) await new Promise((resolve) => control.close(resolve));
    await new Promise((resolve) => worker.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  });

  const definition = {
    name: 'docs',
    transport: 'http',
    url: 'https://docs.example.test/mcp',
    secretHeaders: { Authorization: { sourceEnv: 'DOCS_TOKEN', prefix: 'Bearer ' } }
  };
  const createdResponse = await fetch(`${controlUrl}/api/v1/mcp/servers`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(definition)
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).server;
  assert.deepEqual(created.secretHeaders, definition.secretHeaders);
  assert.doesNotMatch(JSON.stringify(created), /actual-secret-value/);

  const bindingResponse = await fetch(`${controlUrl}/api/v1/agents/worker-01/mcp/bindings`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serverId: created.id, apply: false })
  });
  assert.equal(bindingResponse.status, 201);
  const beforeRestart = await (await fetch(`${controlUrl}/api/v1/agents/worker-01/mcp`)).json();
  assert.deepEqual(beforeRestart.bindings[0].server, created);

  await new Promise((resolve) => control.close(resolve));
  control = createControlPlane({ workerUrl, workerToken: token, dataPath });
  controlUrl = await listen(control);
  const afterRestart = await (await fetch(`${controlUrl}/api/v1/agents/worker-01/mcp`)).json();
  assert.deepEqual(afterRestart.bindings[0].server, created);
  const persisted = JSON.parse(await readFile(dataPath, 'utf8'));
  assert.equal(persisted.schemaVersion, 3);
  assert.equal(persisted.mcpServers.length, 1);
  assert.equal(persisted.mcpBindings.length, 1);
});

test('control-plane rejects duplicate names, embedded URL credentials, and invalid local commands', async (t) => {
  const token = 'validation-token';
  const worker = createWorkerServer({ token, demoMode: true, workspace: process.cwd(), mcpAllowedCommands: ['node'] });
  const workerUrl = await listen(worker);
  const control = createControlPlane({ workerUrl, workerToken: token, dataPath: null });
  const controlUrl = await listen(control);
  t.after(() => Promise.all([
    new Promise((resolve) => control.close(resolve)),
    new Promise((resolve) => worker.close(resolve))
  ]));
  const create = (body) => fetch(`${controlUrl}/api/v1/mcp/servers`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  assert.equal((await create({ name: 'safe', transport: 'http', url: 'https://example.test/mcp' })).status, 201);
  assert.equal((await create({ name: 'safe', transport: 'http', url: 'https://other.test/mcp' })).status, 409);
  assert.equal((await create({ name: 'embedded', transport: 'http', url: 'https://user:pass@example.test/mcp' })).status, 400);
  const local = await create({ name: 'local', transport: 'stdio', command: 'curl', args: ['https://example.test'] });
  assert.equal(local.status, 201);
  const id = (await local.json()).server.id;
  const validation = await fetch(`${controlUrl}/api/v1/agents/worker-01/mcp/validate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serverId: id })
  });
  assert.equal(validation.status, 400);
});
