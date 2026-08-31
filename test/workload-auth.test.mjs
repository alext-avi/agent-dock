import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createWorkloadToken, workloadScopeForRequest } from '../control-plane/workload-token.mjs';
import { createWorkerServer } from '../worker/server.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

test('managed worker tokens are short-lived, audience-bound, and scope-bound', async (t) => {
  const secret = 'dedicated-runtime-secret';
  const worker = createWorkerServer({
    token: secret,
    authMode: 'jwt',
    agentId: 'worker-a',
    demoMode: true,
    workspace: process.cwd()
  });
  const url = await listen(worker);
  t.after(() => new Promise((resolve) => worker.close(resolve)));

  const readToken = createWorkloadToken(secret, {
    audience: 'agent-wrapper:worker-a',
    scopes: ['wrapper:read']
  });
  let response = await fetch(`${url}/v1/status`, { headers: { authorization: `Bearer ${readToken}` } });
  assert.equal(response.status, 200);
  response = await fetch(`${url}/v1/tasks`, {
    method: 'POST',
    headers: { authorization: `Bearer ${readToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'This scope must not run a task' })
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).requiredScope, 'wrapper:task');

  const wrongWorker = createWorkloadToken(secret, {
    audience: 'agent-wrapper:worker-b',
    scopes: ['wrapper:*']
  });
  response = await fetch(`${url}/v1/status`, { headers: { authorization: `Bearer ${wrongWorker}` } });
  assert.equal(response.status, 401);

  const expired = createWorkloadToken(secret, {
    audience: 'agent-wrapper:worker-a',
    scopes: ['wrapper:*'],
    now: Date.now() - 10 * 60 * 1000,
    ttlSeconds: 60
  });
  response = await fetch(`${url}/v1/status`, { headers: { authorization: `Bearer ${expired}` } });
  assert.equal(response.status, 401);

  response = await fetch(`${url}/v1/status`, { headers: { authorization: `Bearer ${secret}` } });
  assert.equal(response.status, 401, 'JWT-only managed workers reject the retained bootstrap credential format');
});

test('control-plane routes mint only the corresponding wrapper scope', () => {
  assert.equal(workloadScopeForRequest('/v1/status', 'GET'), 'wrapper:read');
  assert.equal(workloadScopeForRequest('/v1/workspace', 'GET'), 'wrapper:workspace:read');
  assert.equal(workloadScopeForRequest('/v1/tasks', 'POST'), 'wrapper:task');
  assert.equal(workloadScopeForRequest('/v1/auth/login', 'POST'), 'wrapper:auth');
  assert.equal(workloadScopeForRequest('/v1/mcp', 'PUT'), 'wrapper:mcp');
  assert.equal(workloadScopeForRequest('/v1/usage/refresh', 'POST'), 'wrapper:usage:refresh');
  assert.throws(
    () => createWorkloadToken('secret', { audience: 'agent-wrapper:test' }),
    /workload scope/
  );
});
