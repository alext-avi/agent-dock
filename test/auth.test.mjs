import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const defaultJwk = { ...publicJwk, kid: 'test-key', alg: 'RS256', use: 'sig' };
  const state = {
    nonce: null,
    subject: 'admin-user',
    email: 'admin@example.test',
    idTokenClaims: {},
    idTokenOptions: {},
    jwks: [defaultJwk],
    tokenEndpointAuthMethods: ['client_secret_basic'],
    tokenRequest: null
  };
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
        token_endpoint_auth_methods_supported: state.tokenEndpointAuthMethods,
        code_challenge_methods_supported: ['S256']
      }));
    }
    if (url.pathname === '/jwks') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ keys: state.jwks }));
    }
    if (url.pathname === '/token') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      state.tokenRequest = {
        authorization: req.headers.authorization ?? null,
        clientId: body.get('client_id'),
        clientSecret: body.get('client_secret')
      };
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
        exp: now + 300,
        ...state.idTokenClaims
      }, state.idTokenOptions);
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
    publicJwk,
    state,
    issueAccessToken(claims = {}, options = {}) {
      const now = Math.floor(Date.now() / 1000);
      return jwt(privateKey, {
        iss: issuer,
        aud: 'https://dock.example.test/api',
        sub: 'viewer-user',
        iat: now,
        exp: now + 300,
        ...claims
      }, options);
    }
  };
}

function oidcOptions(identity, overrides = {}) {
  return {
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
}

async function startOidcControl(t, identity, overrides = {}) {
  const auth = oidcOptions(identity, overrides);
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
  const setCookie = response.headers.get('set-cookie');
  return { cookie: setCookie.split(';')[0], setCookie, state };
}

test('trusted-local mode provides an explicit local admin principal', async () => {
  const auth = createAuthService({ mode: 'trusted-local' });
  const principal = await auth.authenticate({ headers: {} });
  assert.equal(principal.authentication, 'trusted-local');
  assert.deepEqual(principal.roles, ['admin']);
  assert.equal(auth.allows(principal, 'mcp:manage'), true);
});

test('trusted-local MCP requires a separate strong bearer token', async () => {
  assert.throws(
    () => createAuthService({ mode: 'trusted-local', localMcpToken: 'too-short' }),
    /at least 32 bytes/
  );
  const token = 'local-mcp-token-that-is-more-than-thirty-two-bytes';
  const auth = createAuthService({ mode: 'trusted-local', localMcpToken: token });

  await assert.rejects(
    auth.authenticateMcpBearer({ headers: {} }),
    (error) => error.status === 401 && /Bearer/.test(error.message)
  );
  await assert.rejects(
    auth.authenticateMcpBearer({ headers: { authorization: 'Bearer wrong-token' } }),
    (error) => error.status === 401 && /invalid/.test(error.message)
  );
  const authenticated = await auth.authenticateMcpBearer({ headers: { authorization: `Bearer ${token}` } });
  assert.equal(authenticated.principal.id, 'local:operator');
  assert.equal(authenticated.authInfo.clientId, 'agent-dock-local-mcp');
});

test('trusted-local control-plane MCP is unavailable without its token and exposes tools with it', async (t) => {
  const token = 'local-mcp-token-that-is-more-than-thirty-two-bytes';
  const control = createControlPlane({
    workerToken: 'test-worker-token',
    dataPath: null,
    schedulerEnabled: false,
    auth: { mode: 'trusted-local', localMcpToken: token }
  });
  const url = await listen(control);
  t.after(() => new Promise((resolve) => control.close(resolve)));
  const request = (authorization) => ({
    method: 'POST',
    headers: {
      ...(authorization ? { authorization } : {}),
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-06-18'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  });

  let response = await fetch(`${url}/mcp`, request());
  assert.equal(response.status, 401);
  response = await fetch(`${url}/mcp`, request(`Bearer ${token}`));
  assert.equal(response.status, 200);
  const text = await response.text();
  const data = text.split('\n').find((line) => line.startsWith('data: '));
  const payload = JSON.parse(data ? data.slice(6) : text);
  assert.deepEqual(payload.result.tools.map((tool) => tool.name).sort(), [
    'cancel_agent_task',
    'get_agent_status',
    'get_agent_task',
    'list_agents',
    'submit_agent_task'
  ]);
});

test('trusted-local control-plane MCP remains unavailable when no local token is configured', async (t) => {
  const control = createControlPlane({
    workerToken: 'test-worker-token',
    dataPath: null,
    schedulerEnabled: false,
    auth: { mode: 'trusted-local' }
  });
  const url = await listen(control);
  t.after(() => new Promise((resolve) => control.close(resolve)));
  const response = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-06-18'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  });
  assert.equal(response.status, 503);
});

test('trusted-local mode refuses non-loopback origins and externally published binds', () => {
  for (const trustedLocalBind of ['0.0.0.0', '::', '*', 'agents.example.test']) {
    assert.throws(
      () => createAuthService({ mode: 'trusted-local', trustedLocalBind }),
      /AUTH_TRUSTED_LOCAL_BIND to be loopback/
    );
  }
  assert.throws(
    () => createAuthService({
      mode: 'trusted-local',
      trustedLocalBind: '127.0.0.1',
      publicOrigin: 'https://agents.example.test'
    }),
    /loopback AUTH_PUBLIC_ORIGIN/
  );
  for (const trustedLocalBind of ['localhost', '127.0.0.1', '::1', '[::1]']) {
    const auth = createAuthService({ mode: 'trusted-local', trustedLocalBind });
    auth.close();
  }
  const oidc = createAuthService({
    ...oidcOptions({ issuer: 'https://issuer.example.test/' }),
    trustedLocalBind: '0.0.0.0'
  });
  oidc.close();
});

test('OIDC keeps API and MCP resource identifiers distinct and transport-safe', () => {
  const identity = { issuer: 'https://issuer.example.test/' };
  assert.throws(
    () => createAuthService({
      ...oidcOptions(identity),
      mcpAudience: 'https://dock.example.test/api'
    }),
    /must be different resources/
  );
  assert.throws(
    () => createAuthService({
      ...oidcOptions(identity),
      apiAudience: 'http://dock.example.test/api'
    }),
    /AUTH_API_AUDIENCE must use HTTPS/
  );
});

test('return targets cannot escape the control-plane origin', () => {
  const auth = createAuthService({ mode: 'trusted-local' });
  assert.equal(auth.normalizeReturnTo('/agents/example?tab=tools'), '/agents/example?tab=tools');
  for (const hostile of ['https://evil.example/', '//evil.example/', '/\\evil.example', 'agents/example', '']) {
    assert.equal(auth.normalizeReturnTo(hostile), '/');
  }
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

test('OIDC login uses PKCE, creates a signed secure session, and enforces CSRF and Origin', async (t) => {
  const identity = await fakeIssuer(t);
  const { url } = await startOidcControl(t, identity);

  let response = await fetch(`${url}/jobs`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/login?returnTo=%2Fjobs');
  response = await fetch(`${url}/login?returnTo=%2Fjobs`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Continue with GitHub/);

  const { cookie, setCookie, state } = await signIn(url, identity);
  assert.match(setCookie, /^__Host-agent_dock_session=/);
  assert.match(setCookie, /; HttpOnly/);
  assert.match(setCookie, /; SameSite=Lax/);
  assert.match(setCookie, /; Secure/);
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
    headers: {
      cookie,
      'content-type': 'application/json',
      'x-agent-dock-csrf': '1',
      origin: 'https://evil.example.test'
    },
    body: JSON.stringify({ name: 'Denied from hostile origin' })
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

test('durable loopback OIDC profile preserves PKCE, sessions, CSRF, and resource audiences', async (t) => {
  const identity = await fakeIssuer(t);
  const publicOrigin = 'http://127.0.0.1:8787';
  const { url } = await startOidcControl(t, identity, {
    publicOrigin,
    apiAudience: `${publicOrigin}/api`,
    mcpAudience: `${publicOrigin}/mcp`,
    resource: `${publicOrigin}/api`
  });

  let response = await fetch(`${url}/auth/login?returnTo=%2Fjobs`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  const authorization = new URL(response.headers.get('location'));
  assert.equal(authorization.searchParams.get('redirect_uri'), `${publicOrigin}/auth/callback`);
  assert.equal(authorization.searchParams.get('resource'), `${publicOrigin}/api`);
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  identity.state.nonce = authorization.searchParams.get('nonce');

  response = await fetch(
    `${url}/auth/callback?code=test-code&state=${encodeURIComponent(authorization.searchParams.get('state'))}`,
    { redirect: 'manual' }
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/jobs');
  const setCookie = response.headers.get('set-cookie');
  const cookie = setCookie.split(';')[0];
  assert.match(setCookie, /^agent_dock_session=/);
  assert.doesNotMatch(setCookie, /; Secure/);
  assert.match(setCookie, /; HttpOnly/);
  assert.match(setCookie, /; SameSite=Lax/);

  response = await fetch(`${url}/api/v1/session`, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).authentication.principal.roles, ['admin']);

  response = await fetch(`${url}/api/v1/agents`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
      'x-agent-dock-csrf': '1',
      origin: publicOrigin
    },
    body: JSON.stringify({ name: 'Loopback authorized agent', runtime: { mode: 'unprovisioned' } })
  });
  assert.equal(response.status, 201);

  response = await fetch(`${url}/api/v1/agents`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
      'x-agent-dock-csrf': '1',
      origin: 'http://127.0.0.1:8788'
    },
    body: JSON.stringify({ name: 'Wrong loopback origin' })
  });
  assert.equal(response.status, 403);

  const metadata = await (await fetch(`${url}/.well-known/oauth-protected-resource`)).json();
  assert.equal(metadata.resource, `${publicOrigin}/api`);
  assert.deepEqual(metadata.authorization_servers, [identity.issuer]);
  const mcpMetadata = await (await fetch(`${url}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(mcpMetadata.resource, `${publicOrigin}/mcp`);
});

test('OIDC supports explicit client_secret_post for providers that register body credentials', async (t) => {
  const identity = await fakeIssuer(t);
  identity.state.tokenEndpointAuthMethods = ['none', 'client_secret_basic', 'client_secret_post'];
  const { url } = await startOidcControl(t, identity, {
    tokenEndpointAuthMethod: 'client_secret_post'
  });

  await signIn(url, identity);
  assert.deepEqual(identity.state.tokenRequest, {
    authorization: null,
    clientId: 'agent-dock-test-client',
    clientSecret: 'test-client-secret'
  });
});

test('OIDC rejects forged, stale, premature, misissued, and key-confused bearer tokens', async (t) => {
  const identity = await fakeIssuer(t);
  const { url } = await startOidcControl(t, identity);
  const now = Math.floor(Date.now() / 1000);
  const request = (token) => fetch(`${url}/api/v1/agents`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const invalid = [
    ['wrong issuer', identity.issueAccessToken({ iss: 'https://evil.example.test/' })],
    ['wrong audience', identity.issueAccessToken({ aud: 'https://wrong.example.test/api' })],
    ['multiple audiences', identity.issueAccessToken({ aud: ['https://dock.example.test/api', 'https://dock.example.test/mcp'], azp: 'agent-dock-test-client' })],
    ['expired', identity.issueAccessToken({ exp: now - 60 })],
    ['missing expiry', identity.issueAccessToken({ exp: null })],
    ['not active', identity.issueAccessToken({ nbf: now + 60 })],
    ['unknown key', identity.issueAccessToken({}, { kid: 'missing-key' })],
    ['unsupported algorithm', identity.issueAccessToken({}, { algorithm: 'none' })]
  ];
  const valid = identity.issueAccessToken();
  const parts = valid.split('.');
  parts[2] = `${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`;
  invalid.push(['forged signature', parts.join('.')]);

  const { publicKey: ecPublicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  identity.state.jwks.push({
    ...ecPublicKey.export({ format: 'jwk' }),
    kid: 'wrong-key-type',
    alg: 'RS256',
    use: 'sig'
  });
  invalid.push(['key type confusion', identity.issueAccessToken({}, { kid: 'wrong-key-type' })]);

  for (const [label, token] of invalid) {
    const response = await request(token);
    assert.equal(response.status, 401, label);
  }
});

test('verified email is required for email-based elevation', async (t) => {
  const identity = await fakeIssuer(t);
  const { url } = await startOidcControl(t, identity, {
    adminSubjects: [],
    adminEmails: ['admin@example.test']
  });
  const roles = async (emailVerified) => {
    const response = await fetch(`${url}/api/v1/session`, {
      headers: {
        authorization: `Bearer ${identity.issueAccessToken({
          email: 'admin@example.test',
          email_verified: emailVerified
        })}`
      }
    });
    assert.equal(response.status, 200);
    return (await response.json()).authentication.principal.roles;
  };
  assert.deepEqual(await roles(false), ['viewer']);
  assert.deepEqual(await roles(true), ['admin']);
  assert.deepEqual(await roles(1), ['admin']);
});

test('OIDC callback rejects nonce and authorized-party substitution', async (t) => {
  const identity = await fakeIssuer(t);
  const { url } = await startOidcControl(t, identity);

  let response = await fetch(`${url}/auth/login`, { redirect: 'manual' });
  let authorization = new URL(response.headers.get('location'));
  identity.state.nonce = authorization.searchParams.get('nonce');
  identity.state.idTokenClaims = { nonce: 'attacker-nonce' };
  response = await fetch(`${url}/auth/callback?code=test-code&state=${authorization.searchParams.get('state')}`);
  assert.equal(response.status, 401);

  identity.state.idTokenClaims = {};
  response = await fetch(`${url}/auth/login`, { redirect: 'manual' });
  authorization = new URL(response.headers.get('location'));
  identity.state.nonce = authorization.searchParams.get('nonce');
  identity.state.idTokenClaims = { azp: 'attacker-client' };
  response = await fetch(`${url}/auth/callback?code=test-code&state=${authorization.searchParams.get('state')}`);
  assert.equal(response.status, 401);
});

test('durable sessions survive restart, re-evaluate roles, and expire server-side', async (t) => {
  const identity = await fakeIssuer(t);
  const directory = await mkdtemp(join(tmpdir(), 'agent-dock-auth-'));
  const sessionDbPath = join(directory, 'sessions.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true }));
  let clock = Date.now();
  const base = oidcOptions(identity, {
    sessionDbPath,
    sessionTtlSeconds: 300,
    adminSubjects: [],
    adminEmails: ['admin@example.test'],
    now: () => clock
  });

  let auth = createAuthService(base);
  const started = new URL((await auth.beginLogin('/jobs')).location);
  identity.state.nonce = started.searchParams.get('nonce');
  identity.state.idTokenClaims = { email_verified: 1 };
  const completed = await auth.completeLogin(new URL(
    `/auth/callback?code=test-code&state=${started.searchParams.get('state')}`,
    'https://dock.example.test'
  ));
  const cookie = completed.cookie.split(';')[0];
  assert.deepEqual((await auth.authenticate({ headers: { cookie } })).roles, ['admin']);
  auth.close();

  auth = createAuthService(base);
  assert.deepEqual((await auth.authenticate({ headers: { cookie } })).roles, ['admin']);
  auth.close();

  auth = createAuthService({ ...base, adminEmails: [] });
  assert.deepEqual((await auth.authenticate({ headers: { cookie } })).roles, ['viewer']);
  clock += 301_000;
  assert.equal(await auth.authenticate({ headers: { cookie } }), null);
  auth.close();
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
  assert.equal(response.status, 403, 'a default role is not positive MCP authorization');
  assert.match((await response.json()).error, /not explicitly authorized/);

  const mcpOperator = identity.issueAccessToken({
    aud: 'https://dock.example.test/mcp',
    sub: 'operator-user'
  });
  response = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${mcpOperator}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-06-18'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'tools/list', params: {} })
  });
  assert.equal(response.status, 200);
  const operatorText = await response.text();
  const operatorData = operatorText.split('\n').find((line) => line.startsWith('data: '));
  const operatorPayload = JSON.parse(operatorData ? operatorData.slice(6) : operatorText);
  assert.deepEqual(operatorPayload.result.tools.map((tool) => tool.name).sort(), [
    'cancel_agent_task',
    'get_agent_status',
    'get_agent_task',
    'list_agents',
    'submit_agent_task'
  ]);
});
