import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

async function readBody(req, limit = 192 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request body is too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const body = await readBody(req);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Body must be valid JSON'), { status: 400 });
  }
}

function publicAgent(agent) {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    adapter: agent.adapter,
    durablePrompt: agent.durablePrompt,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt
  };
}

function stringField(value, name, { required = false, max = 500 } = {}) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw Object.assign(new Error(`${name} must be a string`), { status: 400 });
  const normalized = value.trim();
  if (required && !normalized) throw Object.assign(new Error(`${name} is required`), { status: 400 });
  if (normalized.length > max) throw Object.assign(new Error(`${name} is too long`), { status: 413 });
  return normalized;
}

function normalizeWorkerUrl(value, { required = false } = {}) {
  const normalized = stringField(value, 'workerUrl', { required, max: 2048 });
  if (normalized === undefined || normalized === '') return normalized;
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw Object.assign(new Error('workerUrl must be a valid URL'), { status: 400 });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw Object.assign(new Error('workerUrl must use http or https'), { status: 400 });
  }
  return normalized.replace(/\/$/, '');
}

function makeAgent(input, existingIds, defaults = {}) {
  const now = new Date().toISOString();
  const name = stringField(input.name ?? defaults.name, 'name', { required: true, max: 120 });
  const requestedId = stringField(input.id, 'id', { max: 80 });
  const baseId = (requestedId || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent').slice(0, 72);
  if (requestedId && !/^[a-z0-9][a-z0-9-]*$/.test(requestedId)) {
    throw Object.assign(new Error('id must contain lowercase letters, numbers, and hyphens only'), { status: 400 });
  }
  let id = baseId;
  while (existingIds.has(id)) id = `${baseId.slice(0, 63)}-${randomUUID().slice(0, 8)}`;
  const adapter = stringField(input.adapter ?? defaults.adapter ?? 'codex-cli', 'adapter', { required: true, max: 80 });
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(adapter)) {
    throw Object.assign(new Error('adapter contains unsupported characters'), { status: 400 });
  }
  return {
    id,
    name,
    description: stringField(input.description ?? defaults.description ?? '', 'description', { max: 2000 }) ?? '',
    adapter,
    durablePrompt: stringField(input.durablePrompt ?? defaults.durablePrompt ?? '', 'durablePrompt', { max: 50_000 }) ?? '',
    workerUrl: normalizeWorkerUrl(input.workerUrl ?? defaults.workerUrl ?? '', { required: false }) ?? '',
    workerToken: stringField(input.workerToken ?? defaults.workerToken ?? '', 'workerToken', { max: 4096 }) ?? '',
    createdAt: now,
    updatedAt: now
  };
}

export function createControlPlane(options = {}) {
  const config = {
    workerUrl: (options.workerUrl ?? process.env.WORKER_URL ?? 'http://127.0.0.1:7777').replace(/\/$/, ''),
    workerToken: options.workerToken ?? process.env.WORKER_TOKEN ?? '',
    publicDir: options.publicDir ?? join(moduleDir, 'public'),
    dataPath: options.dataPath === null ? null : (options.dataPath ?? process.env.CONTROL_PLANE_DATA_PATH ?? null),
    defaultAgentId: options.defaultAgentId ?? process.env.DEFAULT_AGENT_ID ?? 'worker-01'
  };
  if (!config.workerToken) throw new Error('WORKER_TOKEN is required');

  const agents = new Map();
  let persistQueue = Promise.resolve();
  const defaultAgent = () => agents.get(config.defaultAgentId) ?? agents.values().next().value ?? null;

  async function persistAgents() {
    if (!config.dataPath) return;
    const payload = { schemaVersion: 1, agents: [...agents.values()] };
    persistQueue = persistQueue.then(async () => {
      await mkdir(dirname(config.dataPath), { recursive: true });
      const temporary = `${config.dataPath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, config.dataPath);
    });
    return persistQueue;
  }

  async function loadAgents() {
    if (config.dataPath) {
      try {
        const stored = JSON.parse(await readFile(config.dataPath, 'utf8'));
        if (!Array.isArray(stored.agents)) throw new Error('agents must be an array');
        for (const agent of stored.agents) {
          if (agent?.id && agent?.name) agents.set(agent.id, agent);
        }
        return;
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error(`Could not load agent registry: ${error.message}`);
      }
    }
    const seeded = makeAgent({ id: config.defaultAgentId }, new Set(), {
      name: options.defaultAgentName ?? process.env.DEFAULT_AGENT_NAME ?? 'Codex Worker 01',
      description: 'Default containerized agent',
      adapter: 'codex-cli',
      durablePrompt: '',
      workerUrl: config.workerUrl,
      workerToken: config.workerToken
    });
    agents.set(seeded.id, seeded);
    await persistAgents();
  }

  const registryReady = loadAgents();

  function requireAgent(id) {
    const agent = agents.get(id);
    if (!agent) throw Object.assign(new Error('Agent not found'), { status: 404 });
    return agent;
  }

  function requireRunnableAgent(agent) {
    if (!agent.workerUrl || !agent.workerToken) {
      throw Object.assign(new Error('Agent runtime is not configured'), { status: 409 });
    }
    return agent;
  }

  async function workerFetch(agent, pathname, init = {}) {
    requireRunnableAgent(agent);
    return fetch(`${agent.workerUrl}${pathname}`, {
      ...init,
      headers: {
        authorization: `Bearer ${agent.workerToken}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers
      },
      signal: AbortSignal.timeout(init.timeout ?? 15_000)
    });
  }

  async function proxyJson(req, res, agent, pathname, timeout = 15_000) {
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : null;
    const upstream = await workerFetch(agent, pathname, { method: req.method, body: body?.length ? body : undefined, timeout });
    const text = await upstream.text();
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });
    res.end(text);
  }

  async function proxyTask(req, res, agent) {
    const request = await readJson(req);
    const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : '';
    if (!prompt) return json(res, 400, { error: 'prompt is required' });
    const body = JSON.stringify({ ...request, prompt, instructions: agent.durablePrompt });
    const upstream = await workerFetch(agent, '/v1/tasks', { method: 'POST', body, timeout: 24 * 60 * 60 * 1000 });
    if (!upstream.ok || !upstream.body) {
      const message = await upstream.text();
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });
      return res.end(message);
    }
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no'
    });
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  }

  async function serveStatic(res, pathname) {
    const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
    const safe = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '');
    let file = join(config.publicDir, safe);
    if (!file.startsWith(config.publicDir)) return json(res, 403, { error: 'Forbidden' });
    let metadata = await stat(file).catch(() => null);
    if (!metadata?.isFile() && !extname(pathname)) {
      file = join(config.publicDir, 'index.html');
      metadata = await stat(file).catch(() => null);
    }
    if (!metadata?.isFile()) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'content-length': metadata.size,
      'cache-control': 'no-store'
    });
    createReadStream(file).pipe(res);
  }

  async function handleAgentCrud(req, res, url) {
    if (url.pathname === '/api/v1/agents') {
      if (req.method === 'GET') return json(res, 200, { agents: [...agents.values()].map(publicAgent) });
      if (req.method === 'POST') {
        const body = await readJson(req);
        const agent = makeAgent(body, new Set(agents.keys()));
        agents.set(agent.id, agent);
        await persistAgents();
        return json(res, 201, { agent: publicAgent(agent) });
      }
      return false;
    }

    const match = url.pathname.match(/^\/api\/v1\/agents\/([^/]+)$/);
    if (!match) return false;
    const id = decodeURIComponent(match[1]);
    const agent = requireAgent(id);
    if (req.method === 'GET') return json(res, 200, { agent: publicAgent(agent) });
    if (req.method === 'PATCH') {
      const body = await readJson(req);
      const updated = { ...agent };
      if ('name' in body) updated.name = stringField(body.name, 'name', { required: true, max: 120 });
      if ('description' in body) updated.description = stringField(body.description, 'description', { max: 2000 });
      if ('adapter' in body) {
        updated.adapter = stringField(body.adapter, 'adapter', { required: true, max: 80 });
        if (!/^[a-z0-9][a-z0-9._-]*$/.test(updated.adapter)) throw Object.assign(new Error('adapter contains unsupported characters'), { status: 400 });
      }
      if ('durablePrompt' in body) updated.durablePrompt = stringField(body.durablePrompt, 'durablePrompt', { max: 50_000 });
      if ('workerUrl' in body) updated.workerUrl = normalizeWorkerUrl(body.workerUrl, { required: false });
      if (typeof body.workerToken === 'string' && body.workerToken.trim()) updated.workerToken = stringField(body.workerToken, 'workerToken', { max: 4096 });
      if (body.clearWorkerToken === true) updated.workerToken = '';
      updated.updatedAt = new Date().toISOString();
      agents.set(id, updated);
      await persistAgents();
      return json(res, 200, { agent: publicAgent(updated) });
    }
    if (req.method === 'DELETE') {
      agents.delete(id);
      await persistAgents();
      res.writeHead(204, { 'cache-control': 'no-store' });
      return res.end();
    }
    return false;
  }

  async function handleAgentOperation(req, res, url) {
    const match = url.pathname.match(/^\/api\/v1\/agents\/([^/]+)\/(status|auth\/login|auth\/refresh|workspace|usage|usage\/refresh|tasks|tasks\/cancel)$/);
    if (!match) return false;
    const agent = requireAgent(decodeURIComponent(match[1]));
    const operation = match[2];
    if (req.method === 'GET' && operation === 'status') return proxyJson(req, res, agent, '/v1/status');
    if (req.method === 'POST' && operation === 'auth/login') return proxyJson(req, res, agent, '/v1/auth/login');
    if (req.method === 'POST' && operation === 'auth/refresh') return proxyJson(req, res, agent, '/v1/auth/refresh', 30_000);
    if (req.method === 'GET' && operation === 'workspace') return proxyJson(req, res, agent, '/v1/workspace');
    if (req.method === 'GET' && operation === 'usage') return proxyJson(req, res, agent, '/v1/usage');
    if (req.method === 'POST' && operation === 'usage/refresh') return proxyJson(req, res, agent, '/v1/usage/refresh', 30_000);
    if (req.method === 'POST' && operation === 'tasks/cancel') return proxyJson(req, res, agent, '/v1/tasks/cancel');
    if (req.method === 'POST' && operation === 'tasks') return proxyTask(req, res, agent);
    return false;
  }

  return createServer(async (req, res) => {
    try {
      await registryReady;
      const url = new URL(req.url, 'http://control.local');
      const crud = await handleAgentCrud(req, res, url);
      if (crud !== false) return crud;
      const operation = await handleAgentOperation(req, res, url);
      if (operation !== false) return operation;

      const agent = defaultAgent();
      if (req.method === 'GET' && ['/api/v1/health', '/api/health'].includes(url.pathname)) {
        if (!agent?.workerUrl) return json(res, 200, { ok: true, worker: 'unconfigured' });
        try {
          const upstream = await fetch(`${agent.workerUrl}/v1/health`, { signal: AbortSignal.timeout(2000) });
          return json(res, 200, { ok: true, worker: upstream.ok ? 'online' : 'unhealthy' });
        } catch {
          return json(res, 200, { ok: true, worker: 'offline' });
        }
      }
      if (!agent && url.pathname.startsWith('/api/')) return json(res, 404, { error: 'No agents configured' });
      if (req.method === 'GET' && ['/api/v1/status', '/api/status'].includes(url.pathname)) return proxyJson(req, res, agent, '/v1/status');
      if (req.method === 'POST' && ['/api/v1/auth/login', '/api/auth/start'].includes(url.pathname)) return proxyJson(req, res, agent, '/v1/auth/login');
      if (req.method === 'POST' && ['/api/v1/auth/refresh', '/api/auth/refresh'].includes(url.pathname)) return proxyJson(req, res, agent, '/v1/auth/refresh', 30_000);
      if (req.method === 'GET' && ['/api/v1/workspace', '/api/workspace'].includes(url.pathname)) return proxyJson(req, res, agent, '/v1/workspace');
      if (req.method === 'GET' && ['/api/v1/usage', '/api/usage'].includes(url.pathname)) return proxyJson(req, res, agent, '/v1/usage');
      if (req.method === 'POST' && ['/api/v1/usage/refresh', '/api/usage/refresh'].includes(url.pathname)) return proxyJson(req, res, agent, '/v1/usage/refresh', 30_000);
      if (req.method === 'POST' && ['/api/v1/tasks/cancel', '/api/run/cancel'].includes(url.pathname)) return proxyJson(req, res, agent, '/v1/tasks/cancel');
      if (req.method === 'POST' && ['/api/v1/tasks', '/api/run'].includes(url.pathname)) return proxyTask(req, res, agent);
      if (req.method === 'GET') return serveStatic(res, url.pathname);
      return json(res, 404, { error: 'Not found' });
    } catch (error) {
      if (!res.headersSent) {
        const offline = error.name === 'TimeoutError' || error.cause?.code === 'ECONNREFUSED';
        json(res, offline ? 503 : (error.status ?? 500), { error: offline ? 'Worker is unavailable' : error.message });
      } else {
        res.end();
      }
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  const server = createControlPlane();
  server.listen(port, '0.0.0.0', () => console.log(`[control-plane] http://localhost:${port}`));
}
