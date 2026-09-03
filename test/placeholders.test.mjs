// Placeholders: one mechanism instead of three.
//
// A definition is written the way the connector actually looks, with ${NAME}
// where a secret belongs, and the presence of a placeholder is what declares a
// binding is needed. These tests run the real control plane against a real
// worker and read the rendered provider configuration, because the thing worth
// proving is that a placeholder in an argument is genuinely filled — the previous
// design could not do that at all, and the UI had to explain why.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createControlPlane } from '../control-plane/server.mjs';
import { environmentKeyProvider } from '../control-plane/credentials.mjs';
import { placeholderNames as controlPlaneNames } from '../control-plane/placeholders.mjs';
import { createWorkerServer } from '../worker/server.mjs';
import { placeholderNames as workerNames } from '../worker/mcp/manager.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

// The syntax is part of the protocol, so both sides of the wrapper implement it.
// The control plane cannot import the worker's copy without putting worker code
// above the wrapper, so the two are kept honest here instead. Two copies of the
// same description drifting apart is a bug this repository has already had.
test('both sides of the wrapper find the same placeholders', () => {
  const corpus = [
    { url: 'https://${HOST}/mcp?key=${KEY}', args: [], headers: {}, environment: {} },
    { transport: 'stdio', args: ['-y', 'pkg', '--token', '${ACCESS_TOKEN}'], headers: {}, environment: {} },
    { args: [], headers: { Authorization: 'Bearer ${TOKEN}' }, environment: {} },
    { args: [], headers: {}, environment: { API_KEY: '${KEY}' } },
    { args: ['${A}', '${A}', '${B}'], headers: {}, environment: {} },
    { cwd: '/work/${DIR}', args: [], headers: {}, environment: {} },
    // Not a placeholder: no braces, and an executable must stay a literal or the
    // command allowlist would be checking a template.
    { command: '${EVIL}', args: ['$PLAIN', '${1BAD}', '${}'], headers: {}, environment: {} },
    { args: [], headers: {}, environment: {} }
  ];
  for (const server of corpus) {
    assert.deepEqual(
      workerNames(server).sort(),
      controlPlaneNames(server).sort(),
      `the two implementations disagree about ${JSON.stringify(server)}`
    );
  }
  assert.deepEqual(controlPlaneNames(corpus[6]), [], 'a command or a bare $NAME was treated as a placeholder');
  assert.deepEqual(controlPlaneNames(corpus[4]), ['A', 'B']);
});

test('a placeholder in an argument is filled from a stored key at spawn time', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'agent-dock-placeholder-args-'));
  const configDir = join(temporary, 'worker-config');
  const statePath = join(temporary, 'worker-state.json');
  const token = 'placeholder-token';
  const worker = createWorkerServer({
    token,
    adapter: 'claude-code',
    demoMode: true,
    workspace: '/workspace',
    dataPath: null,
    mcpStatePath: statePath,
    mcpConfigDir: configDir,
    mcpAllowedCommands: ['npx']
  });
  const workerUrl = await listen(worker);
  const control = createControlPlane({
    workerUrl,
    workerToken: token,
    dataPath: null,
    credentialKeyProvider: environmentKeyProvider({ CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64') })
  });
  const controlUrl = await listen(control);
  t.after(async () => {
    await Promise.all([
      new Promise((resolve) => control.close(resolve)),
      new Promise((resolve) => worker.close(resolve))
    ]);
    await rm(temporary, { recursive: true, force: true });
  });
  const post = (pathname, body) => fetch(`${controlUrl}${pathname}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });

  const credential = (await (await post('/api/v1/credentials', {
    name: 'local-key', header: 'X-Api-Key', hosts: ['unused.example.test'], value: 'sk-live-IN-AN-ARGUMENT'
  })).json()).credential;

  const created = await post('/api/v1/mcp/servers', {
    name: 'local-server',
    transport: 'stdio',
    command: 'npx',
    // The Claude adapter requires a managed stdio server to run from the
    // workspace, and the control plane confines cwd to it. Unrelated to
    // placeholders, but required to get a stdio definition stored at all.
    cwd: '/workspace',
    args: ['-y', '@acme/mcp-server', '--token', '${ACCESS_TOKEN}'],
    placeholders: { ACCESS_TOKEN: { source: 'credential', credentialId: credential.id } }
  });
  assert.equal(created.status, 201, await created.clone().text());
  const definition = (await created.json()).server;

  // Stored as written: the value is not in the definition, the placeholder is.
  assert.deepEqual(definition.args, ['-y', '@acme/mcp-server', '--token', '${ACCESS_TOKEN}']);
  assert.doesNotMatch(JSON.stringify(definition), /sk-live-IN-AN-ARGUMENT/);

  assert.equal((await post(`/api/v1/agents/worker-01/mcp/bindings`, { serverId: definition.id, apply: true })).status, 201);

  // And filled where it is actually used, which the previous design could not do.
  const rendered = JSON.parse(await readFile(join(configDir, 'claude.json'), 'utf8'));
  assert.deepEqual(rendered.mcpServers['local-server'].args, ['-y', '@acme/mcp-server', '--token', 'sk-live-IN-AN-ARGUMENT']);

  // Never durable on either side.
  assert.doesNotMatch(await readFile(statePath, 'utf8'), /sk-live-IN-AN-ARGUMENT/);
  const listed = await (await fetch(`${controlUrl}/api/v1/mcp/servers`)).json();
  assert.doesNotMatch(JSON.stringify(listed), /sk-live-IN-AN-ARGUMENT/);
});

test('a placeholder with nothing bound to it is refused rather than stored', async (t) => {
  const control = createControlPlane({ workerUrl: 'http://127.0.0.1:1', workerToken: 'x', dataPath: null });
  const controlUrl = await listen(control);
  t.after(() => new Promise((resolve) => control.close(resolve)));
  const post = (body) => fetch(`${controlUrl}/api/v1/mcp/servers`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });

  // Storing this would be storing a connector that can never run.
  const unbound = await post({
    name: 'unbound', transport: 'http', url: 'https://example.test/mcp?key=${MISSING}'
  });
  assert.equal(unbound.status, 400);
  assert.match((await unbound.json()).error, /MISSING is used in this definition but has no value bound/);

  // A binding for a placeholder that is not used anywhere is dropped rather than
  // kept as something that has quietly stopped meaning anything.
  const extra = await post({
    name: 'extra',
    transport: 'http',
    url: 'https://example.test/mcp',
    placeholders: { LEFTOVER: { source: 'connector-secret', name: 'SOME_SECRET' } }
  });
  assert.equal(extra.status, 201);
  assert.deepEqual((await extra.json()).server.placeholders, {});

  for (const bad of [
    { placeholders: { GOOD: { source: 'nonsense' } } },
    { placeholders: { GOOD: { source: 'connector-secret', name: 'not a name' } } },
    { placeholders: { '1BAD': { source: 'connector-secret', name: 'X' } } }
  ]) {
    const response = await post({ name: `bad-${Math.random().toString(36).slice(2, 8)}`, transport: 'http', url: 'https://example.test/mcp?k=${GOOD}', ...bad });
    assert.equal(response.status, 400, `accepted ${JSON.stringify(bad)}`);
  }
});

test('a connector secret fills a placeholder without the control plane ever seeing it', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'agent-dock-placeholder-secret-'));
  const configDir = join(temporary, 'worker-config');
  const token = 'secret-placeholder-token';
  // The worker reduces its own MCP_SECRET_ namespace before the manager sees it,
  // so a connector secret is provisioned the way a container provisions one.
  process.env.MCP_SECRET_COMPANY_TOKEN = 'provisioned-in-the-container';
  t.after(() => { delete process.env.MCP_SECRET_COMPANY_TOKEN; });
  const worker = createWorkerServer({
    token,
    adapter: 'claude-code',
    demoMode: true,
    workspace: process.cwd(),
    dataPath: null,
    mcpStatePath: join(temporary, 'state.json'),
    mcpConfigDir: configDir
  });
  const workerUrl = await listen(worker);
  const control = createControlPlane({ workerUrl, workerToken: token, dataPath: null });
  const controlUrl = await listen(control);
  t.after(async () => {
    await Promise.all([
      new Promise((resolve) => control.close(resolve)),
      new Promise((resolve) => worker.close(resolve))
    ]);
    await rm(temporary, { recursive: true, force: true });
  });
  const post = (pathname, body) => fetch(`${controlUrl}${pathname}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });

  const definition = (await (await post('/api/v1/mcp/servers', {
    name: 'company-docs',
    transport: 'http',
    url: 'https://docs.example.test/mcp',
    headers: { Authorization: 'Bearer ${COMPANY}' },
    placeholders: { COMPANY: { source: 'connector-secret', name: 'COMPANY_TOKEN' } }
  })).json()).server;
  assert.equal((await post('/api/v1/agents/worker-01/mcp/bindings', { serverId: definition.id, apply: true })).status, 201);

  const rendered = JSON.parse(await readFile(join(configDir, 'claude.json'), 'utf8'));
  assert.equal(rendered.mcpServers['company-docs'].headers.Authorization, 'Bearer provisioned-in-the-container');
});
