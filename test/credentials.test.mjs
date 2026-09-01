import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
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
