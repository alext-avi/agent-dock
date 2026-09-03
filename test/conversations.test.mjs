// Conversations: the wrapper's provider-neutral "keep talking about the same
// thing". These tests stand up the real worker and the real control plane, and
// assert on the wire — the delivery tests for connector credentials passed for
// weeks against a fake of their own making, so the pattern here is deliberate.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createControlPlane } from '../control-plane/server.mjs';
import { createWorkerServer } from '../worker/server.mjs';
import { createConversationStore, normalizeConversationId } from '../worker/conversations.mjs';
import { observeCodexSessionId } from '../worker/adapters/codex.mjs';
import { observeOpenCodeSessionId } from '../worker/adapters/opencode.mjs';
import { observeClaudeSessionId } from '../worker/adapters/claude.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function ndjson(url, body, token) {
  const response = await fetch(`${url}/v1/tasks`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  const events = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { status: response.status, events, text };
}

// These are recorded provider events, captured from real CLI runs rather than
// invented — codex-cli 0.152.1 and the opencode build in the worker image.
test('each adapter recognises its own provider session identifier', () => {
  assert.equal(
    observeCodexSessionId({ type: 'thread.started', thread_id: '01a062b2-13f3-7361-a33f-9885e55013f8' }),
    '01a062b2-13f3-7361-a33f-9885e55013f8'
  );
  assert.equal(observeCodexSessionId({ type: 'turn.started' }), null);
  assert.equal(observeCodexSessionId({ type: 'thread.started' }), null);

  assert.equal(
    observeOpenCodeSessionId({ type: 'step_start', sessionID: 'ses_f9d4d923bffeRHlQ2eUY91Jwys', part: {} }),
    'ses_f9d4d923bffeRHlQ2eUY91Jwys'
  );
  assert.equal(
    observeOpenCodeSessionId({ type: 'text', part: { sessionID: 'ses_nested' } }),
    'ses_nested'
  );
  assert.equal(observeOpenCodeSessionId({ type: 'text', part: {} }), null);

  // Claude Code takes an id from us but still announces the session it opened,
  // which is what the worker records — recorded on announcement, not before.
  assert.equal(
    observeClaudeSessionId({ type: 'system', subtype: 'init', session_id: 'b95e3a83-757d-4d5b-afcf-c2945c861014' }),
    'b95e3a83-757d-4d5b-afcf-c2945c861014'
  );
  assert.equal(observeClaudeSessionId({ type: 'assistant', session_id: 'x' }), null);
});

// The worker's own refusal of a conversation it cannot continue is unreachable
// while every adapter supports one, so it is covered by inspection rather than by
// a test. This pins the assumption that makes it unreachable: add an adapter
// without the capability and this fails, which is the moment to test the refusal.
test('every adapter currently supports conversations, which is why the worker refusal is untested', async () => {
  const { codexAdapterManifest } = await import('../worker/adapters/codex.mjs');
  const { claudeAdapterManifest } = await import('../worker/adapters/claude.mjs');
  const { opencodeAdapterManifest } = await import('../worker/adapters/opencode.mjs');
  for (const manifest of [codexAdapterManifest, claudeAdapterManifest, opencodeAdapterManifest]) {
    assert.equal(
      manifest.capabilities.tasks.conversations,
      true,
      `${manifest.id} no longer supports conversations; the worker's refusal path is now reachable and needs a test`
    );
  }
});

test('a conversation id is validated like anything else off the wire', () => {
  assert.equal(normalizeConversationId(undefined), null);
  assert.equal(normalizeConversationId('  '), null);
  assert.equal(normalizeConversationId('workshop.github-1'), 'workshop.github-1');
  for (const bad of ['../escape', 'has space', 'semi;colon', 'new\nline', 'a'.repeat(201), 42, {}]) {
    assert.throws(() => normalizeConversationId(bad), (error) => error.status === 400, `accepted ${JSON.stringify(bad)}`);
  }
});

test('the first provider session wins and survives a worker restart', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'agent-dock-conversations-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const statePath = join(temporary, 'conversations.json');

  const store = createConversationStore({ statePath });
  const taskA = '11111111-1111-4111-8111-111111111111';
  const taskB = '22222222-2222-4222-8222-222222222222';
  await store.open('chat-1', { taskId: taskA });
  await store.attachSession('chat-1', 'ses_first');
  // A harness stamps its session on every event; a later one must not repoint an
  // established conversation at a different session mid-run.
  await store.attachSession('chat-1', 'ses_second');
  assert.equal((await store.resolve('chat-1')).providerSession, 'ses_first');

  const second = await store.open('chat-1', { taskId: taskB });
  assert.equal(second.turns, 2);

  // Provider sessions are durable on the agent's volume, so ours must be too —
  // otherwise a restart silently starts a fresh exchange.
  const reopened = createConversationStore({ statePath });
  const survived = await reopened.resolve('chat-1');
  assert.equal(survived.providerSession, 'ses_first');
  assert.equal(survived.turns, 2);
  assert.equal(survived.lastTaskId, taskB);

  // The provider's own identifier is worker-internal and must never be public.
  const listed = await reopened.list();
  assert.deepEqual(Object.keys(listed[0]).sort(), ['createdAt', 'id', 'lastTaskId', 'resumable', 'turns', 'updatedAt']);
  assert.doesNotMatch(JSON.stringify(listed), /ses_first/);
  assert.equal(listed[0].resumable, true);
});

test('a record written by the agent itself cannot be echoed back through the API', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'agent-dock-conversation-injected-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const statePath = join(temporary, 'conversations.json');

  // This file lives on a volume the agent can write, and the agent may be
  // prompt-injected. publicConversation chooses which fields come back; the load
  // path decides what those fields may contain.
  await writeFile(statePath, JSON.stringify({
    schemaVersion: 1,
    conversations: [
      { id: 'injected', lastTaskId: 'sk-live-STOLEN-CREDENTIAL', turns: 'lots', providerSession: 'ses_x' },
      { id: '../../escape', lastTaskId: null, turns: 1 },
      { id: 'no-timestamps', turns: 2 }
    ]
  }));

  const store = createConversationStore({ statePath });
  const listed = await store.list();
  assert.doesNotMatch(JSON.stringify(listed), /STOLEN/, 'a written-in value was echoed back');
  assert.equal(listed.find((item) => item.id === 'injected').lastTaskId, null);
  assert.equal(listed.find((item) => item.id === 'injected').turns, 0);
  assert.equal(listed.some((item) => item.id === '../../escape'), false, 'an unsafe id survived the load');
  // A record missing its timestamps must not crash the listing.
  assert.ok(listed.find((item) => item.id === 'no-timestamps').updatedAt);
});

test('a worker reports and forgets conversations without disclosing provider sessions', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'agent-dock-conversation-routes-'));
  const token = 'conversation-token';
  const worker = createWorkerServer({
    token,
    adapter: 'codex-cli',
    demoMode: true,
    workspace: process.cwd(),
    dataPath: join(temporary, 'usage.json'),
    conversationStatePath: join(temporary, 'conversations.json'),
    mcpStatePath: join(temporary, 'mcp.json'),
    mcpConfigDir: temporary
  });
  const workerUrl = await listen(worker);
  t.after(async () => {
    await new Promise((resolve) => worker.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  });
  const authed = { authorization: `Bearer ${token}` };

  const first = await ndjson(workerUrl, { prompt: 'hello', conversationId: 'chat-1' }, token);
  assert.equal(first.status, 200);
  const continued = first.events.find((event) => event.type === 'conversation.continued');
  assert.ok(continued, 'the caller was never told which conversation it was in');
  assert.equal(continued.data.conversationId, 'chat-1');
  assert.equal(continued.data.resumed, false, 'a brand new conversation cannot have been resumed');

  const second = await ndjson(workerUrl, { prompt: 'again', conversationId: 'chat-1' }, token);
  assert.equal(second.events.find((event) => event.type === 'conversation.continued').data.turns, 2);

  const listed = await (await fetch(`${workerUrl}/v1/conversations`, { headers: authed })).json();
  assert.equal(listed.conversations.length, 1);
  assert.equal(listed.conversations[0].turns, 2);

  const removed = await fetch(`${workerUrl}/v1/conversations/chat-1`, { method: 'DELETE', headers: authed });
  assert.equal(removed.status, 204);
  const missing = await fetch(`${workerUrl}/v1/conversations/chat-1`, { headers: authed });
  assert.equal(missing.status, 404);

  // Forgetting our mapping is not a way to reach provider state.
  assert.equal((await fetch(`${workerUrl}/v1/conversations/chat-1`, { method: 'DELETE', headers: authed })).status, 404);
});

test('a claude worker records the session it minted before the harness ever runs', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'agent-dock-conversation-mint-'));
  const token = 'mint-token';
  const statePath = join(temporary, 'conversations.json');
  const worker = createWorkerServer({
    token,
    adapter: 'claude-code',
    demoMode: true,
    workspace: process.cwd(),
    dataPath: join(temporary, 'usage.json'),
    conversationStatePath: statePath,
    mcpStatePath: join(temporary, 'mcp.json'),
    mcpConfigDir: temporary
  });
  const workerUrl = await listen(worker);
  t.after(async () => {
    await new Promise((resolve) => worker.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  });

  await ndjson(workerUrl, { prompt: 'hello', conversationId: 'chat-mint' }, token);

  // A session is only recorded once the harness announces it. The demo worker
  // announces nothing, so the conversation exists and honestly reports that it
  // has no continuity to offer — rather than claiming a session Claude never
  // opened, which would fail every later turn permanently, because the first
  // recorded session wins and there is no way to correct it.
  const stored = JSON.parse(await readFile(statePath, 'utf8')).conversations[0];
  assert.equal(stored.id, 'chat-mint');
  assert.equal(stored.providerSession, null);
  const listed = await (await fetch(`${workerUrl}/v1/conversations`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(listed.conversations[0].resumable, false);
});

test('the control plane refuses to send a conversation to a runtime that cannot continue one', async (t) => {
  // An older worker ignores conversationId, answers without the earlier turns,
  // and reports success. The fleet is expected to be mixed-version.
  const legacyWorker = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      protocol: 'agent-wrapper/v1',
      capabilities: { tasks: { streaming: 'ndjson', cancellation: true }, authentication: { methods: [], refresh: false } },
      authentication: { authenticated: true },
      task: { active: null }
    }));
  });
  const workerUrl = await listen(legacyWorker);
  const control = createControlPlane({ workerUrl, workerToken: 'legacy', dataPath: null });
  const controlUrl = await listen(control);
  t.after(() => Promise.all([
    new Promise((resolve) => control.close(resolve)),
    new Promise((resolve) => legacyWorker.close(resolve))
  ]));

  const refused = await fetch(`${controlUrl}/api/v1/agents/worker-01/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'continue please', conversationId: 'chat-1' })
  });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /cannot continue a conversation/);

  // Without a conversation it is an ordinary task and must still be allowed
  // through, so the gate cannot become a general regression.
  const plain = await fetch(`${controlUrl}/api/v1/agents/worker-01/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'ordinary task' })
  });
  assert.notEqual(plain.status, 409);
});
