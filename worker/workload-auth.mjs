import { createHmac, timingSafeEqual } from 'node:crypto';

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requiredScope(route, method) {
  if (route === '/v1/health' && method === 'GET') return null;
  if (route === '/v1/workspace' && method === 'GET') return 'wrapper:workspace:read';
  if (route.startsWith('/v1/auth/')) return 'wrapper:auth';
  if (route.startsWith('/v1/mcp')) return 'wrapper:mcp';
  if (route.startsWith('/v1/tasks')) return 'wrapper:task';
  if (route === '/v1/usage/refresh') return 'wrapper:usage:refresh';
  if (method === 'GET') return 'wrapper:read';
  return 'wrapper:admin';
}

export function verifyWorkloadToken(token, options = {}) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (header.alg !== 'HS256' || header.typ !== 'JWT') return null;
  const expected = createHmac('sha256', options.secret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  if (!safeEqual(parts[2], expected)) return null;
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (claims.iss !== (options.issuer ?? 'agent-dock-control-plane')) return null;
  if (claims.aud !== options.audience) return null;
  if (!claims.sub || !Number.isFinite(claims.iat) || !Number.isFinite(claims.exp) || claims.exp <= now - 5) return null;
  if (claims.iat > now + 5 || claims.exp > claims.iat + 300) return null;
  if (Number.isFinite(claims.nbf) && claims.nbf > now + 5) return null;
  return {
    subject: claims.sub,
    scopes: typeof claims.scope === 'string' ? claims.scope.split(/\s+/).filter(Boolean) : [],
    expiresAt: claims.exp,
    tokenId: claims.jti ?? null
  };
}

export function authorizeWorkerRequest(req, options = {}) {
  const mode = options.mode ?? 'hybrid';
  const route = options.route ?? req.url;
  const permission = requiredScope(route, req.method);
  if (!permission) return { authenticated: false, permission: null, principal: null };
  const match = req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1] ?? '';

  if (mode !== 'jwt' && safeEqual(token, options.secret)) {
    return { authenticated: true, permission, principal: { subject: 'legacy:control-plane', scopes: ['wrapper:*'] } };
  }
  if (mode === 'token') return { authenticated: false, permission, principal: null };

  const principal = verifyWorkloadToken(token, {
    secret: options.secret,
    issuer: options.issuer,
    audience: `agent-wrapper:${options.agentId}`,
    now: options.now
  });
  const allowed = principal?.scopes.includes('wrapper:*') || principal?.scopes.includes(permission);
  return { authenticated: Boolean(principal && allowed), permission, principal: allowed ? principal : null };
}

export const workerPermissionForRoute = requiredScope;
