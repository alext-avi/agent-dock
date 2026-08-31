import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDockerRuntimeManager } from './docker-runtime.mjs';
import { createMcpService, normalizeStoredMcpDefinition } from './mcp-service.mjs';

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

function publicRuntime(runtime, binding = null, attachmentCount = 0) {
  if (!runtime) {
    return {
      id: null,
      workerId: null,
      binding: 'unprovisioned',
      dedicated: false,
      managed: false,
      state: 'unprovisioned',
      credentials: 'none',
      storage: { auth: 'none', binary: 'none', telemetry: 'none', workspace: 'none' }
    };
  }
  const resolvedBinding = binding
    ?? (runtime.kind === 'legacy-shared' ? 'shared-legacy' : attachmentCount === 0 ? 'retained' : attachmentCount > 1 ? 'attached' : 'dedicated');
  const isolated = runtime.kind === 'managed-dedicated';
  return {
    id: runtime.id,
    workerId: runtime.workerId ?? null,
    adapter: runtime.adapter,
    binding: resolvedBinding,
    dedicated: isolated,
    managed: runtime.managed === true,
    state: runtime.state ?? (runtime.managed ? 'unknown' : 'external'),
    credentials: isolated ? 'isolated-worker-local' : 'shared-worker-local',
    storage: {
      auth: isolated ? 'isolated' : 'shared',
      binary: isolated ? 'isolated' : 'shared',
      telemetry: isolated ? 'isolated' : 'shared',
      workspace: isolated ? 'isolated' : 'shared'
    },
    attachmentCount,
    // The image tag this runtime is actually running, so drift from the
    // configured image is visible rather than silent. A local tag, not a secret.
    image: runtime.image ?? null,
    // True when the configured image has been rebuilt since this container was
    // created, null when either side is unknown. Refreshing clears it.
    outdated: runtime.outdated ?? null,
    createdAt: runtime.createdAt ?? null,
    updatedAt: runtime.updatedAt ?? null
  };
}

function publicAgent(agent, runtime = null, attachmentCount = 0) {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    adapter: agent.adapter,
    durablePrompt: agent.durablePrompt,
    modelPolicy: agent.modelPolicy,
    runtime: publicRuntime(runtime, agent.runtimeBinding, attachmentCount),
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt
  };
}

function normalizeModelPolicy(value = {}) {
  if (value === null || value === undefined) value = {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('modelPolicy must be an object'), { status: 400 });
  }
  const mode = value.mode ?? 'provider-default';
  if (!['provider-default', 'pinned'].includes(mode)) {
    throw Object.assign(new Error('modelPolicy.mode must be provider-default or pinned'), { status: 400 });
  }
  const primary = value.primary === null || value.primary === undefined
    ? null
    : stringField(value.primary, 'modelPolicy.primary', { required: true, max: 240 });
  if (mode === 'pinned' && !primary) {
    throw Object.assign(new Error('modelPolicy.primary is required when a model is pinned'), { status: 400 });
  }
  if (value.fallbacks !== undefined && !Array.isArray(value.fallbacks)) {
    throw Object.assign(new Error('modelPolicy.fallbacks must be an array'), { status: 400 });
  }
  const fallbacks = (value.fallbacks ?? []).map((model, index) => (
    stringField(model, `modelPolicy.fallbacks[${index}]`, { required: true, max: 240 })
  ));
  if (fallbacks.length > 8) throw Object.assign(new Error('modelPolicy supports at most 8 fallbacks'), { status: 400 });
  return {
    mode,
    primary: mode === 'pinned' ? primary : null,
    fallbacks: [...new Set(fallbacks.filter((model) => model !== primary))],
    externalFallback: value.externalFallback === true
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
    modelPolicy: normalizeModelPolicy(input.modelPolicy ?? defaults.modelPolicy),
    runtimeId: input.runtimeId ?? defaults.runtimeId ?? null,
    runtimeBinding: input.runtimeBinding ?? defaults.runtimeBinding ?? 'unprovisioned',
    createdAt: now,
    updatedAt: now
  };
}

function normalizeRuntimeRequest(value, defaultMode) {
  if (value === undefined || value === null) return { mode: defaultMode };
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('runtime must be an object'), { status: 400 });
  }
  const mode = value.mode ?? defaultMode;
  if (!['provision', 'attach', 'unprovisioned'].includes(mode)) {
    throw Object.assign(new Error('runtime.mode must be provision, attach, or unprovisioned'), { status: 400 });
  }
  const id = value.id === undefined ? undefined : stringField(value.id, 'runtime.id', { required: true, max: 120 });
  if (mode === 'attach' && !id) throw Object.assign(new Error('runtime.id is required when attaching'), { status: 400 });
  return { mode, id };
}

export function createControlPlane(options = {}) {
  const primaryWorkerToken = options.workerToken ?? process.env.WORKER_TOKEN ?? '';
  const runtimeManager = options.runtimeManager !== undefined
    ? options.runtimeManager
    : process.env.RUNTIME_PROVISIONER === 'docker'
      ? createDockerRuntimeManager()
      : null;
  const config = {
    workerUrl: (options.workerUrl ?? process.env.WORKER_URL ?? 'http://127.0.0.1:7777').replace(/\/$/, ''),
    workerToken: primaryWorkerToken,
    legacyTemplates: {
      'codex-cli': {
        runtimeId: 'legacy-codex-cli',
        workerId: options.workerId ?? process.env.WORKER_ID ?? 'worker-01',
        workerUrl: (options.workerUrl ?? process.env.WORKER_URL ?? 'http://127.0.0.1:7777').replace(/\/$/, ''),
        workerToken: primaryWorkerToken
      },
      'claude-code': {
        runtimeId: 'legacy-claude-code',
        workerId: options.claudeWorkerId ?? process.env.CLAUDE_WORKER_ID ?? 'claude-worker-01',
        workerUrl: (options.claudeWorkerUrl ?? process.env.CLAUDE_WORKER_URL ?? '').replace(/\/$/, ''),
        workerToken: options.claudeWorkerToken ?? process.env.CLAUDE_WORKER_TOKEN ?? primaryWorkerToken
      },
      opencode: {
        runtimeId: 'legacy-opencode',
        workerId: options.opencodeWorkerId ?? process.env.OPENCODE_WORKER_ID ?? 'opencode-worker-01',
        workerUrl: (options.opencodeWorkerUrl ?? process.env.OPENCODE_WORKER_URL ?? '').replace(/\/$/, ''),
        workerToken: options.opencodeWorkerToken ?? process.env.OPENCODE_WORKER_TOKEN ?? primaryWorkerToken
      }
    },
    publicDir: options.publicDir ?? join(moduleDir, 'public'),
    dataPath: options.dataPath === null ? null : (options.dataPath ?? process.env.CONTROL_PLANE_DATA_PATH ?? null),
    defaultAgentId: options.defaultAgentId ?? process.env.DEFAULT_AGENT_ID ?? 'worker-01'
  };
  if (!config.workerToken) throw new Error('WORKER_TOKEN is required');

  const agents = new Map();
  const runtimes = new Map();
  const mcpServers = new Map();
  const mcpBindings = new Map();
  let persistQueue = Promise.resolve();
  const defaultAgent = () => agents.get(config.defaultAgentId) ?? agents.values().next().value ?? null;
  const attachmentCount = (runtimeId) => [...agents.values()].filter((agent) => agent.runtimeId === runtimeId).length;
  const agentPublic = (agent) => publicAgent(agent, agent.runtimeId ? runtimes.get(agent.runtimeId) : null, attachmentCount(agent.runtimeId));

  async function persistAgents() {
    if (!config.dataPath) return;
    const payload = {
      schemaVersion: 3,
      agents: [...agents.values()],
      runtimes: [...runtimes.values()],
      mcpServers: [...mcpServers.values()],
      mcpBindings: [...mcpBindings.values()]
    };
    persistQueue = persistQueue.then(async () => {
      await mkdir(dirname(config.dataPath), { recursive: true });
      const temporary = `${config.dataPath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, config.dataPath);
    });
    return persistQueue;
  }

  function addLegacyRuntime(adapter, source = {}) {
    if (!source.workerUrl || !source.workerToken) return null;
    const existing = [...runtimes.values()].find((runtime) => (
      runtime.kind === 'legacy-shared'
      && runtime.adapter === adapter
      && runtime.workerUrl === source.workerUrl
      && runtime.workerToken === source.workerToken
    ));
    if (existing) return existing;
    let id = source.runtimeId ?? `legacy-${adapter}`;
    while (runtimes.has(id)) id = `${source.runtimeId ?? `legacy-${adapter}`}-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const runtime = {
      id,
      adapter,
      kind: 'legacy-shared',
      managed: false,
      dedicated: false,
      workerId: source.workerId ?? null,
      workerUrl: source.workerUrl,
      workerToken: source.workerToken,
      state: 'external',
      createdAt: source.createdAt ?? now,
      updatedAt: source.updatedAt ?? now
    };
    runtimes.set(runtime.id, runtime);
    return runtime;
  }

  function normalizeStoredAgent(agent) {
    const normalized = {
      id: agent.id,
      name: agent.name,
      description: agent.description ?? '',
      adapter: agent.adapter ?? 'codex-cli',
      durablePrompt: agent.durablePrompt ?? '',
      modelPolicy: normalizeModelPolicy(agent.modelPolicy),
      runtimeId: agent.runtimeId ?? null,
      runtimeBinding: agent.runtimeBinding ?? (agent.runtimeId ? 'attached' : 'unprovisioned'),
      createdAt: agent.createdAt ?? new Date().toISOString(),
      updatedAt: agent.updatedAt ?? new Date().toISOString()
    };
    return normalized;
  }

  async function loadAgents() {
    let migrated = false;
    if (config.dataPath) {
      try {
        const stored = JSON.parse(await readFile(config.dataPath, 'utf8'));
        if (!Array.isArray(stored.agents)) throw new Error('agents must be an array');
        if (stored.schemaVersion >= 2 && Array.isArray(stored.runtimes)) {
          for (const runtime of stored.runtimes) {
            if (runtime?.id && runtime?.adapter) runtimes.set(runtime.id, runtime);
          }
          for (const agent of stored.agents) {
            if (agent?.id && agent?.name) agents.set(agent.id, normalizeStoredAgent(agent));
          }
          if (stored.schemaVersion >= 3) {
            for (const server of stored.mcpServers ?? []) {
              if (server?.id && server?.name) mcpServers.set(server.id, normalizeStoredMcpDefinition(server));
            }
            for (const binding of stored.mcpBindings ?? []) {
              if (!binding?.agentId || !binding?.serverId) continue;
              const id = `${binding.agentId}:${binding.serverId}`;
              mcpBindings.set(id, {
                id,
                agentId: binding.agentId,
                serverId: binding.serverId,
                enabled: binding.enabled !== false,
                state: binding.state ?? 'pending',
                error: binding.error ?? null,
                appliedAt: binding.appliedAt ?? null,
                createdAt: binding.createdAt ?? new Date().toISOString(),
                updatedAt: binding.updatedAt ?? new Date().toISOString()
              });
            }
          } else {
            migrated = true;
          }
        } else {
          migrated = true;
          for (const storedAgent of stored.agents) {
            if (!storedAgent?.id || !storedAgent?.name) continue;
            const runtime = storedAgent.workerUrl && storedAgent.workerToken
              ? addLegacyRuntime(storedAgent.adapter ?? 'codex-cli', {
                  workerUrl: storedAgent.workerUrl,
                  workerToken: storedAgent.workerToken,
                  workerId: config.legacyTemplates[storedAgent.adapter ?? 'codex-cli']?.workerId,
                  createdAt: storedAgent.createdAt,
                  updatedAt: storedAgent.updatedAt
                })
              : null;
            agents.set(storedAgent.id, normalizeStoredAgent({
              ...storedAgent,
              runtimeId: runtime?.id ?? null,
              runtimeBinding: runtime ? 'shared-legacy' : 'unprovisioned'
            }));
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error(`Could not load agent registry: ${error.message}`);
      }
    }
    for (const [adapter, template] of Object.entries(config.legacyTemplates)) addLegacyRuntime(adapter, template);
    if (!agents.size) {
      const runtime = runtimes.get(config.legacyTemplates['codex-cli'].runtimeId)
        ?? [...runtimes.values()].find((candidate) => candidate.adapter === 'codex-cli');
      const seeded = makeAgent({ id: config.defaultAgentId }, new Set(), {
        name: options.defaultAgentName ?? process.env.DEFAULT_AGENT_NAME ?? 'Codex Worker 01',
        description: 'Default containerized agent',
        adapter: 'codex-cli',
        durablePrompt: '',
        runtimeId: runtime?.id ?? null,
        runtimeBinding: runtime ? 'shared-legacy' : 'unprovisioned'
      });
      agents.set(seeded.id, seeded);
      migrated = true;
    }
    if (migrated || config.dataPath) await persistAgents();
  }

  const registryReady = loadAgents();

  function requireAgent(id) {
    const agent = agents.get(id);
    if (!agent) throw Object.assign(new Error('Agent not found'), { status: 404 });
    return agent;
  }

  function requireRuntime(id) {
    const runtime = runtimes.get(id);
    if (!runtime) throw Object.assign(new Error('Runtime not found'), { status: 404 });
    return runtime;
  }

  function requireRunnableAgent(agent) {
    const runtime = agent.runtimeId ? runtimes.get(agent.runtimeId) : null;
    if (!runtime?.workerUrl || !runtime?.workerToken) {
      throw Object.assign(new Error('Agent runtime is not configured'), { status: 409 });
    }
    if (runtime.adapter !== agent.adapter) {
      throw Object.assign(new Error('Agent and runtime adapters do not match'), { status: 409 });
    }
    return runtime;
  }

  async function workerFetch(agent, pathname, init = {}) {
    const runtime = requireRunnableAgent(agent);
    const response = await fetch(`${runtime.workerUrl}${pathname}`, {
      ...init,
      headers: {
        authorization: `Bearer ${runtime.workerToken}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers
      },
      signal: AbortSignal.timeout(init.timeout ?? 15_000)
    });
    if (response.ok && runtime.managed && runtime.state !== 'running') {
      runtime.state = 'running';
      runtime.updatedAt = new Date().toISOString();
    }
    return { response, runtime };
  }

  async function workerRequest(agent, method, pathname, body = undefined, timeout = 30_000) {
    const { response } = await workerFetch(agent, pathname, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      timeout
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) {
      const validationMessage = value.mcp?.validation?.errors?.map((item) => item.message).filter(Boolean).join('; ');
      throw Object.assign(new Error(value.error ?? validationMessage ?? `Worker returned HTTP ${response.status}`), { status: response.status });
    }
    return value;
  }

  const mcpService = createMcpService({
    servers: mcpServers,
    bindings: mcpBindings,
    agents,
    persist: persistAgents,
    workerRequest
  });

  async function proxyJson(req, res, agent, pathname, timeout = 15_000) {
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : null;
    const { response: upstream, runtime } = await workerFetch(agent, pathname, { method: req.method, body: body?.length ? body : undefined, timeout });
    const text = await upstream.text();
    if (upstream.ok && runtime.managed && pathname === '/v1/status') {
      try {
        const status = JSON.parse(text);
        if (status.agent?.id && status.agent.id !== runtime.workerId) {
          throw Object.assign(new Error('Runtime worker identity does not match its control-plane binding'), { status: 502 });
        }
      } catch (error) {
        if (error.status === 502) throw error;
      }
    }
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });
    res.end(text);
  }

  async function proxyTask(req, res, agent) {
    const request = await readJson(req);
    const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : '';
    if (!prompt) return json(res, 400, { error: 'prompt is required' });
    const body = JSON.stringify({ ...request, prompt, instructions: agent.durablePrompt, modelPolicy: agent.modelPolicy });
    const { response: upstream } = await workerFetch(agent, '/v1/tasks', { method: 'POST', body, timeout: 24 * 60 * 60 * 1000 });
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
    if (url.pathname === '/api/v1/runtimes') {
      if (req.method !== 'GET') return false;
      if (runtimeManager) {
        await Promise.all([...runtimes.values()].filter((runtime) => runtime.managed).map(async (runtime) => {
          try {
            const inspected = await runtimeManager.inspect(runtime);
            runtime.state = inspected.state;
            runtime.health = inspected.health;
            runtime.image = inspected.image ?? runtime.image ?? null;
            // Keep the cached id current. A container replaced out of band moves
            // its id, and a stale one costs a needless name lookup every time.
            if (inspected.containerId) runtime.containerId = inspected.containerId;
            runtime.imageId = inspected.imageId ?? runtime.imageId ?? null;
            const current = await runtimeManager.currentImageId(runtime.adapter);
            // Only claim staleness when both sides are known. An unknown image
            // is reported as unknown rather than guessed either way.
            runtime.outdated = current && runtime.imageId ? current !== runtime.imageId : null;
            runtime.updatedAt = new Date().toISOString();
          } catch {
            runtime.state = 'unknown';
          }
        }));
      }
      return json(res, 200, {
        runtimes: [...runtimes.values()].map((runtime) => publicRuntime(runtime, null, attachmentCount(runtime.id)))
      });
    }

    if (url.pathname === '/api/v1/agents') {
      if (req.method === 'GET') return json(res, 200, { agents: [...agents.values()].map(agentPublic) });
      if (req.method === 'POST') {
        const body = await readJson(req);
        const agent = makeAgent(body, new Set(agents.keys()));
        const runtimeRequest = normalizeRuntimeRequest(body.runtime, runtimeManager ? 'provision' : 'unprovisioned');
        let runtime = null;
        try {
          if (runtimeRequest.mode === 'provision') {
            if (!runtimeManager) throw Object.assign(new Error('Dedicated runtime provisioning is unavailable'), { status: 503 });
            runtime = await runtimeManager.provision({ agentId: agent.id, adapter: agent.adapter });
            runtimes.set(runtime.id, runtime);
            agent.runtimeId = runtime.id;
            agent.runtimeBinding = 'dedicated';
          } else if (runtimeRequest.mode === 'attach') {
            runtime = requireRuntime(runtimeRequest.id);
            if (runtime.adapter !== agent.adapter) {
              throw Object.assign(new Error('The selected runtime uses a different adapter'), { status: 409 });
            }
            if (attachmentCount(runtime.id) !== 0) {
              throw Object.assign(new Error('The selected runtime is already bound to another agent'), { status: 409 });
            }
            if (runtime.managed) {
              if (!runtimeManager) throw Object.assign(new Error('The managed runtime provisioner is unavailable'), { status: 503 });
              await runtimeManager.start(runtime);
              runtime.state = 'starting';
            }
            runtime.updatedAt = new Date().toISOString();
            agent.runtimeId = runtime.id;
            agent.runtimeBinding = runtime.kind === 'legacy-shared' ? 'shared-legacy' : 'attached';
          }
          agents.set(agent.id, agent);
          await persistAgents();
          return json(res, 201, { agent: agentPublic(agent) });
        } catch (error) {
          agents.delete(agent.id);
          if (runtimeRequest.mode === 'provision' && runtime) {
            runtimes.delete(runtime.id);
            await runtimeManager.destroy(runtime).catch(() => {});
          }
          throw error;
        }
      }
      return false;
    }

    const match = url.pathname.match(/^\/api\/v1\/agents\/([^/]+)$/);
    if (!match) return false;
    const id = decodeURIComponent(match[1]);
    const agent = requireAgent(id);
    if (req.method === 'GET') return json(res, 200, { agent: agentPublic(agent) });
    if (req.method === 'PATCH') {
      const body = await readJson(req);
      const updated = { ...agent };
      if ('name' in body) updated.name = stringField(body.name, 'name', { required: true, max: 120 });
      if ('description' in body) updated.description = stringField(body.description, 'description', { max: 2000 });
      if ('adapter' in body) {
        const nextAdapter = stringField(body.adapter, 'adapter', { required: true, max: 80 });
        if (agent.runtimeId && nextAdapter !== agent.adapter) {
          throw Object.assign(new Error('Detach or replace the runtime before changing adapters'), { status: 409 });
        }
        updated.adapter = nextAdapter;
        if (!/^[a-z0-9][a-z0-9._-]*$/.test(updated.adapter)) throw Object.assign(new Error('adapter contains unsupported characters'), { status: 400 });
      }
      if ('durablePrompt' in body) updated.durablePrompt = stringField(body.durablePrompt, 'durablePrompt', { max: 50_000 });
      if ('modelPolicy' in body) updated.modelPolicy = normalizeModelPolicy(body.modelPolicy);
      updated.updatedAt = new Date().toISOString();
      agents.set(id, updated);
      await persistAgents();
      return json(res, 200, { agent: agentPublic(updated) });
    }
    if (req.method === 'DELETE') {
      const body = await readJson(req);
      const runtime = agent.runtimeId ? runtimes.get(agent.runtimeId) : null;
      const runtimeAction = body.runtimeAction ?? (runtime ? null : 'retain');
      if (runtime && !['retain', 'destroy'].includes(runtimeAction)) {
        throw Object.assign(new Error('runtimeAction must explicitly be retain or destroy'), { status: 400 });
      }
      if (runtimeAction === 'destroy') {
        if (body.confirmation !== agent.id) {
          throw Object.assign(new Error('confirmation must exactly match the agent id before destroying its runtime and credentials'), { status: 400 });
        }
        if (!runtime?.managed) {
          throw Object.assign(new Error('Legacy or external runtimes cannot be destroyed by Agent Dock'), { status: 409 });
        }
        if (attachmentCount(runtime.id) > 1) {
          throw Object.assign(new Error('Runtime is still attached to another agent'), { status: 409 });
        }
        if (!runtimeManager) throw Object.assign(new Error('The managed runtime provisioner is unavailable'), { status: 503 });
        await runtimeManager.destroy(runtime);
        runtimes.delete(runtime.id);
      } else if (runtime?.managed) {
        if (!runtimeManager) throw Object.assign(new Error('The managed runtime provisioner is unavailable'), { status: 503 });
        await runtimeManager.stop(runtime);
        runtime.state = 'stopped';
        runtime.updatedAt = new Date().toISOString();
      }
      agents.delete(id);
      for (const [bindingId, binding] of mcpBindings) {
        if (binding.agentId === id) mcpBindings.delete(bindingId);
      }
      await persistAgents();
      res.writeHead(204, { 'cache-control': 'no-store' });
      return res.end();
    }
    return false;
  }

  async function handleMcp(req, res, url) {
    if (url.pathname === '/api/v1/mcp/servers') {
      if (req.method === 'GET') return json(res, 200, { servers: mcpService.listServers() });
      if (req.method === 'POST') return json(res, 201, { server: await mcpService.createServer(await readJson(req)) });
      return false;
    }

    const serverMatch = url.pathname.match(/^\/api\/v1\/mcp\/servers\/([^/]+)$/);
    if (serverMatch) {
      const serverId = decodeURIComponent(serverMatch[1]);
      if (req.method === 'GET') return json(res, 200, { server: mcpService.getServer(serverId) });
      if (req.method === 'PATCH') return json(res, 200, { server: await mcpService.updateServer(serverId, await readJson(req)) });
      if (req.method === 'DELETE') {
        await mcpService.deleteServer(serverId);
        res.writeHead(204, { 'cache-control': 'no-store' });
        return res.end();
      }
      return false;
    }

    const agentMatch = url.pathname.match(/^\/api\/v1\/agents\/([^/]+)\/mcp(?:\/(apply|validate|bindings)(?:\/([^/]+))?)?$/);
    if (!agentMatch) return false;
    const agentId = decodeURIComponent(agentMatch[1]);
    const operation = agentMatch[2] ?? 'inspect';
    const serverId = agentMatch[3] ? decodeURIComponent(agentMatch[3]) : null;
    if (operation === 'inspect' && req.method === 'GET') return json(res, 200, await mcpService.inspectAgent(agentId));
    if (operation === 'apply' && req.method === 'POST') return json(res, 200, await mcpService.applyAgent(agentId));
    if (operation === 'validate' && req.method === 'POST') return json(res, 200, await mcpService.validateForAgent(agentId, await readJson(req)));
    if (operation === 'bindings' && !serverId && req.method === 'POST') {
      const body = await readJson(req);
      return json(res, 201, await mcpService.bind(agentId, body.serverId, body));
    }
    if (operation === 'bindings' && serverId && req.method === 'PATCH') {
      return json(res, 200, await mcpService.setBinding(agentId, serverId, await readJson(req)));
    }
    if (operation === 'bindings' && serverId && req.method === 'DELETE') {
      const result = await mcpService.unbind(agentId, serverId);
      return json(res, 200, result);
    }
    return false;
  }

  // Replace a managed runtime's container with one built from the current image,
  // keeping its volumes so the agent stays authenticated. Without this the only
  // way to get new worker code onto an agent is to destroy its credentials.
  async function refreshAgentRuntime(req, res, agent) {
    if (!runtimeManager) {
      throw Object.assign(new Error('Runtime provisioning is unavailable'), { status: 503 });
    }
    const runtime = agent.runtimeId ? runtimes.get(agent.runtimeId) : null;
    if (!runtime?.managed) {
      throw Object.assign(new Error('Only a managed runtime can be refreshed'), { status: 409 });
    }
    // Replacing the container kills whatever it is running, so never do it
    // underneath a task.
    let idle = false;
    try {
      const { response } = await workerFetch(agent, '/v1/status', { timeout: 5_000 });
      if (response.ok) {
        idle = !((await response.json()).task?.active ?? null);
      }
      // A reachable worker that answers with an error or unparseable body tells
      // us nothing about whether it is busy, so it stays not-idle and refuses.
    } catch {
      // Unreachable is different: that is the state a refresh exists to repair,
      // and a worker that cannot be reached is not streaming a task either.
      idle = true;
    }
    if (!idle) {
      throw Object.assign(
        new Error('Runtime is busy or did not report a usable status; cancel any running task and retry'),
        { status: 409 }
      );
    }

    const replaced = await runtimeManager.recreate(runtime, { agentId: agent.id });
    Object.assign(runtime, replaced);
    // outdated is computed during a fleet poll, so without this the response
    // would still report the drift that was just resolved.
    const current = await runtimeManager.currentImageId?.(runtime.adapter) ?? null;
    runtime.outdated = current && runtime.imageId ? current !== runtime.imageId : null;
    await persistAgents();
    return json(res, 200, {
      runtime: publicRuntime(runtime, null, attachmentCount(runtime.id)),
      refreshed: true
    });
  }

  async function handleAgentOperation(req, res, url) {
    const match = url.pathname.match(/^\/api\/v1\/agents\/([^/]+)\/(status|providers|auth\/login|auth\/complete|auth\/refresh|workspace|usage|usage\/refresh|tasks|tasks\/cancel|runtime\/refresh)$/);
    if (!match) return false;
    const agent = requireAgent(decodeURIComponent(match[1]));
    const operation = match[2];
    if (req.method === 'GET' && operation === 'status') return proxyJson(req, res, agent, '/v1/status');
    if (req.method === 'GET' && operation === 'providers') return proxyJson(req, res, agent, '/v1/providers', 30_000);
    if (req.method === 'POST' && operation === 'auth/login') return proxyJson(req, res, agent, '/v1/auth/login');
    if (req.method === 'POST' && operation === 'auth/complete') return proxyJson(req, res, agent, '/v1/auth/complete');
    if (req.method === 'POST' && operation === 'auth/refresh') return proxyJson(req, res, agent, '/v1/auth/refresh', 30_000);
    if (req.method === 'GET' && operation === 'workspace') return proxyJson(req, res, agent, '/v1/workspace');
    if (req.method === 'GET' && operation === 'usage') return proxyJson(req, res, agent, '/v1/usage');
    if (req.method === 'POST' && operation === 'usage/refresh') return proxyJson(req, res, agent, '/v1/usage/refresh', 30_000);
    if (req.method === 'POST' && operation === 'tasks/cancel') return proxyJson(req, res, agent, '/v1/tasks/cancel');
    if (req.method === 'POST' && operation === 'tasks') return proxyTask(req, res, agent);
    if (req.method === 'POST' && operation === 'runtime/refresh') return refreshAgentRuntime(req, res, agent);
    return false;
  }

  return createServer(async (req, res) => {
    try {
      await registryReady;
      const url = new URL(req.url, 'http://control.local');
      const mcp = await handleMcp(req, res, url);
      if (mcp !== false) return mcp;
      const crud = await handleAgentCrud(req, res, url);
      if (crud !== false) return crud;
      const operation = await handleAgentOperation(req, res, url);
      if (operation !== false) return operation;

      const agent = defaultAgent();
      if (req.method === 'GET' && ['/api/v1/health', '/api/health'].includes(url.pathname)) {
        const runtime = agent?.runtimeId ? runtimes.get(agent.runtimeId) : null;
        if (!runtime?.workerUrl) return json(res, 200, { ok: true, worker: 'unconfigured' });
        try {
          const upstream = await fetch(`${runtime.workerUrl}/v1/health`, { signal: AbortSignal.timeout(2000) });
          return json(res, 200, { ok: true, worker: upstream.ok ? 'online' : 'unhealthy' });
        } catch {
          return json(res, 200, { ok: true, worker: 'offline' });
        }
      }
      if (!agent && url.pathname.startsWith('/api/')) return json(res, 404, { error: 'No agents configured' });
      if (req.method === 'GET' && ['/api/v1/status', '/api/status'].includes(url.pathname)) return proxyJson(req, res, agent, '/v1/status');
      if (req.method === 'GET' && ['/api/v1/providers', '/api/providers'].includes(url.pathname)) return proxyJson(req, res, agent, '/v1/providers', 30_000);
      if (req.method === 'POST' && ['/api/v1/auth/login', '/api/auth/start'].includes(url.pathname)) return proxyJson(req, res, agent, '/v1/auth/login');
      if (req.method === 'POST' && ['/api/v1/auth/complete', '/api/auth/complete'].includes(url.pathname)) return proxyJson(req, res, agent, '/v1/auth/complete');
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
