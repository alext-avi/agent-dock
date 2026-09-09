import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  applyCodexMcpServers,
  codexMcpCapabilities,
  codexMcpTaskEnvironment,
  validateCodexMcpServers
} from '../adapters/codex-mcp.mjs';
import {
  claudeMcpCapabilities,
  claudeMcpTaskArguments,
  observeClaudeMcpInit,
  renderClaudeMcpConfig,
  validateClaudeMcpServers
} from '../adapters/mcp/claude.mjs';
import {
  openCodeMcpCapabilities,
  openCodeMcpTaskEnvironment,
  parseOpenCodeMcpList,
  renderOpenCodeMcpConfig,
  validateOpenCodeMcpServers
} from '../adapters/opencode-mcp.mjs';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

function missingSecret(name) {
  const error = new Error(
    `Connector secret ${name} is not configured in this agent container. `
    + `Provide it as ${CONNECTOR_SECRET_PREFIX}${name}; only that namespace is resolvable.`
  );
  error.status = 409;
  return error;
}

// Connector secrets live in their own namespace, separate from the worker's own
// control variables. A definition names the logical secret; the worker resolves
// it from CONNECTOR_SECRET_PREFIX + that name and can see nothing else. This is
// why a definition cannot name WORKER_TOKEN, HOME, or OLLAMA_BASE_URL: they are
// not in the map at all, so there is nothing to validate against and nothing to
// get wrong.
export const CONNECTOR_SECRET_PREFIX = 'MCP_SECRET_';

// Reduce a process environment to the connector secrets it carries, keyed by the
// logical name a definition uses.
export function connectorSecrets(environment = {}) {
  const secrets = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!key.startsWith(CONNECTOR_SECRET_PREFIX)) continue;
    const name = key.slice(CONNECTOR_SECRET_PREFIX.length);
    if (name) secrets[name] = value;
  }
  return secrets;
}

// Reference names a definition uses that the connector-secret map cannot satisfy.
// Silent about the reason on purpose: an unprovisioned name and an illegitimate
// one are both simply absent from the map.
export function unresolvedSecretReferences(servers, environment = {}) {
  const names = (server) => Object.values(server?.placeholders ?? {})
    .filter((binding) => binding?.source === 'connector-secret')
    .map((binding) => binding.name);

  return (servers ?? []).flatMap((server) => names(server)
    .filter((name) => name && environment[name] === undefined)
    .map((name) => ({ server: server.name ?? server.id, name })));
}

// Placeholders: one mechanism instead of three.
//
// A definition is written the way the connector actually looks, with ${NAME}
// wherever a secret belongs — an argument, a url, a header, an environment
// value. The presence of a placeholder is what declares that a binding is
// needed; there is no separate question about whether the connector has
// authentication, and nothing to ask when it has none.
//
// Substitution happens here, at the last possible moment, and the value is never
// written back into the stored definition. A value substituted into argv is
// readable by other processes in that same container, which is the same trust
// boundary as its environment — the agent can already read its own secrets — but
// it is a real difference from the environment on any host that shares a process
// table, so it is documented rather than glossed.
export const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// Must match the control plane's deliveryKey. The two cannot share a module
// without putting worker code above the wrapper, so test/placeholders.test.mjs
// asserts they agree.
export function deliveryKeyFor(server, name) {
  return `${server.id}\u0000${name}`;
}

export function placeholderNames(server) {
  const found = new Set();
  const scan = (value) => {
    if (typeof value !== 'string') return;
    for (const match of value.matchAll(PLACEHOLDER)) found.add(match[1]);
  };
  scan(server?.url);
  scan(server?.cwd);
  for (const argument of server?.args ?? []) scan(argument);
  for (const value of Object.values(server?.headers ?? {})) scan(value);
  for (const value of Object.values(server?.environment ?? {})) scan(value);
  return [...found];
}

function unboundPlaceholder(name) {
  const error = new Error(
    `The placeholder ${name} has no value. Bind it to a stored key or a connector secret, `
    + 'or remove it from the definition.'
  );
  error.status = 409;
  error.code = 'unbound_placeholder';
  return error;
}

// Values come from two places and neither is the definition: a credential the
// control plane resolved and delivered for this apply, or a connector secret
// provisioned in this container's own MCP_SECRET_ namespace.
function placeholderValues(server, environment, delivered) {
  const values = {};
  for (const name of placeholderNames(server)) {
    const binding = server.placeholders?.[name];
    if (!binding) throw unboundPlaceholder(name);
    if (binding.source === 'credential') {
      const credential = delivered?.[deliveryKeyFor(server, name)];
      if (!credential) {
        const error = new Error(
          `The stored key for ${name} was not delivered with this configuration. `
          + 'Delivered values are held in memory, so a worker restart needs a fresh apply.'
        );
        error.status = 409;
        error.code = 'missing_credential';
        throw error;
      }
      values[name] = credential.value;
      continue;
    }
    const value = environment[binding.name];
    if (value === undefined) throw missingSecret(binding.name);
    values[name] = value;
  }
  return values;
}

function fill(value, values) {
  if (typeof value !== 'string') return value;
  return value.replace(PLACEHOLDER, (whole, name) => (name in values ? values[name] : whole));
}

function resolveServers(servers, environment, { requireSecrets, credentials } = {}) {
  return servers.map((server) => {
    const resolved = clone(server);
    resolved.environment = { ...(server.environment ?? {}) };
    resolved.headers = { ...(server.headers ?? {}) };
    // Fill the definition itself. Only when secrets are required: validation runs
    // without them and must not report a shape nobody will ever run.
    if (requireSecrets) {
      const values = placeholderValues(server, environment, credentials);
      resolved.url = fill(resolved.url, values);
      resolved.cwd = fill(resolved.cwd, values);
      resolved.args = (resolved.args ?? []).map((argument) => fill(argument, values));
      for (const [header, value] of Object.entries(resolved.headers)) {
        resolved.headers[header] = fill(value, values);
      }
      for (const [key, value] of Object.entries(resolved.environment)) {
        resolved.environment[key] = fill(value, values);
      }
    }
    return resolved;
  });
}

function publicState(state, capabilities, health, pendingCredentials = []) {
  return {
    schemaVersion: 1,
    capabilities,
    generation: state.generation,
    appliedAt: state.appliedAt,
    // Named connectors whose credential was not delivered to this process. A
    // restart empties the delivery, so this is how the control plane learns that
    // its record of 'applied' is ahead of what the worker can actually do.
    pendingCredentials,
    activation: capabilities.activation ?? 'next-task',
    restartRequired: capabilities.restartRequired === true,
    servers: clone(state.servers),
    health: clone(health)
  };
}

function openCodeConfigurationError() {
  const error = new Error('OpenCode configuration could not be resolved safely before task start');
  error.status = 409;
  error.code = 'OPENCODE_CONFIG_UNAVAILABLE';
  return error;
}

function openCodeServerNames(output) {
  let resolved;
  try {
    resolved = JSON.parse(String(output ?? ''));
  } catch {
    throw openCodeConfigurationError();
  }
  if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) {
    throw openCodeConfigurationError();
  }
  if (resolved.mcp === undefined) return [];
  if (!resolved.mcp || typeof resolved.mcp !== 'object' || Array.isArray(resolved.mcp)) {
    throw openCodeConfigurationError();
  }
  return Object.keys(resolved.mcp);
}

export function createMcpManager(options) {
  const adapterId = options.adapterId;
  // Two different things, conflated until this was caught: the narrow map a
  // definition's secret references resolve against, and the full process
  // environment a spawned harness command needs to run at all. Passing the
  // narrow one to spawn() left codex with no PATH; passing the full one to the
  // resolver was the vulnerability. They must stay separate.
  const environment = options.environment ?? process.env;
  const execEnvironment = options.execEnvironment ?? process.env;
  const workspace = options.workspace ?? '/workspace';
  const allowedCommands = new Set(options.allowedCommands ?? []);
  const statePath = options.statePath;
  const configDir = options.configDir;
  const providerConfigPath = options.providerConfigPath;
  const run = options.run;
  const demoMode = options.demoMode === true;
  const capabilities = adapterId === 'claude-code'
    ? claudeMcpCapabilities
    : adapterId === 'opencode' ? openCodeMcpCapabilities : codexMcpCapabilities;
  let state = { schemaVersion: 1, generation: 0, appliedAt: null, servers: [] };
  let health = { checkedAt: null, servers: [] };
  let ready = load();

  async function load() {
    if (!statePath) return;
    try {
      const stored = JSON.parse(await readFile(statePath, 'utf8'));
      if (Array.isArray(stored.servers)) state = { ...state, ...stored, servers: stored.servers };
      if (stored.health) health = stored.health;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async function persist() {
    if (statePath) await atomicJson(statePath, { ...state, health });
  }

  // Adapter validators only check the shape of a secret reference, so a preview
  // could report "valid" for a definition apply would refuse. Say so instead.
  function withMissingSecrets(result, servers) {
    const warnings = unresolvedSecretReferences(servers, environment).map(({ server, name }) => ({
      field: 'secret',
      code: 'unresolved_connector_secret',
      message: `${server} references connector secret ${name}; set MCP_SECRET_${name} or applying will fail`
    }));
    if (!warnings.length) return result;
    return { ...result, warnings: [...(result.warnings ?? []), ...warnings] };
  }

  function validate(servers, { requireSecrets = false, credentials = null } = {}) {
    if (!Array.isArray(servers)) return { valid: false, errors: [{ field: 'servers', code: 'invalid_type', message: 'servers must be an array' }], warnings: [] };
    const legacyErrors = servers.flatMap((server, index) => ['credentialId', 'secretHeaders', 'secretEnvironment']
      .filter((field) => {
        const value = server?.[field];
        return value !== undefined && value !== null
          && (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0);
      })
      .map((field) => ({
        index,
        name: server?.name ?? null,
        field,
        code: 'unsupported_legacy_credential',
        message: `${field} is no longer supported; put \${NAME} where the value belongs and bind it in placeholders`
      })));
    if (legacyErrors.length) return { valid: false, errors: legacyErrors, warnings: [] };
    let resolved;
    try { resolved = resolveServers(servers, environment, { requireSecrets, credentials: credentials ?? deliveredCredentials }); }
    catch (error) {
      // Keep the distinction the thrower made: an undelivered credential is a
      // delivery problem, not a mistyped reference.
      return { valid: false, errors: [{ field: 'secret', code: error.code ?? 'missing_worker_secret', message: error.message }], warnings: [] };
    }
    const context = { workspace, allowedCommands };
    if (adapterId === 'claude-code') return withMissingSecrets(validateClaudeMcpServers(resolved, context), servers);
    if (adapterId === 'opencode') return withMissingSecrets(validateOpenCodeMcpServers(resolved, context), servers);
    return withMissingSecrets(validateCodexMcpServers(resolved, context), servers);
  }

  let deliveredCredentials = {};

  function pendingCredentials() {
    const waiting = (server) => {
      return Object.entries(server.placeholders ?? {}).some(([name, binding]) =>
        binding.source === 'credential' && !deliveredCredentials[deliveryKeyFor(server, name)]);
    };
    return state.servers.filter(waiting).map((server) => server.name);
  }

  async function apply(servers, credentials = {}) {
    await ready;
    const desired = clone(servers);
    const previousCredentials = deliveredCredentials;
    const nextCredentials = credentials ?? {};
    const validation = validate(desired, { requireSecrets: true, credentials: nextCredentials });
    if (!validation.valid) {
      const error = new Error(validation.errors.map((item) => item.message).join('; ') || 'Invalid MCP configuration');
      error.status = 400;
      error.validation = validation;
      throw error;
    }
    const resolved = resolveServers(desired, environment, { requireSecrets: true, credentials: nextCredentials });
    if (adapterId === 'claude-code') {
      await atomicJson(path.join(configDir, 'claude.json'), renderClaudeMcpConfig(resolved, { workspace, allowedCommands }));
    } else if (adapterId === 'opencode') {
      let baseConfig = {};
      try { baseConfig = JSON.parse(await readFile(providerConfigPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await atomicJson(providerConfigPath, renderOpenCodeMcpConfig(resolved, { baseConfig, workspace, allowedCommands }));
    } else {
      // Rollback values are memory-only too. Prefer the newly delivered map (it
      // normally contains every still-attached connector), then the last apply's
      // values. If a removed connector's value is unavailable after a restart,
      // the adapter can still remove its managed name but cannot pretend it can
      // restore a configuration containing an unresolved placeholder.
      let previousServers = [];
      try {
        previousServers = resolveServers(state.servers, environment, {
          requireSecrets: true,
          credentials: { ...previousCredentials, ...nextCredentials }
        });
      } catch { /* no safe rollback definition is available */ }
      await applyCodexMcpServers(resolved, {
        previousServers,
        previousNames: state.servers.map((server) => server.name),
        allowedCommands,
        env: execEnvironment,
        run,
        demoMode
      });
    }
    // Commit the memory-only delivery only after the provider accepted the new
    // configuration. A failed Codex apply may restore the previous native MCP;
    // swapping this first would then run that restored configuration with the
    // rejected definition's values.
    deliveredCredentials = nextCredentials;
    state = { schemaVersion: 1, generation: state.generation + 1, appliedAt: new Date().toISOString(), servers: desired };
    health = {
      checkedAt: state.appliedAt,
      servers: desired.map((server) => ({ name: server.name, status: 'configured', error: null }))
    };
    await persist();
    return publicState(state, capabilities, health, pendingCredentials());
  }

  async function inspect({ probe = false } = {}) {
    await ready;
    if (probe && adapterId === 'opencode' && !demoMode && typeof run === 'function') {
      const resolved = resolveServers(state.servers, environment, { requireSecrets: false });
      const taskEnv = openCodeMcpTaskEnvironment(execEnvironment, resolved, { allowedCommands });
      const result = await run('opencode', ['mcp', 'list'], { env: taskEnv, timeout: 30_000 });
      health = { checkedAt: new Date().toISOString(), ...parseOpenCodeMcpList(result.output, resolved) };
      await persist();
    }
    return publicState(state, capabilities, health, pendingCredentials());
  }

  async function taskContext(baseEnvironment) {
    await ready;
    const resolved = resolveServers(state.servers, environment, { requireSecrets: true, credentials: deliveredCredentials });
    if (adapterId === 'claude-code') {
      const configPath = path.join(configDir, 'claude.json');
      // Re-render at every task start so a brand-new worker always has a strict
      // empty file and worker-local secret rotation is reflected immediately.
      await atomicJson(configPath, renderClaudeMcpConfig(resolved, { workspace, allowedCommands }));
      return { args: claudeMcpTaskArguments(configPath), env: baseEnvironment };
    }
    if (adapterId === 'opencode') {
      let disableServerNames = [];
      if (!demoMode) {
        if (typeof run !== 'function') throw openCodeConfigurationError();
        const result = await run('opencode', ['debug', 'config', '--pure'], {
          env: baseEnvironment,
          cwd: workspace,
          timeout: 30_000
        });
        if (result.code !== 0) throw openCodeConfigurationError();
        disableServerNames = openCodeServerNames(result.output);
      }
      return {
        args: [],
        env: openCodeMcpTaskEnvironment(baseEnvironment, resolved, { allowedCommands, disableServerNames })
      };
    }
    return { args: [], env: codexMcpTaskEnvironment(baseEnvironment, resolved) };
  }

  async function observe(event) {
    if (adapterId !== 'claude-code') return;
    const observation = observeClaudeMcpInit(event);
    if (!observation) return;
    health = { checkedAt: observation.observedAt, servers: observation.servers, errors: observation.errors };
    await persist();
  }

  return { capabilities, validate, apply, inspect, taskContext, observe };
}
