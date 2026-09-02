import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAuthService } from './auth.mjs';
import { createControlMcp } from './control-mcp.mjs';
import {
  assertWriteLease,
  normalizeAttachment,
  normalizeDataSource,
  parseAttachmentRoots,
  publicAttachment,
  publicAttachmentRoots,
  publicDataSource
} from './data-attachments.mjs';
import { createDelegationService } from './delegation-service.mjs';
import { createDockerRuntimeManager } from './docker-runtime.mjs';
import { createMcpService, normalizeStoredMcpDefinition } from './mcp-service.mjs';
import { createScheduler } from './scheduler.mjs';
import { createWorkloadToken, workloadScopeForRequest } from './workload-token.mjs';

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

function redirect(res, location, headers = {}) {
  res.writeHead(302, { location, 'cache-control': 'no-store', ...headers });
  res.end();
}

function html(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
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
      storage: { auth: 'none', binary: 'none', telemetry: 'none', workspace: 'none', attachments: 0 },
      workingDirectory: null
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
      workspace: isolated ? 'isolated' : 'shared',
      attachments: runtime.appliedAttachmentIds?.length ?? 0
    },
    workingDirectory: runtime.workingDirectory ?? '/workspace',
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
  const dataPath = options.dataPath === null ? null : (options.dataPath ?? process.env.CONTROL_PLANE_DATA_PATH ?? null);
  const attachmentRoots = parseAttachmentRoots(options.attachmentRoots ?? process.env.ATTACHMENT_ROOTS_JSON ?? {});
  const runtimeManager = options.runtimeManager !== undefined
    ? options.runtimeManager
    : process.env.RUNTIME_PROVISIONER === 'docker'
      ? createDockerRuntimeManager({ attachmentRoots })
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
    dataPath,
    defaultAgentId: options.defaultAgentId ?? process.env.DEFAULT_AGENT_ID ?? 'worker-01',
    scheduleDbPath: options.scheduleDbPath ?? process.env.SCHEDULER_DB_PATH ?? (dataPath ? join(dirname(dataPath), 'scheduler.sqlite') : ':memory:'),
    delegationDbPath: options.delegationDbPath ?? process.env.DELEGATION_DB_PATH ?? (dataPath ? join(dirname(dataPath), 'delegations.sqlite') : ':memory:'),
    schedulerEnabled: options.schedulerEnabled ?? process.env.SCHEDULER_ENABLED !== '0',
    schedulerIntervalMs: Number(options.schedulerIntervalMs ?? process.env.SCHEDULER_INTERVAL_MS ?? 1000),
    mcpTaskTimeoutMs: Number(options.mcpTaskTimeoutMs ?? process.env.MCP_TASK_TIMEOUT_MS ?? 60 * 60 * 1000)
  };
  if (!config.workerToken) throw new Error('WORKER_TOKEN is required');
  if (!Number.isFinite(config.schedulerIntervalMs) || config.schedulerIntervalMs < 100) {
    throw new Error('SCHEDULER_INTERVAL_MS must be at least 100');
  }
  if (!Number.isFinite(config.mcpTaskTimeoutMs) || config.mcpTaskTimeoutMs < 1_000 || config.mcpTaskTimeoutMs > 24 * 60 * 60 * 1000) {
    throw new Error('MCP_TASK_TIMEOUT_MS must be between 1000 and 86400000');
  }
  const auth = options.authService ?? createAuthService({
    sessionDbPath: dataPath ? join(dirname(dataPath), 'auth.sqlite') : ':memory:',
    ...options.auth
  });

  const agents = new Map();
  const deletingAgents = new Set();
  const runtimes = new Map();
  const mcpServers = new Map();
  const mcpBindings = new Map();
  const dataSources = new Map();
  const dataAttachments = new Map();
  let persistQueue = Promise.resolve();
  let storageMutationQueue = Promise.resolve();
  const activeAgentOperations = new Map();
  const defaultAgent = () => {
    const preferred = agents.get(config.defaultAgentId);
    if (preferred && !deletingAgents.has(preferred.id)) return preferred;
    return [...agents.values()].find((agent) => !deletingAgents.has(agent.id)) ?? null;
  };
  const attachmentCount = (runtimeId) => [...agents.values()].filter((agent) => agent.runtimeId === runtimeId).length;
  const agentPublic = (agent) => publicAgent(agent, agent.runtimeId ? runtimes.get(agent.runtimeId) : null, attachmentCount(agent.runtimeId));

  async function persistAgents() {
    if (!config.dataPath) return;
    const payload = {
      schemaVersion: 4,
      agents: [...agents.values()],
      runtimes: [...runtimes.values()],
      mcpServers: [...mcpServers.values()],
      mcpBindings: [...mcpBindings.values()],
      dataSources: [...dataSources.values()],
      dataAttachments: [...dataAttachments.values()]
    };
    // A failed write must reject its caller without poisoning every later
    // registry transaction, including the rollback that caller may attempt.
    persistQueue = persistQueue.catch(() => {}).then(async () => {
      await mkdir(dirname(config.dataPath), { recursive: true });
      const temporary = `${config.dataPath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, config.dataPath);
    });
    return persistQueue;
  }

  function withStorageMutation(operation) {
    const result = storageMutationQueue.then(operation, operation);
    storageMutationQueue = result.catch(() => {});
    return result;
  }

  function claimAgentOperation(agentId, operation) {
    const active = activeAgentOperations.get(agentId);
    if (active) {
      throw Object.assign(new Error(`Agent is busy with ${active.label}; wait for it to finish`), { status: 409 });
    }
    const claim = { label: operation };
    activeAgentOperations.set(agentId, claim);
    return () => {
      if (activeAgentOperations.get(agentId) === claim) activeAgentOperations.delete(agentId);
    };
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
            if (stored.schemaVersion >= 4) {
              for (const source of stored.dataSources ?? []) {
                if (!source?.id || !source?.name) continue;
                const normalized = normalizeDataSource(source, {
                  existingIds: new Set(dataSources.keys()),
                  roots: attachmentRoots,
                  defaults: source,
                  allowUnconfiguredRoot: true
                });
                dataSources.set(normalized.id, normalized);
              }
              for (const attachment of stored.dataAttachments ?? []) {
                const source = dataSources.get(attachment?.dataSourceId);
                if (!attachment?.id || !attachment?.agentId || !agents.has(attachment.agentId) || !source) continue;
                const normalized = normalizeAttachment(attachment, {
                  agentId: attachment.agentId,
                  source,
                  existing: [...dataAttachments.values()].filter((item) => item.agentId === attachment.agentId),
                  defaults: attachment
                });
                assertWriteLease(normalized, [...dataAttachments.values()], dataSources, attachmentRoots);
                dataAttachments.set(normalized.id, normalized);
              }
            } else {
              migrated = true;
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
    if (!agent || deletingAgents.has(id)) throw Object.assign(new Error('Agent not found'), { status: 404 });
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
    const method = (init.method ?? 'GET').toUpperCase();
    const transportCredential = runtime.workerAuthMode === 'jwt'
      ? createWorkloadToken(runtime.workerToken, {
          audience: `agent-wrapper:${runtime.workerId}`,
          scopes: [workloadScopeForRequest(pathname, method)]
        })
      : runtime.workerToken;
    const response = await fetch(`${runtime.workerUrl}${pathname}`, {
      ...init,
      headers: {
        authorization: `Bearer ${transportCredential}`,
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

  const attachmentsForAgent = (agentId) => [...dataAttachments.values()].filter((attachment) => attachment.agentId === agentId);

  function requireManagedRuntime(agent) {
    if (!runtimeManager) throw Object.assign(new Error('Runtime provisioning is unavailable'), { status: 503 });
    const runtime = agent.runtimeId ? runtimes.get(agent.runtimeId) : null;
    if (!runtime?.managed || runtime.kind !== 'managed-dedicated') {
      throw Object.assign(new Error('Data attachments require a managed dedicated runtime'), { status: 409 });
    }
    return runtime;
  }

  async function requireIdleRuntime(agent) {
    const runtime = requireManagedRuntime(agent);
    let idle = false;
    let response;
    try {
      ({ response } = await workerFetch(agent, '/v1/status', { timeout: 5_000 }));
    } catch {
      // An unreachable worker cannot be streaming a task through this control
      // plane and may need replacement precisely so it can recover.
      idle = true;
    }
    if (response?.ok) {
      try { idle = !((await response.json()).task?.active ?? null); }
      catch { idle = false; }
    }
    if (!idle) {
      throw Object.assign(
        new Error('Runtime is busy or did not report a usable status; cancel any running task and retry'),
        { status: 409 }
      );
    }
    return runtime;
  }

  async function materializeAttachments(agent, attachments) {
    if (!runtimeManager?.materializeAttachments) {
      if (!attachments.length) return [];
      throw Object.assign(new Error('The runtime provisioner does not support data attachments'), { status: 503 });
    }
    return runtimeManager.materializeAttachments({
      adapter: agent.adapter,
      attachments,
      sources: dataSources
    });
  }

  async function applyAttachmentSet(agent, nextAttachments, { previousAttachments = null } = {}) {
    const runtime = await requireIdleRuntime(agent);
    const previousIds = new Set(runtime.appliedAttachmentIds ?? []);
    const previous = previousAttachments
      ?? attachmentsForAgent(agent.id).filter((attachment) => previousIds.has(attachment.id));
    const [materialized, previousMaterialized] = await Promise.all([
      materializeAttachments(agent, nextAttachments),
      materializeAttachments(agent, previous)
    ]);
    try {
      const replaced = await runtimeManager.recreate(runtime, {
        agentId: agent.id,
        attachments: materialized,
        previousAttachments: previousMaterialized
      });
      Object.assign(runtime, replaced, {
        appliedAttachmentIds: nextAttachments.map((attachment) => attachment.id),
        workingDirectory: materialized.find((attachment) => attachment.purpose === 'working-directory')?.target ?? '/workspace'
      });
    } catch (error) {
      if (error.rollbackRuntime) Object.assign(runtime, error.rollbackRuntime);
      throw error;
    }
  }

  async function commitAttachmentSet(agent, nextAttachments) {
    const release = claimAgentOperation(agent.id, 'runtime storage reconfiguration');
    try {
      const previous = attachmentsForAgent(agent.id);
      await applyAttachmentSet(agent, nextAttachments, { previousAttachments: previous });
      for (const attachment of previous) dataAttachments.delete(attachment.id);
      for (const attachment of nextAttachments) dataAttachments.set(attachment.id, attachment);
      try {
        await persistAgents();
      } catch (error) {
        for (const attachment of nextAttachments) dataAttachments.delete(attachment.id);
        for (const attachment of previous) dataAttachments.set(attachment.id, attachment);
        try {
          await applyAttachmentSet(agent, previous, { previousAttachments: nextAttachments });
        } catch (rollbackError) {
          error.message = `${error.message}; restoring the previous attachment set also failed: ${rollbackError.message}`;
        }
        throw error;
      }
    } finally {
      release();
    }
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
    const release = claimAgentOperation(agent.id, 'an active task');
    try {
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
    } finally {
      release();
    }
  }

  async function cancelKnownWorkerTask(agent, taskId) {
    if (typeof taskId !== 'string' || !taskId.trim()) {
      throw Object.assign(new Error('taskId is required for safe targeted cancellation'), { status: 400 });
    }
    taskId = taskId.trim();
    const status = await workerRequest(agent, 'GET', '/v1/status', undefined, 15_000);
    if (status.capabilities?.tasks?.targetedCancellation !== true) {
      throw Object.assign(new Error('Worker does not advertise safe targeted cancellation; refresh its runtime before retrying'), { status: 409 });
    }
    if (status.task?.active?.id !== taskId) {
      throw Object.assign(new Error('The requested task is no longer the worker active task'), { status: 409 });
    }
    return workerRequest(agent, 'POST', '/v1/tasks/cancel', { taskId }, 15_000);
  }

  async function dispatchAgentTask({ agentId, prompt, timeoutMs, onTaskId = null }) {
    const agent = requireAgent(agentId);
    let release;
    try {
      release = claimAgentOperation(agent.id, 'an active task');
    } catch (error) {
      if (error.status === 409) return { status: 'skipped_busy', error: error.message };
      throw error;
    }
    try {
    const status = await workerRequest(agent, 'GET', '/v1/status', undefined, 15_000);
    if (status.task?.active) {
      return { status: 'skipped_busy', error: `Agent is busy with task ${status.task.active.id ?? 'unknown'}` };
    }

    let taskId = null;
    try {
      const { response } = await workerFetch(agent, '/v1/tasks', {
        method: 'POST',
        body: JSON.stringify({
          prompt,
          instructions: agent.durablePrompt,
          modelPolicy: agent.modelPolicy
        }),
        timeout: timeoutMs
      });
      if (!response.ok || !response.body) {
        const text = await response.text();
        let value = {};
        try { value = JSON.parse(text); } catch { value = { error: text }; }
        return {
          status: response.status === 409 ? 'skipped_busy' : 'failed',
          error: value.error || `Worker returned HTTP ${response.status}`
        };
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let usage = null;
      let completion = null;
      let outputText = '';
      let lastError = null;
      function consume(line) {
        if (!line.trim()) return;
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.taskId && event.taskId !== taskId) {
          taskId = String(event.taskId);
          onTaskId?.(taskId);
        }
        if (event.type === 'usage.updated' && event.data?.usage) usage = event.data.usage;
        if (event.type === 'message.completed' && event.data?.role === 'assistant' && typeof event.data.text === 'string') {
          const separator = outputText ? '\n' : '';
          outputText += `${separator}${event.data.text}`.slice(0, Math.max(0, 100_000 - outputText.length));
        }
        if (event.type === 'error' && typeof event.data?.message === 'string') lastError = event.data.message.slice(0, 4_000);
        if (event.type === 'task.completed') completion = event.data ?? {};
      }
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) consume(line);
      }
      buffer += decoder.decode();
      consume(buffer);
      if (!completion) return {
        status: 'failed',
        taskId,
        usage,
        output: outputText || null,
        error: lastError ?? 'Worker stream ended without task.completed'
      };
      const succeeded = completion.status === 'succeeded' && (completion.exitCode === undefined || completion.exitCode === 0);
      const terminalStatus = completion.status === 'cancelled' ? 'cancelled' : succeeded ? 'succeeded' : 'failed';
      return {
        status: terminalStatus,
        taskId,
        usage,
        output: outputText || null,
        error: succeeded ? null : (lastError ?? `Worker task ended with status ${completion.status ?? 'unknown'}`)
      };
    } catch (error) {
      if ((error?.name === 'TimeoutError' || error?.name === 'AbortError') && taskId) {
        await cancelKnownWorkerTask(agent, taskId).catch(() => {});
      }
      throw error;
    }
    } finally {
      release();
    }
  }

  async function dispatchScheduledTask(schedule) {
    return dispatchAgentTask({
      agentId: schedule.agentId,
      prompt: schedule.prompt,
      timeoutMs: schedule.policies.timeoutMs
    });
  }

  const delegation = createDelegationService({
    path: config.delegationDbPath,
    clock: options.clock,
    maxDepth: options.mcpMaxDelegationDepth ?? process.env.MCP_MAX_DELEGATION_DEPTH ?? 4,
    maxConcurrentPerCaller: options.mcpMaxConcurrentPerCaller ?? process.env.MCP_MAX_CONCURRENT_PER_CALLER ?? 4,
    agentExists: (id) => agents.has(id) && !deletingAgents.has(id),
    dispatch: options.delegationDispatch ?? ((task, context) => dispatchAgentTask({
      agentId: task.targetAgentId,
      prompt: task.prompt,
      timeoutMs: config.mcpTaskTimeoutMs,
      onTaskId: context.reportWorkerTaskId
    })),
    cancel: options.delegationCancel ?? (async (task) => {
      if (!task.workerTaskId) throw Object.assign(new Error('Worker has not acknowledged this task yet; retry cancellation shortly'), { status: 409 });
      const agent = requireAgent(task.targetAgentId);
      await cancelKnownWorkerTask(agent, task.workerTaskId);
    })
  });

  const scheduler = createScheduler({
    path: config.scheduleDbPath,
    clock: options.clock,
    ownerId: options.schedulerOwnerId,
    enabled: config.schedulerEnabled,
    agentExists: (id) => agents.has(id) && !deletingAgents.has(id),
    dispatch: options.scheduleDispatch ?? dispatchScheduledTask
  });

  const controlMcp = createControlMcp({
    publicOrigin: auth.publicOrigin,
    allowedHostnames: String(options.mcpAllowedHostnames ?? process.env.MCP_ALLOWED_HOSTNAMES ?? '')
      .split(',').map((value) => value.trim()).filter(Boolean),
    agentPolicies: options.mcpAgentPolicies ?? process.env.MCP_AGENT_POLICIES_JSON ?? '{}',
    delegation,
    allows: auth.allows,
    allowsMcpPrincipal: auth.allowsMcpPrincipal,
    listAgents: () => [...agents.values()].filter((agent) => !deletingAgents.has(agent.id)).map(agentPublic),
    getAgentStatus: async (agentId) => workerRequest(requireAgent(agentId), 'GET', '/v1/status', undefined, 15_000),
    onerror: (error) => console.error('[control-plane:mcp]', error)
  });

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
      const dependentSchedules = scheduler.list({ agentId: id });
      if (dependentSchedules.length) {
        throw Object.assign(new Error(`Delete or reassign ${dependentSchedules.length} scheduled job${dependentSchedules.length === 1 ? '' : 's'} before deleting this agent`), { status: 409 });
      }
      if (delegation.hasActiveForAgent(id)) {
        throw Object.assign(new Error('Wait for delegated work assigned to this agent to finish before deleting it'), { status: 409 });
      }
      if (attachmentsForAgent(id).length) {
        throw Object.assign(new Error('Detach every data source before deleting this agent'), { status: 409 });
      }
      if (activeAgentOperations.has(id)) {
        throw Object.assign(new Error(`Wait for ${activeAgentOperations.get(id).label} to finish before deleting this agent`), { status: 409 });
      }
      deletingAgents.add(id);
      try {
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
      } finally {
        deletingAgents.delete(id);
      }
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

  async function handleSchedules(req, res, url) {
    if (url.pathname === '/api/v1/scheduler') {
      if (req.method === 'GET') return json(res, 200, { scheduler: scheduler.status() });
      return false;
    }
    if (url.pathname === '/api/v1/schedules') {
      if (req.method === 'GET') {
        const schedules = scheduler.list({ agentId: url.searchParams.get('agentId') });
        const includeRuns = url.searchParams.get('includeRuns');
        if (includeRuns === null) return json(res, 200, { schedules });
        const limit = Number(includeRuns);
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
          throw Object.assign(new Error('includeRuns must be an integer from 1 to 500'), { status: 400 });
        }
        const runs = Object.fromEntries(schedules.map((schedule) => [schedule.id, scheduler.runs(schedule.id, limit)]));
        return json(res, 200, { schedules, runs });
      }
      if (req.method === 'POST') return json(res, 201, { schedule: scheduler.create(await readJson(req)) });
      return false;
    }

    const match = url.pathname.match(/^\/api\/v1\/schedules\/([^/]+)(?:\/(pause|resume|run-now|runs))?$/);
    if (!match) return false;
    const scheduleId = decodeURIComponent(match[1]);
    const operation = match[2] ?? null;
    if (!operation && req.method === 'GET') return json(res, 200, { schedule: scheduler.get(scheduleId) });
    if (!operation && req.method === 'PATCH') return json(res, 200, { schedule: scheduler.update(scheduleId, await readJson(req)) });
    if (!operation && req.method === 'DELETE') {
      scheduler.delete(scheduleId);
      res.writeHead(204, { 'cache-control': 'no-store' });
      return res.end();
    }
    if (operation === 'pause' && req.method === 'POST') return json(res, 200, { schedule: scheduler.pause(scheduleId) });
    if (operation === 'resume' && req.method === 'POST') return json(res, 200, { schedule: scheduler.resume(scheduleId) });
    if (operation === 'run-now' && req.method === 'POST') return json(res, 202, { run: scheduler.runNow(scheduleId) });
    if (operation === 'runs' && req.method === 'GET') {
      return json(res, 200, { runs: scheduler.runs(scheduleId, url.searchParams.get('limit') ?? 100) });
    }
    return false;
  }

  async function handleDataAttachments(req, res, url, { mutationLocked = false } = {}) {
    const storagePath = url.pathname === '/api/v1/data-sources'
      || /^\/api\/v1\/data-sources\/[^/]+$/.test(url.pathname)
      || /^\/api\/v1\/agents\/[^/]+\/attachments(?:\/[^/]+)?$/.test(url.pathname);
    if (!mutationLocked && storagePath && ['POST', 'PATCH', 'DELETE'].includes(req.method)) {
      return withStorageMutation(() => handleDataAttachments(req, res, url, { mutationLocked: true }));
    }
    const rootBrowserMatch = url.pathname.match(/^\/api\/v1\/attachment-roots\/([^/]+)\/directories$/);
    if (rootBrowserMatch) {
      if (req.method !== 'GET') return false;
      if (!runtimeManager?.listHostDirectories) {
        throw Object.assign(new Error('Host folder browsing is unavailable'), { status: 503 });
      }
      const rootId = decodeURIComponent(rootBrowserMatch[1]);
      const root = attachmentRoots.get(rootId);
      if (!root) throw Object.assign(new Error('Attachment root not found'), { status: 404 });
      const agentId = url.searchParams.get('agentId');
      if (!agentId) throw Object.assign(new Error('agentId is required'), { status: 400 });
      const agent = requireAgent(agentId);
      requireManagedRuntime(agent);
      const listing = await runtimeManager.listHostDirectories({
        rootId,
        relativePath: url.searchParams.get('path') ?? '.',
        adapter: agent.adapter
      });
      return json(res, 200, {
        root: { id: root.id, label: root.label, allowWrite: root.allowWrite },
        ...listing
      });
    }
    if (url.pathname === '/api/v1/attachment-roots') {
      if (req.method === 'GET') return json(res, 200, { roots: publicAttachmentRoots(attachmentRoots) });
      return false;
    }

    if (url.pathname === '/api/v1/data-sources') {
      if (req.method === 'GET') {
        return json(res, 200, {
          dataSources: [...dataSources.values()]
            .filter((source) => source.scope !== 'attachment')
            .map((source) => publicDataSource(source, attachmentRoots))
        });
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        const source = normalizeDataSource(body, { existingIds: new Set(dataSources.keys()), roots: attachmentRoots });
        if (source.kind === 'managed-volume') {
          if (!runtimeManager?.createManagedDataVolume) {
            throw Object.assign(new Error('Managed data volumes are unavailable'), { status: 503 });
          }
          source.volumeName = await runtimeManager.createManagedDataVolume(source.id);
        }
        dataSources.set(source.id, source);
        try {
          await persistAgents();
        } catch (error) {
          dataSources.delete(source.id);
          if (source.volumeName) await runtimeManager.deleteManagedDataVolume?.(source.id, source.volumeName).catch(() => {});
          throw error;
        }
        return json(res, 201, { dataSource: publicDataSource(source, attachmentRoots) });
      }
      return false;
    }

    const sourceMatch = url.pathname.match(/^\/api\/v1\/data-sources\/([^/]+)$/);
    if (sourceMatch) {
      const sourceId = decodeURIComponent(sourceMatch[1]);
      const source = dataSources.get(sourceId);
      if (!source) throw Object.assign(new Error('Data source not found'), { status: 404 });
      if (req.method === 'GET') return json(res, 200, { dataSource: publicDataSource(source, attachmentRoots) });
      if (req.method === 'PATCH') {
        const body = await readJson(req);
        if (body.id !== undefined && body.id !== source.id) {
          throw Object.assign(new Error('Data source id cannot be changed'), { status: 409 });
        }
        if (body.kind && body.kind !== source.kind) throw Object.assign(new Error('Data source kind cannot be changed'), { status: 409 });
        const inUse = [...dataAttachments.values()].some((attachment) => attachment.dataSourceId === source.id);
        if (inUse && ((body.rootId && body.rootId !== source.rootId) || (body.relativePath && body.relativePath !== source.relativePath))) {
          throw Object.assign(new Error('Detach this data source before changing its location'), { status: 409 });
        }
        const updated = normalizeDataSource({ ...source, ...body }, {
          existingIds: new Set(dataSources.keys()),
          roots: attachmentRoots,
          defaults: source
        });
        dataSources.set(source.id, updated);
        try {
          await persistAgents();
        } catch (error) {
          dataSources.set(source.id, source);
          throw error;
        }
        return json(res, 200, { dataSource: publicDataSource(updated, attachmentRoots) });
      }
      if (req.method === 'DELETE') {
        if ([...dataAttachments.values()].some((attachment) => attachment.dataSourceId === source.id)) {
          throw Object.assign(new Error('Detach this data source from every agent before deleting it'), { status: 409 });
        }
        const body = await readJson(req);
        if (source.kind === 'managed-volume' && (body.confirmation !== source.id || body.deleteVolume !== true)) {
          throw Object.assign(new Error('Deleting a managed volume requires deleteVolume=true and confirmation matching the data source id'), { status: 400 });
        }
        dataSources.delete(source.id);
        try {
          await persistAgents();
        } catch (error) {
          dataSources.set(source.id, source);
          throw error;
        }
        if (source.kind === 'managed-volume') {
          try {
            await runtimeManager.deleteManagedDataVolume(source.id, source.volumeName);
          } catch (error) {
            dataSources.set(source.id, source);
            try { await persistAgents(); }
            catch (restoreError) { error.message = `${error.message}; restoring the data-source registry also failed: ${restoreError.message}`; }
            throw error;
          }
        }
        res.writeHead(204, { 'cache-control': 'no-store' });
        return res.end();
      }
      return false;
    }

    const attachmentMatch = url.pathname.match(/^\/api\/v1\/agents\/([^/]+)\/attachments(?:\/([^/]+))?$/);
    if (!attachmentMatch) return false;
    const agent = requireAgent(decodeURIComponent(attachmentMatch[1]));
    const attachmentId = attachmentMatch[2] ? decodeURIComponent(attachmentMatch[2]) : null;
    const current = attachmentsForAgent(agent.id);
    if (!attachmentId && req.method === 'GET') {
      return json(res, 200, {
        attachments: current.map((attachment) => publicAttachment(attachment, dataSources.get(attachment.dataSourceId), attachmentRoots)),
        workingDirectory: runtimes.get(agent.runtimeId)?.workingDirectory ?? '/workspace'
      });
    }
    if (!attachmentId && req.method === 'POST') {
      const body = await readJson(req);
      if (body.source && body.dataSourceId) {
        throw Object.assign(new Error('Provide either source or dataSourceId, not both'), { status: 400 });
      }
      let source;
      let attachmentScoped = false;
      if (body.source) {
        source = normalizeDataSource({
          ...body.source,
          id: `mapping-${randomUUID()}`,
          kind: 'host-directory',
          name: body.source.name ?? body.mountName ?? 'Mapped folder'
        }, { existingIds: new Set(dataSources.keys()), roots: attachmentRoots });
        source.scope = 'attachment';
        attachmentScoped = true;
        dataSources.set(source.id, source);
      } else {
        source = dataSources.get(body.dataSourceId);
        if (!source) throw Object.assign(new Error('Data source not found'), { status: 404 });
      }
      try {
        const attachment = normalizeAttachment(body, { agentId: agent.id, source, existing: current });
        assertWriteLease(attachment, [...dataAttachments.values()], dataSources, attachmentRoots);
        await commitAttachmentSet(agent, [...current, attachment]);
        return json(res, 201, { attachment: publicAttachment(attachment, source, attachmentRoots) });
      } catch (error) {
        if (attachmentScoped) dataSources.delete(source.id);
        throw error;
      }
    }
    const existing = dataAttachments.get(attachmentId);
    if (!existing || existing.agentId !== agent.id) throw Object.assign(new Error('Attachment not found'), { status: 404 });
    if (req.method === 'PATCH') {
      const body = await readJson(req);
      const sourceId = body.dataSourceId ?? existing.dataSourceId;
      const source = dataSources.get(sourceId);
      if (!source) throw Object.assign(new Error('Data source not found'), { status: 404 });
      const updated = normalizeAttachment({ ...existing, ...body }, {
        agentId: agent.id,
        source,
        existing: current,
        defaults: existing
      });
      assertWriteLease(updated, [...dataAttachments.values()].filter((attachment) => attachment.id !== existing.id), dataSources, attachmentRoots);
      await commitAttachmentSet(agent, current.map((attachment) => attachment.id === existing.id ? updated : attachment));
      return json(res, 200, { attachment: publicAttachment(updated, source, attachmentRoots) });
    }
    if (req.method === 'DELETE') {
      await commitAttachmentSet(agent, current.filter((attachment) => attachment.id !== existing.id));
      const source = dataSources.get(existing.dataSourceId);
      if (source?.scope === 'attachment'
        && ![...dataAttachments.values()].some((attachment) => attachment.dataSourceId === source.id)) {
        dataSources.delete(source.id);
        try { await persistAgents(); }
        catch { dataSources.set(source.id, source); }
      }
      res.writeHead(204, { 'cache-control': 'no-store' });
      return res.end();
    }
    return false;
  }

  // Replace a managed runtime's container with one built from the current image,
  // keeping its volumes so the agent stays authenticated. Without this the only
  // way to get new worker code onto an agent is to destroy its credentials.
  async function refreshAgentRuntime(req, res, agent) {
    const release = claimAgentOperation(agent.id, 'runtime image refresh');
    try {
      const runtime = await requireIdleRuntime(agent);
      const attachments = attachmentsForAgent(agent.id);
      const materialized = await materializeAttachments(agent, attachments);
      let replaced;
      try {
        replaced = await runtimeManager.recreate(runtime, {
          agentId: agent.id,
          attachments: materialized,
          previousAttachments: materialized
        });
      } catch (error) {
        if (error.rollbackRuntime) Object.assign(runtime, error.rollbackRuntime);
        throw error;
      }
      Object.assign(runtime, replaced, {
        appliedAttachmentIds: attachments.map((attachment) => attachment.id),
        workingDirectory: materialized.find((attachment) => attachment.purpose === 'working-directory')?.target ?? '/workspace'
      });
      // outdated is computed during a fleet poll, so without this the response
      // would still report the drift that was just resolved.
      const current = await runtimeManager.currentImageId?.(runtime.adapter) ?? null;
      runtime.outdated = current && runtime.imageId ? current !== runtime.imageId : null;
      await persistAgents();
      return json(res, 200, {
        runtime: publicRuntime(runtime, null, attachmentCount(runtime.id)),
        refreshed: true
      });
    } finally {
      release();
    }
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
    if (req.method === 'POST' && operation === 'tasks/cancel') {
      const body = await readJson(req);
      return json(res, 202, await cancelKnownWorkerTask(agent, body.taskId));
    }
    if (req.method === 'POST' && operation === 'tasks') return proxyTask(req, res, agent);
    if (req.method === 'POST' && operation === 'runtime/refresh') return refreshAgentRuntime(req, res, agent);
    return false;
  }

  async function handlePlatformAuth(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') {
      return json(res, 200, auth.protectedResourceMetadata());
    }
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return json(res, 200, auth.protectedResourceMetadata(auth.mcpAudience));
    }
    if (req.method === 'GET' && url.pathname === '/login') {
      const principal = await auth.authenticate(req);
      const returnTo = auth.normalizeReturnTo(url.searchParams.get('returnTo') ?? '/');
      if (principal) return redirect(res, returnTo);
      return html(res, 200, auth.loginPage(returnTo, url.searchParams.get('error')));
    }
    if (req.method === 'GET' && url.pathname === '/auth/login') {
      const result = await auth.beginLogin(url.searchParams.get('returnTo') ?? '/');
      return redirect(res, result.location);
    }
    if (req.method === 'GET' && url.pathname === '/auth/callback') {
      try {
        const result = await auth.completeLogin(new URL(url.pathname + url.search, auth.publicOrigin));
        return redirect(res, result.location, result.cookie ? { 'set-cookie': result.cookie } : {});
      } catch (error) {
        return html(res, error.status ?? 401, auth.loginPage('/', error.message));
      }
    }
    if (req.method === 'POST' && url.pathname === '/auth/logout') {
      const principal = await auth.authenticate(req);
      if (!principal) return authenticationRequired(res);
      if (!auth.checkCsrf(req, principal)) return authorizationDenied(res, null, 'CSRF validation failed');
      auth.revokeSession(req);
      return redirect(res, '/login', { 'set-cookie': auth.clearSessionCookie() });
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/session') {
      const principal = await auth.authenticate(req);
      return json(res, 200, {
        authentication: {
          mode: auth.mode,
          authenticated: Boolean(principal),
          principal: auth.publicPrincipal(principal)
        }
      });
    }
    return false;
  }

  function authenticationRequired(res) {
    const metadata = `${auth.publicOrigin}/.well-known/oauth-protected-resource`;
    res.writeHead(401, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'www-authenticate': `Bearer resource_metadata="${metadata}"`
    });
    res.end(JSON.stringify({ error: 'Authentication required' }));
  }

  function mcpAuthenticationRequired(res, message = 'Authentication required') {
    const metadata = `${auth.publicOrigin}/.well-known/oauth-protected-resource/mcp`;
    res.writeHead(401, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'www-authenticate': `Bearer resource_metadata="${metadata}"`
    });
    res.end(JSON.stringify({ error: message }));
  }

  async function handleControlMcp(req, res, url) {
    if (url.pathname !== '/mcp') return false;
    if (!controlMcp.validate(req, res)) return true;
    let authenticated;
    try {
      authenticated = await auth.authenticateMcpBearer(req);
    } catch (error) {
      if (error.status === 401) return mcpAuthenticationRequired(res, error.message);
      throw error;
    }
    if (!auth.allowsMcpPrincipal(authenticated.principal)) {
      return authorizationDenied(res, null, 'MCP bearer is not explicitly authorized');
    }
    req.auth = authenticated.authInfo;
    await controlMcp.handle(req, res, { validated: true });
    return true;
  }

  function authorizationDenied(res, permission, message = 'Insufficient permission') {
    return json(res, 403, { error: message, requiredPermission: permission });
  }

  function publicSchedulerHealth() {
    const status = scheduler.status();
    return {
      enabled: status.enabled,
      database: status.database,
      lastTickAt: status.lastTickAt,
      tickFailed: Boolean(status.lastTickError),
      executionFailed: Boolean(status.lastExecutionError),
      activeExecutions: status.activeExecutions
    };
  }

  function publicDelegationHealth() {
    const status = delegation.status();
    return {
      healthy: status.healthy,
      executionFailed: Boolean(status.lastExecutionError),
      activeExecutions: status.activeExecutions
    };
  }

  const server = createServer(async (req, res) => {
    try {
      await registryReady;
      const url = new URL(req.url, 'http://control.local');
      const authRoute = await handlePlatformAuth(req, res, url);
      if (authRoute !== false) return authRoute;
      const controlMcpRoute = await handleControlMcp(req, res, url);
      if (controlMcpRoute !== false) return controlMcpRoute;

      let principal;
      try {
        principal = await auth.authenticate(req);
      } catch (error) {
        if (error.status === 401) return authenticationRequired(res);
        throw error;
      }
      const permission = auth.permissionForRequest(req, url);
      if (permission && !principal) return authenticationRequired(res);
      if (permission && !auth.allows(principal, permission)) return authorizationDenied(res, permission);
      if (permission && !auth.checkCsrf(req, principal)) {
        return authorizationDenied(res, permission, 'CSRF validation failed');
      }

      const browserRoute = req.method === 'GET'
        && !url.pathname.startsWith('/api/')
        && !url.pathname.startsWith('/auth/')
        && !url.pathname.startsWith('/.well-known/')
        && !extname(url.pathname);
      if (browserRoute && auth.mode === 'oidc' && !principal) {
        return redirect(res, `/login?returnTo=${encodeURIComponent(url.pathname + url.search)}`);
      }

      const scheduled = await handleSchedules(req, res, url);
      if (scheduled !== false) return scheduled;
      const data = await handleDataAttachments(req, res, url);
      if (data !== false) return data;
      const mcp = await handleMcp(req, res, url);
      if (mcp !== false) return mcp;
      const crud = await handleAgentCrud(req, res, url);
      if (crud !== false) return crud;
      const operation = await handleAgentOperation(req, res, url);
      if (operation !== false) return operation;

      const agent = defaultAgent();
      if (req.method === 'GET' && ['/api/v1/health', '/api/health'].includes(url.pathname)) {
        const runtime = agent?.runtimeId ? runtimes.get(agent.runtimeId) : null;
        if (!runtime?.workerUrl) return json(res, 200, { ok: true, worker: 'unconfigured', scheduler: publicSchedulerHealth(), delegation: publicDelegationHealth() });
        try {
          const upstream = await fetch(`${runtime.workerUrl}/v1/health`, { signal: AbortSignal.timeout(2000) });
          return json(res, 200, { ok: true, worker: upstream.ok ? 'online' : 'unhealthy', scheduler: publicSchedulerHealth(), delegation: publicDelegationHealth() });
        } catch {
          return json(res, 200, { ok: true, worker: 'offline', scheduler: publicSchedulerHealth(), delegation: publicDelegationHealth() });
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
      if (req.method === 'POST' && ['/api/v1/tasks/cancel', '/api/run/cancel'].includes(url.pathname)) {
        const body = await readJson(req);
        return json(res, 202, await cancelKnownWorkerTask(agent, body.taskId));
      }
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
  let schedulerTimer = null;
  let schedulerClosed = false;
  if (config.schedulerEnabled) {
    void registryReady.then(() => {
      if (schedulerClosed) return;
      schedulerTimer = setInterval(() => { void scheduler.tick().catch(() => {}); }, config.schedulerIntervalMs);
      schedulerTimer.unref();
      void scheduler.tick().catch(() => {});
    }).catch(() => {});
  }
  server.scheduler = scheduler;
  server.on('close', () => {
    schedulerClosed = true;
    if (schedulerTimer) clearInterval(schedulerTimer);
    void scheduler.whenIdle().finally(() => scheduler.close());
    void delegation.close();
    void controlMcp.close();
    auth.close?.();
  });
  server.delegation = delegation;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';
  const server = createControlPlane();
  server.listen(port, host, () => console.log(`[control-plane] listening on ${host}:${port}`));
}
