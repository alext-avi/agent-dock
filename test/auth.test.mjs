import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { authPermissions, createAuthService } from '../control-plane/auth.mjs';
import { createControlPlane } from '../control-plane/server.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function jwt(privateKey, claims, { kid = 'test-key', algorithm = 'RS256' } = {}) {
  const header = Buffer.from(JSON.stringify({ alg: algorithm, kid, typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

async function fakeIssuer(t) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: 'jwk' });
  const state = { nonce: null, subject: 'admin-user', email: 'admin@example.test' };
  let issuer;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, issuer);
    if (url.pathname === '/.well-known/openid-configuration') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({
        issuer,
        authorization_endpoint: new URL('authorize', issuer).href,
        token_endpoint: new URL('token', issuer).href,
        jwks_uri: new URL('jwks', issuer).href,
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
        code_challenge_methods_supported: ['S256']
      }));
    }
    if (url.pathname === '/jwks') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ keys: [{ ...publicJwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] }));
    }
    if (url.pathname === '/token') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.ok(body.get('code_verifier'));
      const now = Math.floor(Date.now() / 1000);
      const idToken = jwt(privateKey, {
        iss: issuer,
        aud: 'agent-dock-test-client',
        sub: state.subject,
        email: state.email,
        name: state.subject === 'admin-user' ? 'Admin User' : 'Viewer User',
        nonce: state.nonce,
        iat: now,
        exp: now + 300
      });
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ access_token: 'not-used-by-the-control-plane', token_type: 'Bearer', id_token: idToken }));
    }
    res.statusCode = 404;
    res.end();
  });
  issuer = `${await listen(server)}/`;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    issuer,
    privateKey,
    state,
    issueAccessToken(claims = {}) {
      const now = Math.floor(Date.now() / 1000);
      return jwt(privateKey, {
        iss: issuer,
        aud: 'https://dock.example.test/api',
        sub: 'viewer-user',
        iat: now,
        exp: now + 300,
        ...claims
      });
    }
  };
}

async function startOidcControl(t, identity, overrides = {}) {
  const auth = {
    mode: 'oidc',
    issuer: identity.issuer,
    clientId: 'agent-dock-test-client',
    clientSecret: 'test-client-secret',
    sessionSecret: 'test-session-secret-that-is-longer-than-thirty-two-bytes',
    publicOrigin: 'https://dock.example.test',
    apiAudience: 'https://dock.example.test/api',
    adminSubjects: ['admin-user'],
    defaultRole: 'viewer',
    providerName: 'GitHub',
    ...overrides
  };
  const control = createControlPlane({
    workerToken: 'test-worker-token',
    dataPath: null,
    schedulerEnabled: false,
    mcpAllowedHostnames: ['127.0.0.1'],
    auth
  });
  const url = await listen(control);
  t.after(() => new Promise((resolve) => control.close(resolve)));
  return { control, url, auth };
}

async function signIn(url, identity, returnTo = '/jobs') {
  let response = await fetch(`${url}/auth/login?returnTo=${encodeURIComponent(returnTo)}`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  const authorization = new URL(response.headers.get('location'));
  assert.equal(authorization.pathname, '/authorize');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  identity.state.nonce = authorization.searchParams.get('nonce');
  const state = authorization.searchParams.get('state');

  response = await fetch(`${url}/auth/callback?code=test-code&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/');
  return { cookie: response.headers.get('set-cookie').split(';')[0], state };
}

test('trusted-local mode provides an explicit local admin principal', async () => {
  const auth = createAuthService({ mode: 'trusted-local' });
  const principal = await auth.authenticate({ headers: {} });
  assert.equal(principal.authentication, 'trusted-local');
  assert.deepEqual(principal.roles, ['admin']);
  assert.equal(auth.allows(principal, 'mcp:manage'), true);
});

test('route policy explicitly separates reads, execution, and privileged mutations', () => {
  const permission = (method, pathname) => authPermissions.permissionForRequest({ method }, new URL(pathname, 'https://dock.test'));
  assert.equal(permission('GET', '/api/v1/agents'), 'fleet:read');
  assert.equal(permission('POST', '/api/v1/agents'), 'agents:manage');
  assert.equal(permission('PATCH', '/api/v1/agents/example'), 'agents:manage');
  assert.equal(permission('POST', '/api/v1/agents/example/tasks'), 'tasks:execute');
  assert.equal(permission('POST', '/api/v1/agents/example/auth/login'), 'provider-auth:manage');
  assert.equal(permission('POST', '/api/v1/agents/example/usage/refresh'), 'usage:refresh');
  assert.equal(permission('GET', '/api/v1/agents/example/workspace'), 'workspace:read');
  assert.equal(permission('POST', '/api/v1/agents/example/runtime/refresh'), 'runtime:manage');
  assert.equal(permission('POST', '/api/v1/mcp/servers'), 'mcp:manage');
  assert.equal(permission('POST', '/api/v1/agents/example/mcp/bindings'), 'mcp:manage');
  assert.equal(permission('DELETE', '/api/v1/agents/example/mcp/bindings/docs'), 'mcp:manage');
  assert.equal(permission('POST', '/api/v1/agents/example/mcp/apply'), 'mcp:manage');
  assert.equal(permission('GET', '/api/v1/schedules'), 'fleet:read');
  assert.equal(permission('POST', '/api/v1/schedules'), 'schedules:manage');
  assert.equal(permission('POST', '/api/v1/unclassified-mutation'), 'control:admin');
});

test('OIDC login uses PKCE, creates a signed session, and enforces CSRF', async (t) => {
  const identity = await fakeIssuer(t);
  const { url } = await startOidcControl(t, identity);

  let response = await fetch(`${url}/jobs`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/login?returnTo=%2Fjobs');
  response = await fetch(`${url}/login?returnTo=%2Fjobs`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Continue with GitHub/);

  const { cookie, state } = await signIn(url, identity);
  response = await fetch(`${url}/api/v1/session`, { headers: { cookie } });
  const session = (await response.json()).authentication;
  assert.equal(session.authenticated, true);
  assert.equal(session.principal.displayName, 'Admin User');
  assert.deepEqual(session.principal.roles, ['admin']);

  response = await fetch(`${url}/api/v1/agents`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Denied without CSRF' })
  });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /CSRF/);

  response = await fetch(`${url}/api/v1/agents`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'x-agent-dock-csrf': '1', origin: 'https://dock.example.test' },
    body: JSON.stringify({ name: 'Authorized agent', runtime: { mode: 'unprovisioned' } })
  });
  assert.equal(response.status, 201);

  response = await fetch(`${url}/auth/callback?code=replay&state=${encodeURIComponent(state)}`);
  assert.equal(response.status, 401, 'an authorization state can only be consumed once');

  response = await fetch(`${url}/auth/logout`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie, 'x-agent-dock-csrf': '1', origin: 'https://dock.example.test' }
  });
  assert.equal(response.status, 302);
  response = await fetch(`${url}/api/v1/agents`, { headers: { cookie } });
  assert.equal(response.status, 401, 'logout revokes the durable server-side session');

  const tampered = `${cookie.slice(0, -1)}${cookie.endsWith('a') ? 'b' : 'a'}`;
  response = await fetch(`${url}/api/v1/agents`, { headers: { cookie: tampered } });
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate'), /oauth-protected-resource/);
});

test('audience-bound bearer tokens obey the same role and permission policy', async (t) => {
  const identity = await fakeIssuer(t);
  const { url } = await startOidcControl(t, identity, { operatorSubjects: ['operator-user'] });

  const viewer = identity.issueAccessToken({ sub: 'viewer-user' });
  let response = await fetch(`${url}/api/v1/agents`, { headers: { authorization: `Bearer ${viewer}` } });
  assert.equal(response.status, 200);
  response = await fetch(`${url}/api/v1/mcp/servers`, { headers: { authorization: `Bearer ${viewer}` } });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).requiredPermission, 'mcp:manage');

  const operator = identity.issueAccessToken({ sub: 'operator-user' });
  response = await fetch(`${url}/api/v1/schedules`, {
    method: 'POST',
    headers: { authorization: `Bearer ${operator}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'operator-job',
      name: 'Operator job',
      agentId: 'worker-01',
      prompt: 'Run with an operator token',
      timing: { kind: 'once', at: new Date(Date.now() + 60_000).toISOString() }
    })
  });
  assert.equal(response.status, 201);

  const wrongAudience = identity.issueAccessToken({ aud: 'https://another-resource.example/api' });
  response = await fetch(`${url}/api/v1/agents`, { headers: { authorization: `Bearer ${wrongAudience}` } });
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate'), /resource_metadata/);

  const scopedAgent = identity.issueAccessToken({
    sub: 'admin-user',
    agent_id: 'schedule-runner',
    scope: 'tasks:execute'
  });
  response = await fetch(`${url}/api/v1/agents`, { headers: { authorization: `Bearer ${scopedAgent}` } });
  assert.equal(response.status, 403, 'agent identities do not inherit human subject roles');

  const metadata = await (await fetch(`${url}/.well-known/oauth-protected-resource`)).json();
  assert.equal(metadata.resource, 'https://dock.example.test/api');
  assert.deepEqual(metadata.authorization_servers, [identity.issuer]);

  const mcpMetadata = await (await fetch(`${url}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(mcpMetadata.resource, 'https://dock.example.test/mcp');
  assert.deepEqual(mcpMetadata.scopes_supported, ['fleet:read', 'tasks:execute']);

  response = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${viewer}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-06-18'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} })
  });
  assert.equal(response.status, 401, 'an API-audience token cannot be replayed at the MCP resource');

  const mcpViewer = identity.issueAccessToken({ aud: 'https://dock.example.test/mcp' });
  response = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${mcpViewer}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-06-18'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} })
  });
  assert.equal(response.status, 200);
  const mcpText = await response.text();
  const mcpData = mcpText.split('\n').find((line) => line.startsWith('data: '));
  const mcpPayload = JSON.parse(mcpData ? mcpData.slice(6) : mcpText);
  assert.deepEqual(mcpPayload.result.tools.map((tool) => tool.name).sort(), ['get_agent_status', 'list_agents']);
});
