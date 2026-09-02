import {
  constants,
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature
} from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ROLE_PERMISSIONS = {
  viewer: new Set(['fleet:read']),
  operator: new Set(['fleet:read', 'tasks:execute', 'schedules:manage', 'usage:refresh']),
  admin: new Set(['*'])
};
const SUPPORTED_JWT_ALGORITHMS = new Set(['RS256', 'PS256', 'ES256']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function list(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function isLoopbackHost(value) {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return LOOPBACK_HOSTS.has(normalized);
}

function parseJsonSegment(segment, label) {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw httpError(`${label} is malformed`, 401);
  }
}

function safeReturnTo(value, fallback = '/') {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback;
  return value;
}

function parseCookies(header = '') {
  const result = new Map();
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) result.set(name, value);
  }
  return result;
}

function html(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeIssuer(value) {
  if (!value) return null;
  const issuer = String(value).trim();
  const url = new URL(issuer);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('AUTH_OIDC_ISSUER cannot contain credentials, a query, or a fragment');
  }
  if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) {
    throw new Error('AUTH_OIDC_ISSUER must use HTTPS unless it is localhost');
  }
  // Issuer comparison is intentionally exact. Preserve whether the configured
  // identifier had a trailing slash rather than letting URL serialization add
  // one and silently change the security-domain identifier.
  return issuer;
}

function normalizeOrigin(value) {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('AUTH_PUBLIC_ORIGIN must be an origin without credentials, a path, query, or fragment');
  }
  if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) {
    throw new Error('AUTH_PUBLIC_ORIGIN must use HTTPS unless it is localhost');
  }
  return url.origin;
}

function secureEndpoint(value, label) {
  const url = new URL(value);
  if (url.username || url.password) throw new Error(`${label} cannot contain URL credentials`);
  if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) {
    throw new Error(`${label} must use HTTPS unless it is localhost`);
  }
  return url.href;
}

function validateDiscoveryMetadata(value, issuer) {
  for (const field of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (typeof value?.[field] !== 'string' || !value[field]) throw new Error(`OIDC discovery is missing ${field}`);
  }
  if (value.issuer !== issuer) throw new Error('OIDC discovery issuer does not match AUTH_OIDC_ISSUER');
  secureEndpoint(value.authorization_endpoint, 'OIDC authorization endpoint');
  secureEndpoint(value.token_endpoint, 'OIDC token endpoint');
  secureEndpoint(value.jwks_uri, 'OIDC JWKS endpoint');
  if (Array.isArray(value.code_challenge_methods_supported) && !value.code_challenge_methods_supported.includes('S256')) {
    throw new Error('OIDC provider does not advertise PKCE S256 support');
  }
  return value;
}

function scopesFromClaims(claims) {
  if (Array.isArray(claims.scp)) return claims.scp.map(String);
  if (typeof claims.scope === 'string') return claims.scope.split(/\s+/).filter(Boolean);
  return [];
}

function audienceMatches(actual, expected) {
  return Array.isArray(actual) ? actual.includes(expected) : actual === expected;
}

function verifyJwtSignature(algorithm, signingInput, signature, key) {
  if (algorithm === 'RS256') return verifySignature('RSA-SHA256', signingInput, key, signature);
  if (algorithm === 'PS256') {
    return verifySignature('sha256', signingInput, {
      key,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32
    }, signature);
  }
  if (algorithm === 'ES256') {
    return verifySignature('sha256', signingInput, { key, dsaEncoding: 'ieee-p1363' }, signature);
  }
  return false;
}

function permissionForRequest(req, url) {
  const path = url.pathname;
  if (!path.startsWith('/api/')) return null;
  if (['/api/v1/health', '/api/health', '/api/v1/session'].includes(path)) return null;

  if (/^\/api\/v1\/mcp(?:\/|$)/.test(path) || /^\/api\/v1\/agents\/[^/]+\/mcp(?:\/|$)/.test(path)) {
    return 'mcp:manage';
  }
  if (/^\/api\/v1\/agents\/[^/]+\/workspace$/.test(path) || path === '/api/v1/workspace' || path === '/api/workspace') {
    return 'workspace:read';
  }
  if (/^\/api\/v1\/agents\/[^/]+\/auth\//.test(path) || /^\/api\/(?:v1\/)?auth\//.test(path)) {
    return 'provider-auth:manage';
  }
  if (/^\/api\/v1\/agents\/[^/]+\/runtime\//.test(path)) return 'runtime:manage';
  if (/^\/api\/v1\/agents\/[^/]+\/tasks(?:\/|$)/.test(path) || ['/api/v1/tasks', '/api/run', '/api/v1/tasks/cancel', '/api/run/cancel'].includes(path)) {
    return 'tasks:execute';
  }
  if (/\/usage\/refresh$/.test(path)) return 'usage:refresh';
  if (/^\/api\/v1\/schedules(?:\/|$)/.test(path)) return req.method === 'GET' ? 'fleet:read' : 'schedules:manage';
  if (path === '/api/v1/scheduler') return 'fleet:read';
  if (path === '/api/v1/agents') return req.method === 'GET' ? 'fleet:read' : 'agents:manage';
  if (/^\/api\/v1\/agents\/[^/]+$/.test(path)) return req.method === 'GET' ? 'fleet:read' : 'agents:manage';
  if (path === '/api/v1/runtimes') return 'fleet:read';
  if (SAFE_METHODS.has(req.method)) return 'fleet:read';
  return 'control:admin';
}

export function createAuthService(options = {}) {
  const env = options.env ?? process.env;
  const mode = options.mode ?? env.AUTH_MODE ?? 'trusted-local';
  if (!['trusted-local', 'oidc'].includes(mode)) throw new Error('AUTH_MODE must be trusted-local or oidc');

  const publicOrigin = normalizeOrigin(options.publicOrigin ?? env.AUTH_PUBLIC_ORIGIN ?? 'http://127.0.0.1:3000');
  const trustedLocalBind = options.trustedLocalBind ?? env.AUTH_TRUSTED_LOCAL_BIND ?? env.HOST ?? '127.0.0.1';
  const providerName = options.providerName ?? env.AUTH_PROVIDER_NAME ?? 'GitHub';
  const apiAudience = options.apiAudience ?? env.AUTH_API_AUDIENCE ?? `${publicOrigin}/api`;
  const mcpAudience = options.mcpAudience ?? env.AUTH_MCP_AUDIENCE ?? `${publicOrigin}/mcp`;
  const sessionTtlSeconds = Number(options.sessionTtlSeconds ?? env.AUTH_SESSION_TTL_SECONDS ?? 8 * 60 * 60);
  if (!Number.isInteger(sessionTtlSeconds) || sessionTtlSeconds < 300 || sessionTtlSeconds > 7 * 24 * 60 * 60) {
    throw new Error('AUTH_SESSION_TTL_SECONDS must be between 300 and 604800');
  }

  const issuer = mode === 'oidc' ? normalizeIssuer(options.issuer ?? env.AUTH_OIDC_ISSUER) : null;
  const clientId = options.clientId ?? env.AUTH_OIDC_CLIENT_ID ?? null;
  const clientSecret = options.clientSecret ?? env.AUTH_OIDC_CLIENT_SECRET ?? null;
  const tokenEndpointAuthMethod = options.tokenEndpointAuthMethod
    ?? env.AUTH_OIDC_TOKEN_ENDPOINT_AUTH_METHOD
    ?? 'auto';
  const requestedScopeList = list(options.scopes ?? env.AUTH_OIDC_SCOPES ?? 'openid,profile,email');
  const requestedScopes = requestedScopeList.join(' ');
  const resource = options.resource ?? env.AUTH_OIDC_RESOURCE ?? null;
  const sessionSecret = options.sessionSecret ?? env.AUTH_SESSION_SECRET ?? null;
  const localMcpToken = options.localMcpToken ?? env.AUTH_LOCAL_MCP_TOKEN ?? null;
  const sessionDbPath = options.sessionDbPath ?? env.AUTH_DB_PATH ?? ':memory:';
  const defaultRole = options.defaultRole ?? env.AUTH_DEFAULT_ROLE ?? 'viewer';
  const adminSubjects = new Set(list(options.adminSubjects ?? env.AUTH_ADMIN_SUBJECTS));
  const adminEmails = new Set(list(options.adminEmails ?? env.AUTH_ADMIN_EMAILS).map((item) => item.toLowerCase()));
  const operatorSubjects = new Set(list(options.operatorSubjects ?? env.AUTH_OPERATOR_SUBJECTS));
  const operatorEmails = new Set(list(options.operatorEmails ?? env.AUTH_OPERATOR_EMAILS).map((item) => item.toLowerCase()));
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => Date.now());

  if (!ROLE_PERMISSIONS[defaultRole]) throw new Error('AUTH_DEFAULT_ROLE must be viewer, operator, or admin');
  if (mode === 'trusted-local') {
    if (!isLoopbackHost(new URL(publicOrigin).hostname)) {
      throw new Error('AUTH_MODE=trusted-local requires a loopback AUTH_PUBLIC_ORIGIN');
    }
    if (!isLoopbackHost(trustedLocalBind)) {
      throw new Error('AUTH_MODE=trusted-local requires AUTH_TRUSTED_LOCAL_BIND to be loopback');
    }
  }
  if (mode === 'oidc') {
    if (!issuer || !clientId) throw new Error('AUTH_OIDC_ISSUER and AUTH_OIDC_CLIENT_ID are required in oidc mode');
    if (!requestedScopeList.includes('openid')) throw new Error('AUTH_OIDC_SCOPES must include openid');
    if (!['auto', 'client_secret_basic', 'client_secret_post', 'none'].includes(tokenEndpointAuthMethod)) {
      throw new Error('AUTH_OIDC_TOKEN_ENDPOINT_AUTH_METHOD must be auto, client_secret_basic, client_secret_post, or none');
    }
    if (typeof apiAudience !== 'string' || !apiAudience) throw new Error('AUTH_API_AUDIENCE is required in oidc mode');
    if (typeof mcpAudience !== 'string' || !mcpAudience) throw new Error('AUTH_MCP_AUDIENCE is required in oidc mode');
    secureEndpoint(apiAudience, 'AUTH_API_AUDIENCE');
    secureEndpoint(mcpAudience, 'AUTH_MCP_AUDIENCE');
    if (apiAudience === mcpAudience) throw new Error('AUTH_API_AUDIENCE and AUTH_MCP_AUDIENCE must be different resources');
    if (!sessionSecret || Buffer.byteLength(sessionSecret) < 32) {
      throw new Error('AUTH_SESSION_SECRET must contain at least 32 bytes in oidc mode');
    }
  }
  if (mode === 'trusted-local' && localMcpToken && Buffer.byteLength(localMcpToken) < 32) {
    throw new Error('AUTH_LOCAL_MCP_TOKEN must contain at least 32 bytes when configured');
  }

  if (mode === 'oidc' && sessionDbPath !== ':memory:') mkdirSync(dirname(sessionDbPath), { recursive: true });
  const sessionDb = mode === 'oidc' ? new DatabaseSync(sessionDbPath) : null;
  sessionDb?.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      issuer TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL,
      email TEXT,
      email_verified INTEGER NOT NULL DEFAULT 0,
      display_name TEXT NOT NULL,
      provider TEXT NOT NULL,
      roles_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
  `);
  if (sessionDb) {
    const columns = new Set(sessionDb.prepare('PRAGMA table_info(auth_sessions)').all().map((column) => column.name));
    if (!columns.has('issuer')) sessionDb.exec("ALTER TABLE auth_sessions ADD COLUMN issuer TEXT NOT NULL DEFAULT ''");
    if (!columns.has('email_verified')) sessionDb.exec('ALTER TABLE auth_sessions ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
  }

  const secureCookies = new URL(publicOrigin).protocol === 'https:';
  const sessionCookieName = secureCookies ? '__Host-agent_dock_session' : 'agent_dock_session';
  const transactions = new Map();
  let discovery = options.discovery ? validateDiscoveryMetadata(options.discovery, issuer) : null;
  let discoveryPromise = null;
  let jwks = options.jwks ?? null;
  let jwksReadAt = jwks ? now() : 0;

  function roleAssignmentFor(claims) {
    const subject = String(claims.sub ?? '');
    const email = claims.email_verified === true || claims.email_verified === 1
      ? String(claims.email ?? '').toLowerCase()
      : '';
    if (adminSubjects.has(subject) || (email && adminEmails.has(email))) return { roles: ['admin'], source: 'explicit' };
    if (operatorSubjects.has(subject) || (email && operatorEmails.has(email))) return { roles: ['operator'], source: 'explicit' };
    return { roles: [defaultRole], source: 'default' };
  }

  function makePrincipal(claims, authentication) {
    const subject = String(claims.sub ?? '');
    if (!subject) throw httpError('Identity token is missing sub', 401);
    const assignment = claims.agent_id ? { roles: [], source: 'agent' } : roleAssignmentFor(claims);
    return {
      type: claims.agent_id ? 'agent' : 'user',
      id: claims.agent_id ? `agent:${claims.agent_id}` : `oidc:${base64url(`${issuer}|${subject}`)}`,
      agentId: claims.agent_id ? String(claims.agent_id) : null,
      subject,
      email: typeof claims.email === 'string' ? claims.email : null,
      emailVerified: claims.email_verified === true || claims.email_verified === 1,
      displayName: claims.name ?? claims.preferred_username ?? claims.email ?? subject,
      provider: providerName,
      authentication,
      // Workload/agent identities are scope-only. They never inherit a human
      // role (including AUTH_DEFAULT_ROLE) from this control plane.
      roles: assignment.roles,
      roleSource: assignment.source,
      scopes: scopesFromClaims(claims)
    };
  }

  const localPrincipal = {
    type: 'user',
    id: 'local:operator',
    subject: 'local:operator',
    email: null,
    displayName: 'Local operator',
    provider: 'Trusted local mode',
    authentication: 'trusted-local',
    roles: ['admin'],
    roleSource: 'trusted-local',
    scopes: ['*']
  };

  async function getDiscovery() {
    if (discovery) return discovery;
    if (discoveryPromise) return discoveryPromise;
    discoveryPromise = (async () => {
      const base = new URL(issuer);
      const path = `${base.pathname.replace(/\/$/, '')}/.well-known/openid-configuration`.replace(/^\/\//, '/');
      const metadataUrl = new URL(path, base.origin);
      const response = await fetchImpl(metadataUrl, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`OIDC discovery returned HTTP ${response.status}`);
      discovery = validateDiscoveryMetadata(await response.json(), issuer);
      return discovery;
    })().finally(() => { discoveryPromise = null; });
    return discoveryPromise;
  }

  async function getJwks(force = false) {
    if (!force && jwks && now() - jwksReadAt < 10 * 60 * 1000) return jwks;
    const metadata = await getDiscovery();
    const response = await fetchImpl(metadata.jwks_uri, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`OIDC JWKS returned HTTP ${response.status}`);
    const value = await response.json();
    if (!Array.isArray(value.keys)) throw new Error('OIDC JWKS is malformed');
    jwks = value;
    jwksReadAt = now();
    return jwks;
  }

  async function verifyJwt(token, { audience, nonce = undefined, authorizedParty = undefined } = {}) {
    const parts = String(token).split('.');
    if (parts.length !== 3) throw httpError('Bearer token is malformed', 401);
    const header = parseJsonSegment(parts[0], 'JWT header');
    const claims = parseJsonSegment(parts[1], 'JWT payload');
    if (!SUPPORTED_JWT_ALGORITHMS.has(header.alg)) throw httpError('JWT signing algorithm is not allowed', 401);
    if (typeof header.kid !== 'string' || !header.kid) throw httpError('JWT is missing kid', 401);

    let keys = await getJwks();
    const matchesKey = (candidate) => candidate.kid === header.kid
      && (!candidate.alg || candidate.alg === header.alg)
      && (!candidate.use || candidate.use === 'sig')
      && (!Array.isArray(candidate.key_ops) || candidate.key_ops.includes('verify'));
    let jwk = keys.keys.find(matchesKey);
    if (!jwk) {
      keys = await getJwks(true);
      jwk = keys.keys.find(matchesKey);
    }
    if (!jwk) throw httpError('JWT signing key is unknown', 401);
    let publicKey;
    try { publicKey = createPublicKey({ key: jwk, format: 'jwk' }); }
    catch { throw httpError('JWT signing key is invalid', 401); }
    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2], 'base64url');
    let validSignature = false;
    try { validSignature = verifyJwtSignature(header.alg, signingInput, signature, publicKey); }
    catch { /* Treat key/algorithm mismatches as authentication failures. */ }
    if (!validSignature) throw httpError('JWT signature is invalid', 401);

    const seconds = Math.floor(now() / 1000);
    if (claims.iss !== issuer) throw httpError('JWT issuer is invalid', 401);
    if (!audienceMatches(claims.aud, audience)) throw httpError('JWT audience is invalid', 401);
    if (authorizedParty === undefined && Array.isArray(claims.aud) && claims.aud.length !== 1) {
      throw httpError('Resource JWT must identify exactly one audience', 401);
    }
    if (authorizedParty !== undefined) {
      if (claims.azp !== undefined && claims.azp !== authorizedParty) throw httpError('JWT authorized party is invalid', 401);
      if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== authorizedParty) {
        throw httpError('JWT with multiple audiences must identify the authorized party', 401);
      }
    }
    if (!Number.isFinite(claims.exp) || claims.exp <= seconds - 30) throw httpError('JWT is expired or missing exp', 401);
    if (Number.isFinite(claims.nbf) && claims.nbf > seconds + 30) throw httpError('JWT is not active yet', 401);
    if (authorizedParty !== undefined && (!Number.isFinite(claims.iat) || claims.iat > seconds + 30)) {
      throw httpError('OIDC ID token has an invalid issued-at time', 401);
    }
    if (nonce !== undefined && claims.nonce !== nonce) throw httpError('OIDC nonce does not match', 401);
    return claims;
  }

  function signSession(principal) {
    const seconds = Math.floor(now() / 1000);
    const sessionId = randomBytes(32).toString('base64url');
    const expiresAt = seconds + sessionTtlSeconds;
    sessionDb.prepare(`
      INSERT INTO auth_sessions (id, issuer, subject, email, email_verified, display_name, provider, roles_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      issuer,
      principal.subject,
      principal.email,
      principal.emailVerified ? 1 : 0,
      principal.displayName,
      principal.provider,
      JSON.stringify(principal.roles),
      seconds,
      expiresAt
    );
    sessionDb.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(seconds);
    const payload = base64url(JSON.stringify({
      v: 1,
      sid: sessionId,
      iat: seconds,
      exp: expiresAt
    }));
    const signature = createHmac('sha256', sessionSecret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  function readSessionValue(token) {
    if (!token || mode !== 'oidc') return null;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) return null;
    const expected = createHmac('sha256', sessionSecret).update(payload).digest();
    let actual;
    try { actual = Buffer.from(signature, 'base64url'); } catch { return null; }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    let value;
    try { value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
    if (value.v !== 1 || !value.sid || !Number.isFinite(value.exp) || value.exp <= Math.floor(now() / 1000)) return null;
    return value;
  }

  function readSession(token) {
    const value = readSessionValue(token);
    if (!value) return null;
    const stored = sessionDb.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(value.sid);
    const seconds = Math.floor(now() / 1000);
    if (!stored || stored.issuer !== issuer || stored.expires_at <= seconds || stored.expires_at !== value.exp) {
      if (stored) sessionDb.prepare('DELETE FROM auth_sessions WHERE id = ?').run(value.sid);
      return null;
    }
    const assignment = roleAssignmentFor({ sub: stored.subject, email: stored.email, email_verified: stored.email_verified });
    return {
      type: 'user',
      id: `oidc:${base64url(`${issuer}|${stored.subject}`)}`,
      subject: stored.subject,
      email: stored.email ?? null,
      displayName: stored.display_name,
      provider: stored.provider,
      authentication: 'session',
      // Re-evaluate authorization policy for every request so removing a
      // subject from an allowlist takes effect without waiting for logout.
      roles: assignment.roles,
      roleSource: assignment.source,
      scopes: []
    };
  }

  function revokeSession(req) {
    if (mode !== 'oidc') return;
    const token = parseCookies(req.headers.cookie).get(sessionCookieName);
    const value = readSessionValue(token);
    if (value?.sid) sessionDb.prepare('DELETE FROM auth_sessions WHERE id = ?').run(value.sid);
  }

  function sessionCookie(token, { clear = false } = {}) {
    const parts = [
      `${sessionCookieName}=${clear ? '' : token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      clear ? 'Max-Age=0' : `Max-Age=${sessionTtlSeconds}`
    ];
    if (secureCookies) parts.push('Secure');
    return parts.join('; ');
  }

  async function authenticate(req) {
    if (mode === 'trusted-local') return localPrincipal;
    const authorization = req.headers.authorization;
    if (authorization) {
      return (await authenticateBearer(req, { audience: apiAudience })).principal;
    }
    const token = parseCookies(req.headers.cookie).get(sessionCookieName);
    return readSession(token);
  }

  async function authenticateBearer(req, { audience = apiAudience } = {}) {
    if (mode !== 'oidc') throw httpError('Bearer authentication requires AUTH_MODE=oidc', 503);
    const authorization = req.headers.authorization;
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match) throw httpError('Authorization header must use Bearer', 401);
    const token = match[1];
    const claims = await verifyJwt(token, { audience });
    const principal = makePrincipal(claims, 'bearer');
    const clientId = String(claims.client_id ?? claims.azp ?? claims.sub ?? 'unknown');
    const scopes = scopesFromClaims(claims);
    return {
      principal,
      authInfo: {
        token,
        clientId,
        scopes,
        ...(Number.isFinite(claims.exp) ? { expiresAt: claims.exp } : {}),
        resource: new URL(audience),
        extra: { principal }
      }
    };
  }

  async function authenticateMcpBearer(req) {
    if (mode === 'oidc') return authenticateBearer(req, { audience: mcpAudience });
    if (!localMcpToken) {
      throw httpError('Control-plane MCP requires OIDC or an explicit trusted-local MCP token', 503);
    }
    const authorization = req.headers.authorization;
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match) throw httpError('Authorization header must use Bearer', 401);
    const supplied = Buffer.from(match[1]);
    const expected = Buffer.from(localMcpToken);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw httpError('Bearer token is invalid', 401);
    }
    return {
      principal: localPrincipal,
      authInfo: {
        token: match[1],
        clientId: 'agent-dock-local-mcp',
        scopes: localPrincipal.scopes,
        resource: new URL(mcpAudience),
        extra: { principal: localPrincipal }
      }
    };
  }

  function allows(principal, permission) {
    if (!permission) return true;
    if (!principal) return false;
    if (principal.scopes?.includes('*') || principal.scopes?.includes(permission)) return true;
    return principal.roles?.some((role) => ROLE_PERMISSIONS[role]?.has('*') || ROLE_PERMISSIONS[role]?.has(permission)) ?? false;
  }

  function allowsMcpPrincipal(principal) {
    if (!principal) return false;
    if (principal.type === 'agent') return true;
    if (principal.authentication === 'trusted-local' || principal.roleSource === 'trusted-local') return true;
    if (principal.roleSource === 'explicit') return true;
    return principal.scopes?.some((scope) => ['*', 'fleet:read', 'tasks:execute'].includes(scope)) ?? false;
  }

  function checkCsrf(req, principal) {
    if (!principal || principal.authentication !== 'session' || SAFE_METHODS.has(req.method)) return true;
    if (req.headers['x-agent-dock-csrf'] !== '1') return false;
    const origin = req.headers.origin;
    return !origin || origin === publicOrigin;
  }

  function cleanupTransactions() {
    const cutoff = now() - 10 * 60 * 1000;
    for (const [state, transaction] of transactions) {
      if (transaction.createdAt < cutoff) transactions.delete(state);
    }
    while (transactions.size > 1000) transactions.delete(transactions.keys().next().value);
  }

  async function beginLogin(returnTo = '/') {
    if (mode !== 'oidc') return { location: safeReturnTo(returnTo) };
    cleanupTransactions();
    const metadata = await getDiscovery();
    const state = randomBytes(24).toString('base64url');
    const nonce = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    transactions.set(state, { verifier, nonce, returnTo: safeReturnTo(returnTo), createdAt: now() });
    const authorizationUrl = new URL(metadata.authorization_endpoint);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('client_id', clientId);
    authorizationUrl.searchParams.set('redirect_uri', `${publicOrigin}/auth/callback`);
    authorizationUrl.searchParams.set('scope', requestedScopes);
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('nonce', nonce);
    authorizationUrl.searchParams.set('code_challenge', challenge);
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');
    if (resource) authorizationUrl.searchParams.set('resource', resource);
    return { location: authorizationUrl.href };
  }

  async function completeLogin(url) {
    if (mode !== 'oidc') return { location: '/' };
    const error = url.searchParams.get('error');
    if (error) throw httpError(`Identity provider rejected sign-in: ${error}`, 401);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) throw httpError('OIDC callback is missing code or state', 400);
    const transaction = transactions.get(state);
    transactions.delete(state);
    if (!transaction || transaction.createdAt < now() - 10 * 60 * 1000) throw httpError('OIDC transaction is missing or expired', 401);

    const metadata = await getDiscovery();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${publicOrigin}/auth/callback`,
      client_id: clientId,
      code_verifier: transaction.verifier
    });
    const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    const supported = metadata.token_endpoint_auth_methods_supported ?? [];
    if (clientSecret) {
      const method = tokenEndpointAuthMethod === 'auto'
        ? (supported.includes('client_secret_basic') || !supported.length ? 'client_secret_basic' : 'client_secret_post')
        : tokenEndpointAuthMethod;
      if (method === 'none') {
        throw new Error('AUTH_OIDC_TOKEN_ENDPOINT_AUTH_METHOD=none cannot be combined with AUTH_OIDC_CLIENT_SECRET');
      }
      if (supported.length && !supported.includes(method)) {
        throw new Error(`OIDC token endpoint does not support ${method}`);
      }
      if (method === 'client_secret_basic') {
        headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
      } else if (method === 'client_secret_post') {
        body.set('client_secret', clientSecret);
      } else {
        throw new Error('OIDC token endpoint does not support the configured client-secret authentication');
      }
    } else if (tokenEndpointAuthMethod !== 'none' && supported.length && !supported.includes('none')) {
      throw new Error('OIDC token endpoint requires client authentication but AUTH_OIDC_CLIENT_SECRET is empty');
    }
    if (resource) body.set('resource', resource);
    const response = await fetchImpl(metadata.token_endpoint, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10_000)
    });
    const tokens = await response.json().catch(() => ({}));
    if (!response.ok || !tokens.id_token) throw httpError(tokens.error_description ?? tokens.error ?? 'OIDC token exchange failed', 401);
    const principal = makePrincipal(await verifyJwt(tokens.id_token, {
      audience: clientId,
      nonce: transaction.nonce,
      authorizedParty: clientId
    }), 'session');
    return {
      location: transaction.returnTo,
      cookie: sessionCookie(signSession(principal)),
      principal
    };
  }

  function publicPrincipal(principal) {
    if (!principal) return null;
    return {
      id: principal.id,
      type: principal.type,
      displayName: principal.displayName,
      email: principal.email,
      provider: principal.provider,
      roles: principal.roles
    };
  }

  function loginPage(returnTo = '/', error = null) {
    const target = `/auth/login?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`;
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><title>Sign in — Agent Dock</title>
<style>:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#eef2eb;background:#0b0e0d}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 75% 0,#1b3025 0,transparent 34%),#0b0e0d}.card{width:min(460px,100%);padding:34px;border:1px solid #29302c;background:#121614;box-shadow:0 24px 80px #0008}.mark{width:42px;height:42px;display:grid;place-items:center;margin-bottom:28px;color:#0b0e0d;background:#c7ff4a;font:800 15px ui-monospace,monospace;border-radius:2px}.eyebrow{color:#c7ff4a;font:700 10px ui-monospace,monospace;letter-spacing:.18em}h1{margin:9px 0 13px;font-size:36px;letter-spacing:-.04em}p{color:#8f9992;font-size:14px;line-height:1.6}.button{display:flex;justify-content:space-between;align-items:center;margin-top:28px;padding:14px 16px;color:#0b0e0d;background:#c7ff4a;text-decoration:none;font-weight:750}.fine{margin-top:20px;color:#56605a;font:10px/1.55 ui-monospace,monospace}.error{padding:10px 12px;color:#ffb0b0;background:#ff6b6b12;border:1px solid #ff6b6b55;font-size:12px}</style></head>
<body><main class="card"><div class="mark">A/</div><span class="eyebrow">AGENT DOCK · CONTROL PLANE</span><h1>Authenticate to continue.</h1>
<p>Agent runtimes, schedules, provider sessions, and tool configuration are protected behind your operator identity.</p>
${error ? `<p class="error">${html(error)}</p>` : ''}<a class="button" href="${html(target)}"><span>Continue with ${html(providerName)}</span><span>→</span></a>
<p class="fine">Your provider proves who you are. Agent Dock issues its own session and never reuses this login as a Codex, Claude, or OpenCode credential.</p></main></body></html>`;
  }

  return {
    mode,
    providerName,
    publicOrigin,
    apiAudience,
    mcpAudience,
    authenticate,
    authenticateBearer,
    authenticateMcpBearer,
    allows,
    allowsMcpPrincipal,
    checkCsrf,
    permissionForRequest,
    beginLogin,
    completeLogin,
    loginPage,
    normalizeReturnTo: safeReturnTo,
    publicPrincipal,
    revokeSession,
    clearSessionCookie: () => sessionCookie('', { clear: true }),
    close: () => sessionDb?.close(),
    protectedResourceMetadata: (resourceIdentifier = apiAudience, scopes = [
      'fleet:read',
      'tasks:execute',
      'schedules:manage',
      'usage:refresh',
      'agents:manage',
      'mcp:manage',
      'provider-auth:manage',
      'runtime:manage',
      'workspace:read',
      'control:admin'
    ]) => ({
      resource: resourceIdentifier,
      authorization_servers: issuer ? [issuer] : [],
      bearer_methods_supported: ['header'],
      scopes_supported: scopes
    })
  };
}

export const authPermissions = Object.freeze({
  roles: Object.fromEntries(Object.entries(ROLE_PERMISSIONS).map(([role, permissions]) => [role, [...permissions]])),
  permissionForRequest
});
