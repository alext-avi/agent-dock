import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createControlPlane } from '../control-plane/server.mjs';
import { createMcpService } from '../control-plane/mcp-service.mjs';
import {
  createCredentialStore,
  environmentKeyProvider,
  hostPermitted,
  publicCredential
} from '../control-plane/credentials.mjs';

const KEY = randomBytes(32).toString('base64');

function store() {
  const records = new Map();
  const writes = [];
  const credentials = createCredentialStore({
    records,
    persist: async () => { writes.push(records.size); },
    keyProvider: environmentKeyProvider({ CREDENTIAL_ENCRYPTION_KEY: KEY })
  });
  return { credentials, records, writes };
}

const apiKey = (overrides = {}) => ({
  name: 'company-docs',
  type: 'api-key',
  header: 'X-Api-Key',
  hosts: ['mcp.example.com'],
  value: 'sk-live-abcdef123456',
  ...overrides
});

test('a credential value is never returned once saved', async () => {
  const { credentials, records } = store();
  const created = await credentials.create(apiKey());

  for (const view of [created, credentials.get(created.id), credentials.list()[0]]) {
    const serialized = JSON.stringify(view);
    assert.ok(!serialized.includes('sk-live-abcdef123456'), 'the value was returned');
    assert.ok(!serialized.includes('sealed'), 'the ciphertext envelope was returned');
    assert.equal(view.value, undefined);
  }

  // A hint distinguishes one key from another without disclosing it.
  assert.equal(created.hint, '…3456');

  // Nor does the stored record hold the plaintext anywhere.
  const stored = JSON.stringify([...records.values()]);
  assert.ok(!stored.includes('sk-live-abcdef123456'), 'the value was stored in the clear');
});

test('a sealed value round-trips, and a wrong key cannot open it', async () => {
  const { credentials, records } = store();
  const created = await credentials.create(apiKey());

  assert.equal(credentials.matches(created.id, 'sk-live-abcdef123456'), true);
  assert.equal(credentials.matches(created.id, 'sk-live-abcdef123457'), false);

  // The same records under a different wrapping key are inert, which is the only
  // thing encryption at rest buys here: a copied volume without the key.
  const other = createCredentialStore({
    records,
    persist: async () => {},
    keyProvider: environmentKeyProvider({ CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64') })
  });
  assert.throws(() => other.resolveForHost(created.id, 'https://mcp.example.com/mcp'));
});

test('storage refuses to operate without a key rather than inventing one', async () => {
  const provider = environmentKeyProvider({});
  assert.equal(provider.available, false);

  const credentials = createCredentialStore({ records: new Map(), persist: async () => {}, keyProvider: provider });
  await assert.rejects(() => credentials.create(apiKey()), (error) => {
    assert.equal(error.status, 503);
    // Generating a key beside the data would imply protection that does not exist.
    assert.match(error.message, /not generated automatically/);
    return true;
  });
});

test('a credential is only released for a host it was issued for', async () => {
  const { credentials } = store();
  const created = await credentials.create(apiKey({ hosts: ['mcp.example.com', '*.internal.example.net'] }));

  const released = credentials.resolveForHost(created.id, 'https://mcp.example.com/mcp');
  assert.deepEqual(released, { header: 'X-Api-Key', value: 'sk-live-abcdef123456' });

  // Wildcard covers a subdomain but not the bare suffix.
  assert.ok(credentials.resolveForHost(created.id, 'https://tools.internal.example.net/mcp'));
  assert.throws(() => credentials.resolveForHost(created.id, 'https://internal.example.net/mcp'), (error) => {
    assert.equal(error.status, 403);
    return true;
  });

  // The refusal names the limit without leaking the value.
  assert.throws(() => credentials.resolveForHost(created.id, 'https://attacker.example.com/collect'), (error) => {
    assert.equal(error.status, 403);
    assert.match(error.message, /limited to mcp\.example\.com/);
    assert.ok(!error.message.includes('sk-live-abcdef123456'));
    return true;
  });
});

test('host matching is not a substring check', async () => {
  // The failure this guards: a suffix comparison that lets an attacker register
  // mcp.example.com.attacker.test and be treated as the permitted host.
  assert.equal(hostPermitted(['mcp.example.com'], 'https://mcp.example.com/x'), true);
  assert.equal(hostPermitted(['mcp.example.com'], 'https://mcp.example.com.attacker.test/x'), false);
  assert.equal(hostPermitted(['*.example.com'], 'https://a.example.com/x'), true);
  assert.equal(hostPermitted(['*.example.com'], 'https://example.com/x'), false);
  assert.equal(hostPermitted(['*.example.com'], 'https://a.example.com.attacker.test/x'), false);
  assert.equal(hostPermitted([], 'https://mcp.example.com/x'), false);
  assert.equal(hostPermitted(['mcp.example.com'], 'not-a-url'), false);
});

test('a credential must say where it may be sent', async () => {
  const { credentials } = store();
  await assert.rejects(() => credentials.create(apiKey({ hosts: [] })), /hosts is required/);
  await assert.rejects(() => credentials.create(apiKey({ hosts: undefined })), /hosts is required/);
  await assert.rejects(() => credentials.create(apiKey({ hosts: ['not a hostname'] })), /is not a hostname/);
  await assert.rejects(() => credentials.create(apiKey({ header: 'Bad Header' })), /valid HTTP header/);
  await assert.rejects(() => credentials.create(apiKey({ type: 'oauth' })), /type must be one of/);
  await assert.rejects(() => credentials.create(apiKey({ value: undefined })), /value is required/);
});

test('renaming leaves the value alone, and replacing it changes the hint', async () => {
  const { credentials } = store();
  const created = await credentials.create(apiKey());

  const renamed = await credentials.update(created.id, { name: 'company-docs-prod' });
  assert.equal(renamed.name, 'company-docs-prod');
  assert.equal(renamed.hint, created.hint);
  assert.equal(credentials.matches(created.id, 'sk-live-abcdef123456'), true, 'a rename disturbed the value');

  const rotated = await credentials.update(created.id, { value: 'sk-live-zzzzzz999999' });
  assert.equal(rotated.hint, '…9999');
  assert.equal(credentials.matches(created.id, 'sk-live-zzzzzz999999'), true);
  assert.equal(credentials.matches(created.id, 'sk-live-abcdef123456'), false);

  await assert.rejects(() => credentials.create(apiKey({ name: 'company-docs-prod' })), (error) => {
    assert.equal(error.status, 409);
    return true;
  });
});

test('a deleted credential cannot be resolved again', async () => {
  const { credentials, writes } = store();
  const created = await credentials.create(apiKey());
  await credentials.remove(created.id);

  assert.deepEqual(credentials.list(), []);
  assert.throws(() => credentials.resolveForHost(created.id, 'https://mcp.example.com/mcp'), (error) => {
    assert.equal(error.status, 404);
    return true;
  });
  assert.deepEqual(writes, [1, 0], 'each change should have been persisted');
});

test('the key provider reports which mode is in force', async () => {
  const { credentials } = store();
  const status = credentials.keyProviderStatus();
  assert.equal(status.name, 'environment');
  assert.equal(status.available, true);
  // The UI and docs need to be able to say this plainly.
  assert.match(status.protects, /not this host/);
  assert.equal(publicCredential({ ...apiKey(), id: 'x', hosts: ['a.example.com'], hint: '…1234' }).value, undefined);
});


async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function controlPlane(t, { key = KEY } = {}) {
  const server = createControlPlane({
    workerUrl: 'http://127.0.0.1:1',
    workerToken: 'unused',
    dataPath: null,
    credentialKeyProvider: environmentKeyProvider(key ? { CREDENTIAL_ENCRYPTION_KEY: key } : {})
  });
  const url = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return url;
}

const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
});

test('credentials can be managed over the API without the value coming back', async (t) => {
  const url = await controlPlane(t);

  const created = await post(`${url}/api/v1/credentials`, apiKey());
  assert.equal(created.status, 201);
  const body = await created.text();
  assert.ok(!body.includes('sk-live-abcdef123456'), 'the create response returned the value');
  const credential = JSON.parse(body).credential;
  assert.equal(credential.hint, '…3456');

  const listed = await (await fetch(`${url}/api/v1/credentials`)).json();
  assert.equal(listed.credentials.length, 1);
  // The operator needs to know which protection mode is in force.
  assert.equal(listed.storage.name, 'environment');
  assert.match(listed.storage.protects, /not this host/);

  const rotated = await fetch(`${url}/api/v1/credentials/${credential.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'sk-live-rotated-7777' })
  });
  assert.equal((await rotated.json()).credential.hint, '…7777');

  // Deleting is unrecoverable, so it takes the credential's own name back.
  const unconfirmed = await fetch(`${url}/api/v1/credentials/${credential.id}`, { method: 'DELETE' });
  assert.equal(unconfirmed.status, 400);
  const wrongName = await fetch(`${url}/api/v1/credentials/${credential.id}?confirmation=something-else`, { method: 'DELETE' });
  assert.equal(wrongName.status, 400);
  const removed = await fetch(`${url}/api/v1/credentials/${credential.id}?confirmation=${credential.name}`, { method: 'DELETE' });
  assert.equal(removed.status, 204);
  assert.equal((await (await fetch(`${url}/api/v1/credentials`)).json()).credentials.length, 0);
});

test('a credential still attached to a connector cannot be deleted', async (t) => {
  const url = await controlPlane(t);
  const credential = (await (await post(`${url}/api/v1/credentials`, apiKey())).json()).credential;

  const attached = await post(`${url}/api/v1/mcp/servers`, {
    name: 'company-docs',
    transport: 'http',
    url: 'https://mcp.example.com/mcp',
    timeoutMs: 30_000,
    credentialId: credential.id
  });
  assert.equal(attached.status, 201);

  const refused = await fetch(`${url}/api/v1/credentials/${credential.id}?confirmation=${credential.name}`, { method: 'DELETE' });
  assert.equal(refused.status, 409, 'deleting a credential in use would silently break a connector');
  assert.match((await refused.json()).error, /still used by company-docs/);
});

test('the API refuses credential work when no key is configured', async (t) => {
  const url = await controlPlane(t, { key: null });

  const refused = await post(`${url}/api/v1/credentials`, apiKey());
  assert.equal(refused.status, 503);
  assert.match((await refused.json()).error, /CREDENTIAL_ENCRYPTION_KEY/);

  // Listing still works, so the UI can explain why nothing can be added.
  const listed = await (await fetch(`${url}/api/v1/credentials`)).json();
  assert.deepEqual(listed.credentials, []);
  assert.equal(listed.storage.available, false);
});


test('a connector cannot reference a credential that does not exist', async (t) => {
  const url = await controlPlane(t);

  const refused = await post(`${url}/api/v1/mcp/servers`, {
    name: 'ghost',
    transport: 'http',
    url: 'https://mcp.example.com/mcp',
    timeoutMs: 30_000,
    credentialId: 'no-such-credential'
  });
  assert.equal(refused.status, 400, 'a dangling reference should fail when written, not at apply time');
  assert.match((await refused.json()).error, /does not exist/);
});

test('a connector uses a credential or a secret header, not both', async (t) => {
  const url = await controlPlane(t);
  const credential = (await (await post(`${url}/api/v1/credentials`, apiKey())).json()).credential;

  const refused = await post(`${url}/api/v1/mcp/servers`, {
    name: 'ambiguous',
    transport: 'http',
    url: 'https://mcp.example.com/mcp',
    timeoutMs: 30_000,
    credentialId: credential.id,
    secretHeaders: { Authorization: { sourceEnv: 'SOMETHING', prefix: 'Bearer ' } }
  });
  // Two mechanisms deciding one header, with no rule for which wins.
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /not both/);
});


// Delivery is where the design earns its keep: a worker receives only the
// credentials its own connectors reference, resolved only for the destination
// each connector actually names.
test('a credential reaches the worker only for the connector that uses it', async (t) => {
  const records = new Map();
  const credentials = createCredentialStore({
    records,
    persist: async () => {},
    keyProvider: environmentKeyProvider({ CREDENTIAL_ENCRYPTION_KEY: KEY })
  });

  const docs = await credentials.create(apiKey({ name: 'docs', value: 'sk-docs-111111111111' }));
  const unused = await credentials.create(apiKey({ name: 'unused', value: 'sk-unused-2222222222', hosts: ['other.example.com'] }));

  const servers = new Map();
  const bindings = new Map();
  const delivered = [];
  const service = createMcpService({
    servers,
    bindings,
    agents: new Map([['agent-1', { id: 'agent-1', name: 'Agent', adapter: 'claude-code' }]]),
    persist: async () => {},
    credentials,
    workerRequest: async (agent, method, path, body) => {
      if (method === 'GET') return { mcp: { capabilities: { credentialDelivery: true } } };
      delivered.push(body);
      return { mcp: { servers: body.servers } };
    }
  });

  await service.createServer({
    name: 'docs-connector', transport: 'http', url: 'https://mcp.example.com/mcp', timeoutMs: 30_000, credentialId: docs.id
  });
  await service.bind('agent-1', 'docs-connector', { apply: false });
  await service.applyAgent('agent-1');

  const payload = delivered.at(-1);
  assert.deepEqual(Object.keys(payload.credentials), [docs.id], 'the worker received a credential it does not use');
  assert.equal(payload.credentials[docs.id].value, 'sk-docs-111111111111');
  assert.ok(!JSON.stringify(payload).includes('sk-unused-2222222222'), 'an unrelated credential was delivered');
  assert.equal(unused.id in payload.credentials, false);
});

test('editing a connector url cannot redirect its credential', async (t) => {
  const records = new Map();
  const credentials = createCredentialStore({
    records,
    persist: async () => {},
    keyProvider: environmentKeyProvider({ CREDENTIAL_ENCRYPTION_KEY: KEY })
  });
  const credential = await credentials.create(apiKey());

  const servers = new Map();
  const bindings = new Map();
  let lastBody = null;
  const service = createMcpService({
    servers,
    bindings,
    agents: new Map([['agent-1', { id: 'agent-1', name: 'Agent', adapter: 'claude-code' }]]),
    persist: async () => {},
    credentials,
    workerRequest: async (agent, method, path, body) => {
      if (method === 'GET') return { mcp: { capabilities: { credentialDelivery: true } } };
      lastBody = body;
      return { mcp: {} };
    }
  });

  await service.createServer({
    name: 'docs', transport: 'http', url: 'https://mcp.example.com/mcp', timeoutMs: 30_000, credentialId: credential.id
  });
  await service.bind('agent-1', 'docs', { apply: false });
  await service.applyAgent('agent-1');
  assert.ok(lastBody.credentials[credential.id], 'the permitted destination should resolve');

  // The exfiltration shape: keep the credential, change where it is sent.
  lastBody = null;
  await service.updateServer('docs', { url: 'https://attacker.example.com/collect' });
  await assert.rejects(() => service.applyAgent('agent-1'), (error) => {
    assert.equal(error.status, 403);
    assert.match(error.message, /not permitted for https:\/\/attacker\.example\.com/);
    assert.ok(!error.message.includes('sk-live-abcdef123456'));
    return true;
  });
  assert.equal(lastBody, null, 'the worker was contacted despite the destination being refused');
});

// The host list is the whole boundary, so the boundary has to survive an edit of
// the list itself. Widening it is the same act as sending the credential
// somewhere new, and an adversarial review found it was reachable in two calls.
test('widening a credential host list cannot redirect it without the value', async () => {
  const records = new Map();
  const credentials = createCredentialStore({
    records,
    persist: async () => {},
    keyProvider: environmentKeyProvider({ CREDENTIAL_ENCRYPTION_KEY: KEY })
  });
  const credential = await credentials.create(apiKey());

  const servers = new Map();
  const bindings = new Map();
  let lastBody = null;
  const service = createMcpService({
    servers,
    bindings,
    agents: new Map([['agent-1', { id: 'agent-1', name: 'Agent', adapter: 'claude-code' }]]),
    persist: async () => {},
    credentials,
    workerRequest: async (agent, method, path, body) => {
      if (method === 'GET') return { mcp: { capabilities: { credentialDelivery: true } } };
      lastBody = body;
      return { mcp: {} };
    }
  });
  await service.createServer({
    name: 'docs', transport: 'http', url: 'https://mcp.example.com/mcp', timeoutMs: 30_000, credentialId: credential.id
  });
  await service.bind('agent-1', 'docs', { apply: false });

  // Step one of the exploit: move the allowlist to the destination you want.
  await assert.rejects(
    () => credentials.update(credential.id, { hosts: ['attacker.example.com', 'mcp.example.com'] }),
    (error) => error.status === 403 && /requires supplying the credential value again/.test(error.message)
  );
  assert.deepEqual(credentials.get(credential.id).hosts, ['mcp.example.com']);

  // Step two is now moot: the destination is still refused.
  lastBody = null;
  await service.updateServer('docs', { url: 'https://attacker.example.com/collect' });
  await assert.rejects(() => service.applyAgent('agent-1'), (error) => error.status === 403);
  assert.equal(lastBody, null, 'the worker was contacted for a refused destination');
});

test('re-supplying the value is what authorises a new host, and it rotates the credential', async () => {
  const records = new Map();
  const credentials = createCredentialStore({
    records,
    persist: async () => {},
    keyProvider: environmentKeyProvider({ CREDENTIAL_ENCRYPTION_KEY: KEY })
  });
  const credential = await credentials.create(apiKey());

  // Everything but the hosts stays editable without the value.
  const renamed = await credentials.update(credential.id, { name: 'renamed' });
  assert.equal(renamed.name, 'renamed');
  assert.deepEqual(renamed.hosts, ['mcp.example.com']);

  const widened = await credentials.update(credential.id, {
    hosts: ['mcp.example.com', 'docs.example.com'],
    value: 'sk-live-999999999999'
  });
  assert.deepEqual(widened.hosts, ['mcp.example.com', 'docs.example.com']);
  assert.equal(credentials.matches(credential.id, 'sk-live-999999999999'), true);
});
