const ANSI = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MAX_SERVERS = 64;
const MAX_ARGUMENTS = 128;
const MAX_VALUE_LENGTH = 16_384;
const MAX_TIMEOUT_MS = 12 * 60 * 60 * 1000;

export const openCodeMcpCapabilities = Object.freeze({
  supported: true,
  management: true,
  transports: Object.freeze(['stdio', 'http']),
  validate: true,
  apply: true,
  inspect: true,
  dynamicApply: true,
  configuration: 'managed-file',
  activation: 'next-task',
  healthObservation: 'provider-inspection',
  restartRequired: false,
  remoteOAuth: true,
  configDialect: 'opencode-v1',
  secretDelivery: 'worker-resolved-environment',
  localCommandPolicy: 'allowlist'
});

export class OpenCodeMcpValidationError extends Error {
  constructor(result) {
    super(result.errors.map((error) => error.message).join('; ') || 'Invalid OpenCode MCP configuration');
    this.name = 'OpenCodeMcpValidationError';
    this.status = 400;
    this.validation = result;
  }
}

function issue(index, server, field, code, message) {
  return { index, name: typeof server?.name === 'string' ? server.name : null, field, code, message };
}

function commandAllowed(command, allowedCommands) {
  const allowed = allowedCommands instanceof Set ? allowedCommands : new Set(allowedCommands ?? []);
  return allowed.has(command);
}

function validateStringMap(value, { index, server, field, keyPattern, errors }) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(issue(index, server, field, 'invalid_type', `${server.name || `Server ${index + 1}`} ${field} must be an object of strings`));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!keyPattern.test(key)) {
      errors.push(issue(index, server, `${field}.${key}`, 'invalid_name', `${server.name} has an invalid ${field} name: ${key}`));
    }
    if (typeof entry !== 'string' || entry.length > MAX_VALUE_LENGTH || /\0|[\r\n]/.test(entry)) {
      errors.push(issue(index, server, `${field}.${key}`, 'invalid_value', `${server.name} ${field}.${key} must be a single bounded string`));
    }
  }
}

function normalizedServer(server) {
  const enabled = server.enabled !== false;
  const common = {
    name: server.name,
    transport: server.transport,
    enabled,
    timeoutMs: server.timeoutMs ?? undefined
  };
  if (server.transport === 'stdio') {
    return {
      ...common,
      command: server.command,
      args: server.args ?? [],
      cwd: server.cwd || undefined,
      environment: server.environment ? { ...server.environment } : undefined
    };
  }
  return {
    ...common,
    url: server.url,
    headers: server.headers ? { ...server.headers } : undefined
  };
}

/**
 * Validate the provider-neutral MCP DTO before translating it to OpenCode config.
 * Local commands are deliberately denied unless their exact executable is allowed.
 */
export function validateOpenCodeMcpServers(servers, options = {}) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(servers)) {
    return {
      valid: false,
      errors: [issue(-1, null, 'servers', 'invalid_type', 'MCP servers must be an array')],
      warnings
    };
  }
  if (servers.length > MAX_SERVERS) {
    errors.push(issue(-1, null, 'servers', 'too_many', `At most ${MAX_SERVERS} MCP servers may be attached to one agent`));
  }

  const names = new Set();
  for (const [index, server] of servers.entries()) {
    if (!server || typeof server !== 'object' || Array.isArray(server)) {
      errors.push(issue(index, server, '', 'invalid_type', `MCP server ${index + 1} must be an object`));
      continue;
    }
    if (typeof server.name !== 'string' || !SERVER_NAME.test(server.name)) {
      errors.push(issue(index, server, 'name', 'invalid_name', `MCP server ${index + 1} needs a 1-64 character alphanumeric, underscore, or hyphen name`));
    } else {
      const canonicalName = server.name.toLowerCase();
      if (names.has(canonicalName)) {
        errors.push(issue(index, server, 'name', 'duplicate_name', `MCP server name ${server.name} is duplicated`));
      }
      names.add(canonicalName);
    }
    if (!['stdio', 'http'].includes(server.transport)) {
      errors.push(issue(index, server, 'transport', 'unsupported_transport', `${server.name || `Server ${index + 1}`} transport must be stdio or http`));
      continue;
    }
    if (server.enabled !== undefined && typeof server.enabled !== 'boolean') {
      errors.push(issue(index, server, 'enabled', 'invalid_type', `${server.name} enabled must be a boolean`));
    }
    if (
      server.timeoutMs !== undefined
      && (!Number.isInteger(server.timeoutMs) || server.timeoutMs < 1 || server.timeoutMs > MAX_TIMEOUT_MS)
    ) {
      errors.push(issue(index, server, 'timeoutMs', 'invalid_timeout', `${server.name} timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`));
    }

    if (server.transport === 'stdio') {
      if (typeof server.command !== 'string' || !server.command.trim() || server.command.length > 1024 || /\0|[\r\n]/.test(server.command)) {
        errors.push(issue(index, server, 'command', 'invalid_command', `${server.name} requires a bounded executable command`));
      } else if (!commandAllowed(server.command, options.allowedCommands)) {
        errors.push(issue(index, server, 'command', 'command_not_allowed', `${server.name} command is not allowed by this worker`));
      }
      if (server.url || Object.keys(server.headers ?? {}).length) {
        errors.push(issue(index, server, 'transport', 'mixed_transport_fields', `${server.name} cannot combine stdio and HTTP fields`));
      }
      if (server.args !== undefined && (!Array.isArray(server.args) || server.args.length > MAX_ARGUMENTS)) {
        errors.push(issue(index, server, 'args', 'invalid_arguments', `${server.name} args must be an array with at most ${MAX_ARGUMENTS} entries`));
      } else {
        for (const [argumentIndex, argument] of (server.args ?? []).entries()) {
          if (typeof argument !== 'string' || argument.length > MAX_VALUE_LENGTH || /\0|[\r\n]/.test(argument)) {
            errors.push(issue(index, server, `args.${argumentIndex}`, 'invalid_argument', `${server.name} argument ${argumentIndex + 1} must be a single bounded string`));
          }
        }
      }
      if (server.cwd !== undefined && (
        typeof server.cwd !== 'string'
        || !server.cwd.trim()
        || server.cwd.length > 4096
        || /\0|[\r\n]/.test(server.cwd)
      )) {
        errors.push(issue(index, server, 'cwd', 'invalid_working_directory', `${server.name} cwd must be a bounded path`));
      }
      validateStringMap(server.environment, {
        index, server, field: 'environment', keyPattern: ENVIRONMENT_NAME, errors
      });
      if (server.command === 'npx' || server.command?.endsWith('/npx')) {
        warnings.push(issue(index, server, 'command', 'package_runner', `${server.name} uses npx; allow its package and arguments explicitly at the runtime policy boundary`));
      }
    } else {
      if (server.command || (server.args?.length ?? 0) || server.cwd || Object.keys(server.environment ?? {}).length) {
        errors.push(issue(index, server, 'transport', 'mixed_transport_fields', `${server.name} cannot combine HTTP and stdio fields`));
      }
      try {
        const url = new URL(server.url);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol');
        if (url.username || url.password) {
          errors.push(issue(index, server, 'url', 'embedded_credentials', `${server.name} URL must not contain credentials`));
        }
        if (options.allowedHttpOrigins?.length && !options.allowedHttpOrigins.includes(url.origin)) {
          errors.push(issue(index, server, 'url', 'origin_not_allowed', `${server.name} URL origin is not allowed by this worker`));
        }
      } catch {
        errors.push(issue(index, server, 'url', 'invalid_url', `${server.name} requires an absolute HTTP or HTTPS URL`));
      }
      validateStringMap(server.headers, {
        index, server, field: 'headers', keyPattern: HEADER_NAME, errors
      });
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}

function requireValid(servers, options) {
  const result = validateOpenCodeMcpServers(servers, options);
  if (!result.valid) throw new OpenCodeMcpValidationError(result);
  return servers.map(normalizedServer);
}

function renderServer(server) {
  if (server.transport === 'stdio') {
    return {
      type: 'local',
      command: [server.command, ...server.args],
      enabled: server.enabled,
      ...(server.cwd ? { cwd: server.cwd } : {}),
      ...(server.environment && Object.keys(server.environment).length ? { environment: server.environment } : {}),
      ...(server.timeoutMs ? { timeout: server.timeoutMs } : {})
    };
  }
  return {
    type: 'remote',
    url: server.url,
    enabled: server.enabled,
    ...(server.headers && Object.keys(server.headers).length ? { headers: server.headers, oauth: false } : {}),
    ...(server.timeoutMs ? { timeout: server.timeoutMs } : {})
  };
}

function renderedServerMap(servers) {
  return Object.fromEntries(servers.map((server) => [server.name, renderServer(server)]));
}

/** Preserve provider/model configuration while making the managed MCP set authoritative. */
export function renderOpenCodeMcpConfig(servers, options = {}) {
  const normalized = requireValid(servers, options);
  const baseConfig = options.baseConfig ?? {};
  if (!baseConfig || typeof baseConfig !== 'object' || Array.isArray(baseConfig)) {
    throw new TypeError('baseConfig must be an object');
  }
  return {
    $schema: baseConfig.$schema ?? 'https://opencode.ai/config.json',
    ...baseConfig,
    mcp: renderedServerMap(normalized)
  };
}

/**
 * Build OpenCode's high-precedence inline config for a task. The caller supplies
 * unmanaged server names found in lower-precedence config so they can be disabled.
 */
export function openCodeMcpTaskEnvironment(baseEnvironment, servers, options = {}) {
  const normalized = requireValid(servers, options);
  const environment = { ...(baseEnvironment ?? {}) };
  let existing = {};
  if (environment.OPENCODE_CONFIG_CONTENT) {
    try {
      existing = JSON.parse(environment.OPENCODE_CONFIG_CONTENT);
    } catch {
      throw new OpenCodeMcpValidationError({
        valid: false,
        errors: [issue(-1, null, 'OPENCODE_CONFIG_CONTENT', 'invalid_json', 'Existing OPENCODE_CONFIG_CONTENT must be valid JSON')],
        warnings: []
      });
    }
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      throw new OpenCodeMcpValidationError({
        valid: false,
        errors: [issue(-1, null, 'OPENCODE_CONFIG_CONTENT', 'invalid_type', 'Existing OPENCODE_CONFIG_CONTENT must contain a JSON object')],
        warnings: []
      });
    }
  }

  const managed = renderedServerMap(normalized);
  const managedNames = new Set(Object.keys(managed).map((name) => name.toLowerCase()));
  if ((options.disableServerNames?.length ?? 0) > 256) {
    throw new OpenCodeMcpValidationError({
      valid: false,
      errors: [issue(-1, null, 'mcp', 'too_many_unmanaged_servers', 'OpenCode resolved too many unmanaged MCP servers')],
      warnings: []
    });
  }
  const disabledUnmanaged = Object.create(null);
  for (const name of options.disableServerNames ?? []) {
    if (typeof name !== 'string' || !name || name.length > 256 || /\0|[\r\n]/.test(name)) {
      throw new OpenCodeMcpValidationError({
        valid: false,
        errors: [issue(-1, null, 'mcp', 'invalid_unmanaged_name', 'OpenCode resolved an invalid unmanaged MCP server name')],
        warnings: []
      });
    }
    if (!managedNames.has(name.toLowerCase())) disabledUnmanaged[name] = { enabled: false };
  }
  environment.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    ...existing,
    mcp: { ...disabledUnmanaged, ...managed }
  });
  return environment;
}

function stripAnsi(value) {
  return String(value ?? '').replace(ANSI, '').replace(/\r/g, '');
}

function sensitiveValues(server) {
  return [
    ...Object.values(server.environment ?? {}),
    ...Object.values(server.headers ?? {})
  ].filter((value) => typeof value === 'string' && value.length >= 3);
}

function sanitizeFailure(value, server) {
  let message = stripAnsi(value).trim();
  for (const secret of sensitiveValues(server)) message = message.split(secret).join('[redacted]');
  message = message
    .replace(/https?:\/\/[^\s]+/gi, '[redacted-url]')
    .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:token|secret|password|api[-_]?key)\s*[:=]\s*[^\s]+/gi, '$1=[redacted]');
  return message.slice(0, 500);
}

function statusFromLine(line) {
  if (/needs[_ -]?auth|authentication required/i.test(line)) return 'needs_auth';
  if (/\bconnected\b/i.test(line)) return 'connected';
  if (/\bdisabled\b/i.test(line)) return 'disabled';
  if (/\bfailed\b|\berror\b/i.test(line)) return 'failed';
  return null;
}

/** Parse only known server names and discard provider command, URL, and secret detail. */
export function parseOpenCodeMcpList(output, configuredServers = []) {
  const servers = configuredServers.map(normalizedServer);
  const result = new Map(servers.map((server) => [server.name, {
    name: server.name,
    transport: server.transport,
    enabled: server.enabled,
    status: server.enabled ? 'unknown' : 'disabled',
    error: null
  }]));
  const lines = stripAnsi(output).split('\n');
  let activeFailedServer = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const matched = servers.find((server) => {
      const escaped = server.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`).test(line);
    });
    const status = statusFromLine(line);
    if (matched && status) {
      const entry = result.get(matched.name);
      entry.status = status;
      entry.error = status === 'failed' ? 'OpenCode reported an MCP connection failure' : null;
      activeFailedServer = status === 'failed' ? matched : null;
      continue;
    }
    if (activeFailedServer && !/^(?:[┌└●▲]|\d+\s+server)/.test(line)) {
      const detail = line.replace(/^│\s*/, '').trim();
      const commandLine = [activeFailedServer.command, ...(activeFailedServer.args ?? [])].filter(Boolean).join(' ');
      if (detail && detail !== commandLine && detail !== activeFailedServer.url) {
        result.get(activeFailedServer.name).error = sanitizeFailure(detail, activeFailedServer)
          || 'OpenCode reported an MCP connection failure';
      }
      activeFailedServer = null;
    }
  }
  return { servers: [...result.values()] };
}
