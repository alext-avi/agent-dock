import { randomUUID } from 'node:crypto';

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;
const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function failure(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function text(value, field, { required = false, max = 500 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw failure(`${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw failure(`${field} must be a string`);
  const normalized = value.trim();
  if (required && !normalized) throw failure(`${field} is required`);
  if (normalized.length > max) throw failure(`${field} is too long`, 413);
  if (/\0|[\r\n]/.test(normalized)) throw failure(`${field} contains unsupported control characters`);
  return normalized;
}

function stringMap(value, field, { names = false, maxEntries = 32 } = {}) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw failure(`${field} must be an object`);
  const entries = Object.entries(value);
  if (entries.length > maxEntries) throw failure(`${field} supports at most ${maxEntries} entries`);
  return Object.fromEntries(entries.map(([key, raw]) => {
    const normalizedKey = text(key, `${field} key`, { required: true, max: 120 });
    if (names && !ENV_PATTERN.test(normalizedKey)) throw failure(`${field}.${normalizedKey} is not a valid environment variable name`);
    const normalizedValue = text(raw, `${field}.${normalizedKey}`, { required: true, max: 4000 });
    return [normalizedKey, normalizedValue];
  }));
}

function secretHeaderMap(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw failure('secretHeaders must be an object');
  const entries = Object.entries(value);
  if (entries.length > 32) throw failure('secretHeaders supports at most 32 entries');
  return Object.fromEntries(entries.map(([header, raw]) => {
    const normalizedHeader = text(header, 'secretHeaders key', { required: true, max: 120 });
    const source = typeof raw === 'string' ? { sourceEnv: raw } : raw;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw failure(`secretHeaders.${normalizedHeader} must name a connector secret provisioned as MCP_SECRET_<NAME>`);
    }
    const sourceEnv = text(source.sourceEnv, `secretHeaders.${normalizedHeader}.sourceEnv`, { required: true, max: 120 });
    if (!ENV_PATTERN.test(sourceEnv)) throw failure(`secretHeaders.${normalizedHeader}.sourceEnv is invalid`);
    const prefix = source.prefix ?? '';
    if (typeof prefix !== 'string' || prefix.length > 120 || /\0|[\r\n]/.test(prefix)) {
      throw failure(`secretHeaders.${normalizedHeader}.prefix must be a bounded single-line string`);
    }
    return [normalizedHeader, { sourceEnv, prefix }];
  }));
}

function secretEnvironmentMap(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw failure('secretEnvironment must be an object');
  const entries = Object.entries(value);
  if (entries.length > 32) throw failure('secretEnvironment supports at most 32 entries');
  return Object.fromEntries(entries.map(([target, raw]) => {
    if (!ENV_PATTERN.test(target)) throw failure(`secretEnvironment.${target} target is invalid`);
    const source = typeof raw === 'string' ? raw : raw?.sourceEnv;
    const sourceEnv = text(source, `secretEnvironment.${target}.sourceEnv`, { required: true, max: 120 });
    if (!ENV_PATTERN.test(sourceEnv)) throw failure(`secretEnvironment.${target}.sourceEnv is invalid`);
    return [target, { sourceEnv }];
  }));
}

function makeId(name, existingIds) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'mcp-server';
  let id = base;
  while (existingIds.has(id)) id = `${base.slice(0, 61)}-${randomUUID().slice(0, 8)}`;
  return id;
}

export function normalizeMcpDefinition(input, { existingIds = new Set(), existingNames = new Set(), currentId = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('MCP server must be an object');
  const name = text(input.name, 'name', { required: true, max: 64 });
  if (!NAME_PATTERN.test(name)) throw failure('name must contain only letters, numbers, underscores, and hyphens');
  if (existingNames.has(name.toLowerCase())) throw failure(`An MCP server named ${name} already exists`, 409);
  const requestedId = text(input.id, 'id', { max: 80 });
  if (requestedId && !ID_PATTERN.test(requestedId)) throw failure('id must contain lowercase letters, numbers, and hyphens only');
  const id = currentId ?? requestedId ?? makeId(name, existingIds);
  const transport = input.transport ?? 'stdio';
  if (!['stdio', 'http'].includes(transport)) throw failure('transport must be stdio or http');
  const args = input.args ?? [];
  if (!Array.isArray(args)) throw failure('args must be an array');
  if (args.length > 64) throw failure('args supports at most 64 values');
  const normalizedArgs = args.map((arg, index) => text(arg, `args[${index}]`, { required: true, max: 2000 }));
  const command = text(input.command, 'command', { max: 500 });
  const cwd = text(input.cwd, 'cwd', { max: 1000 });
  const url = text(input.url, 'url', { max: 2000 });
  if (transport === 'stdio') {
    if (!command) throw failure('command is required for a stdio MCP server');
    if (url) throw failure('url is only valid for an HTTP MCP server');
    if (cwd && !cwd.startsWith('/workspace')) throw failure('cwd must be inside /workspace');
  } else {
    if (!url) throw failure('url is required for an HTTP MCP server');
    if (command || normalizedArgs.length || cwd) throw failure('command, args, and cwd are only valid for a stdio MCP server');
    let parsed;
    try { parsed = new URL(url); } catch { throw failure('url must be a valid absolute URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw failure('url must use HTTP or HTTPS');
    if (parsed.username || parsed.password) throw failure('url must not contain embedded credentials; use a connector secret reference');
  }
  const timeoutMs = input.timeoutMs === undefined ? 30_000 : Number(input.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) {
    throw failure('timeoutMs must be an integer between 1000 and 300000');
  }
  const environment = stringMap(input.environment, 'environment', { names: true });
  const secretEnvironment = secretEnvironmentMap(input.secretEnvironment);
  const headers = stringMap(input.headers, 'headers');
  const secretHeaders = secretHeaderMap(input.secretHeaders);
  const credentialId = text(input.credentialId, 'credentialId', { max: 80 });
  if (credentialId && !ID_PATTERN.test(credentialId)) throw failure('credentialId must contain lowercase letters, numbers, and hyphens only');
  if (credentialId && transport !== 'http') throw failure('credentialId is only valid for an HTTP MCP server');
  // Both would mean two mechanisms deciding the same header, with no rule for
  // which wins. Pick one.
  if (credentialId && Object.keys(secretHeaders).length) {
    throw failure('a definition uses either credentialId or secretHeaders, not both');
  }
  const now = new Date().toISOString();
  return {
    id,
    name,
    transport,
    command: transport === 'stdio' ? command : null,
    args: transport === 'stdio' ? normalizedArgs : [],
    cwd: transport === 'stdio' ? cwd ?? null : null,
    url: transport === 'http' ? url : null,
    environment,
    secretEnvironment,
    headers: transport === 'http' ? headers : {},
    secretHeaders: transport === 'http' ? secretHeaders : {},
    credentialId: transport === 'http' ? credentialId ?? null : null,
    timeoutMs,
    createdAt: input.createdAt ?? now,
    updatedAt: now
  };
}

export function publicMcpDefinition(server) {
  return JSON.parse(JSON.stringify(server));
}

export function normalizeStoredMcpDefinition(server) {
  const normalized = normalizeMcpDefinition(server, { currentId: server.id });
  normalized.updatedAt = server.updatedAt ?? normalized.updatedAt;
  return normalized;
}

export function createMcpService({ servers, bindings, agents, persist, workerRequest, credentials = null }) {
  // A reference to a credential that does not exist must fail when it is written,
  // not silently at apply time in front of whoever is running a task.
  function requireCredential(server) {
    if (!server.credentialId || !credentials) return;
    try {
      credentials.get(server.credentialId);
    } catch {
      throw failure(`Credential ${server.credentialId} does not exist`, 400);
    }
  }

  const requireAgent = (agentId) => {
    const agent = agents.get(agentId);
    if (!agent) throw failure('Agent not found', 404);
    return agent;
  };
  const requireServer = (serverId) => {
    const server = servers.get(serverId);
    if (!server) throw failure('MCP server not found', 404);
    return server;
  };
  const bindingKey = (agentId, serverId) => `${agentId}:${serverId}`;

  function listServers() {
    return [...servers.values()].map(publicMcpDefinition);
  }

  function getServer(serverId) {
    return publicMcpDefinition(requireServer(serverId));
  }

  async function createServer(input) {
    const server = normalizeMcpDefinition(input, {
      existingIds: new Set(servers.keys()),
      existingNames: new Set([...servers.values()].map((item) => item.name.toLowerCase()))
    });
    requireCredential(server);
    servers.set(server.id, server);
    await persist();
    return publicMcpDefinition(server);
  }

  async function updateServer(serverId, input) {
    const existing = requireServer(serverId);
    const server = normalizeMcpDefinition({ ...existing, ...input, id: serverId, createdAt: existing.createdAt }, {
      currentId: serverId,
      existingNames: new Set([...servers.values()].filter((item) => item.id !== serverId).map((item) => item.name.toLowerCase()))
    });
    requireCredential(server);
    servers.set(serverId, server);
    const now = new Date().toISOString();
    for (const binding of bindings.values()) {
      if (binding.serverId === serverId) Object.assign(binding, { state: 'pending', error: null, updatedAt: now });
    }
    await persist();
    return publicMcpDefinition(server);
  }

  async function deleteServer(serverId) {
    requireServer(serverId);
    const attached = [...bindings.values()].filter((binding) => binding.serverId === serverId);
    if (attached.length) throw failure('Detach this MCP server from every agent before deleting it', 409);
    servers.delete(serverId);
    await persist();
  }

  function desiredServers(agentId) {
    return [...bindings.values()]
      .filter((binding) => binding.agentId === agentId && binding.enabled)
      .map((binding) => requireServer(binding.serverId));
  }

  async function inspectAgent(agentId) {
    const agent = requireAgent(agentId);
    const desired = [...bindings.values()]
      .filter((binding) => binding.agentId === agentId)
      .map((binding) => ({ ...binding, server: publicMcpDefinition(requireServer(binding.serverId)) }));
    let runtime = null;
    try { runtime = await workerRequest(agent, 'GET', '/v1/mcp'); }
    catch (error) { runtime = { unavailable: true, error: error.message }; }
    return { agentId, bindings: desired, runtime };
  }

  function resolveCredentials(selected) {
    if (!credentials) return {};
    const resolved = {};
    for (const server of selected) {
      if (!server.credentialId) continue;
      // Throws when the destination is outside the credential's host list, so a
      // definition cannot redirect a credential by editing its url.
      resolved[server.credentialId] = credentials.resolveForHost(server.credentialId, server.url);
    }
    return resolved;
  }

  // An older worker ignores an unknown `credentials` field and applies the
  // definition with no header at all, reporting success. "No secretHeaders" used
  // to mean "unauthenticated by design"; it must not now silently also mean
  // "authenticated by a mechanism this worker cannot speak".
  async function requireCredentialDelivery(agent, selected) {
    if (!selected.some((server) => server.credentialId)) return;
    let supported = false;
    try {
      const inspected = await workerRequest(agent, 'GET', '/v1/mcp');
      supported = inspected?.mcp?.capabilities?.credentialDelivery === true;
    } catch (error) {
      throw failure(`Could not confirm this runtime supports delivered credentials: ${error.message}`, 502);
    }
    if (!supported) {
      throw failure(
        'This runtime does not support control-plane delivered credentials, and would apply the connector '
        + 'with no credential at all. Refresh the runtime onto the current image, then apply again.',
        409
      );
    }
  }

  async function applyAgent(agentId) {
    const agent = requireAgent(agentId);
    const selected = desiredServers(agentId);
    const now = new Date().toISOString();
    try {
      // Resolve before contacting the worker at all: a destination outside a
      // credential's host list has to fail without a round trip, and the failure
      // has to mark the bindings like any other apply failure.
      const resolved = resolveCredentials(selected);
      await requireCredentialDelivery(agent, selected);
      const result = await workerRequest(agent, 'PUT', '/v1/mcp', {
        servers: selected,
        credentials: resolved
      });
      for (const binding of bindings.values()) {
        if (binding.agentId === agentId) Object.assign(binding, { state: binding.enabled ? 'applied' : 'disabled', error: null, appliedAt: now, updatedAt: now });
      }
      await persist();
      return result;
    } catch (error) {
      for (const binding of bindings.values()) {
        if (binding.agentId === agentId && binding.enabled) Object.assign(binding, { state: 'error', error: error.message, updatedAt: now });
      }
      await persist();
      throw error;
    }
  }

  async function bind(agentId, serverId, { enabled = true, apply = true } = {}) {
    requireAgent(agentId);
    requireServer(serverId);
    const key = bindingKey(agentId, serverId);
    if (bindings.has(key)) throw failure('This MCP server is already attached to the agent', 409);
    const now = new Date().toISOString();
    const binding = { id: key, agentId, serverId, enabled: enabled !== false, state: 'pending', error: null, appliedAt: null, createdAt: now, updatedAt: now };
    bindings.set(key, binding);
    await persist();
    let runtime = null;
    if (apply) runtime = await applyAgent(agentId);
    return { binding: { ...binding, server: publicMcpDefinition(requireServer(serverId)) }, runtime };
  }

  async function unbind(agentId, serverId, { apply = true } = {}) {
    requireAgent(agentId);
    const key = bindingKey(agentId, serverId);
    if (!bindings.has(key)) throw failure('MCP binding not found', 404);
    bindings.delete(key);
    await persist();
    if (apply) return applyAgent(agentId);
    return null;
  }

  async function setBinding(agentId, serverId, input) {
    requireAgent(agentId);
    const binding = bindings.get(bindingKey(agentId, serverId));
    if (!binding) throw failure('MCP binding not found', 404);
    if (typeof input.enabled !== 'boolean') throw failure('enabled must be a boolean');
    binding.enabled = input.enabled;
    binding.state = 'pending';
    binding.error = null;
    binding.updatedAt = new Date().toISOString();
    await persist();
    const runtime = input.apply === false ? null : await applyAgent(agentId);
    return { binding: { ...binding, server: publicMcpDefinition(requireServer(serverId)) }, runtime };
  }

  async function validateForAgent(agentId, input) {
    const agent = requireAgent(agentId);
    const server = input.serverId
      ? requireServer(input.serverId)
      : normalizeMcpDefinition(input.server, {
          existingIds: new Set(servers.keys()),
          existingNames: new Set([...servers.values()].map((item) => item.name.toLowerCase()))
        });
    return workerRequest(agent, 'POST', '/v1/mcp/validate', { servers: [server] });
  }

  return { listServers, getServer, createServer, updateServer, deleteServer, inspectAgent, applyAgent, bind, unbind, setBinding, validateForAgent };
}
