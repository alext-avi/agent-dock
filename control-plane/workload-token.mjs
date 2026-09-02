import { createHmac, randomUUID } from 'node:crypto';

export function workloadScopeForRequest(pathname, method = 'GET') {
  const normalizedMethod = method.toUpperCase();
  if (pathname === '/v1/workspace' && normalizedMethod === 'GET') return 'wrapper:workspace:read';
  if (pathname.startsWith('/v1/auth/')) return 'wrapper:auth';
  if (pathname.startsWith('/v1/mcp')) return 'wrapper:mcp';
  if (pathname.startsWith('/v1/tasks')) return 'wrapper:task';
  if (pathname === '/v1/usage/refresh') return 'wrapper:usage:refresh';
  if (normalizedMethod === 'GET') return 'wrapper:read';
  return 'wrapper:admin';
}

export function createWorkloadToken(secret, options = {}) {
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const ttlSeconds = options.ttlSeconds ?? 120;
  const scopes = options.scopes ?? [];
  if (!secret) throw new Error('A workload signing secret is required');
  if (typeof options.audience !== 'string' || !options.audience) throw new Error('A workload audience is required');
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 300) {
    throw new Error('Workload token TTL must be between 1 and 300 seconds');
  }
  if (!Array.isArray(scopes) || !scopes.length || scopes.some((scope) => typeof scope !== 'string' || !scope)) {
    throw new Error('At least one workload scope is required');
  }
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: options.issuer ?? 'agent-dock-control-plane',
    sub: options.subject ?? 'service:control-plane',
    aud: options.audience,
    scope: scopes.join(' '),
    iat: now,
    nbf: now - 5,
    exp: now + ttlSeconds,
    jti: randomUUID()
  })).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}
