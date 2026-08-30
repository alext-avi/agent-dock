import path from 'node:path';

const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const RESERVED_NAMES = new Set([
  'workspace',
  'claude-in-chrome',
  'computer-use',
  'claude preview',
  'claude browser'
]);
const SUPPORTED_TRANSPORTS = new Set(['stdio', 'http']);

export const claudeMcpCapabilities = Object.freeze({
  supported: true,
  management: true,
  transports: Object.freeze(['stdio', 'http']),
  configuration: 'managed-file',
  activation: 'next-task',
  healthObservation: 'task-startup',
  validate: true,
  apply: true,
  inspect: true,
  restartRequired: false,
  secretDelivery: 'worker-resolved-environment',
  localCommandPolicy: 'allowlist',
  stdioWorkingDirectory: 'workspace-only'
});

function issue(pathname, code, message) {
  return { path: pathname, code, message };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return value !== undefined && value !== null && value !== '';
}

function validateStringMap(value, pathname, keyPattern, errors) {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    errors.push(issue(pathname, 'invalid_type', `${pathname} must be an object of string values`));
    return;
  }
  for (const [key, candidate] of Object.entries(value)) {
    if (!keyPattern.test(key)) {
      errors.push(issue(`${pathname}.${key}`, 'invalid_name', `${pathname} contains an invalid key name`));
    }
    if (typeof candidate !== 'string') {
      errors.push(issue(`${pathname}.${key}`, 'invalid_type', `${pathname} values must be strings`));
    } else if (candidate !== candidate.trim()) {
      errors.push(issue(`${pathname}.${key}`, 'hidden_whitespace', `${pathname}.${key} has leading or trailing whitespace`));
    }
  }
}

function allowedCommandSet(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  return new Set();
}

/**
 * Validate already-resolved MCP server bindings without returning any credential
 * values. `environment` and `headers` may contain secrets, so diagnostics name
 * only their keys.
 */
export function validateClaudeMcpServers(servers, options = {}) {
  const errors = [];
  const warnings = [];
  const workspace = path.resolve(options.workspace ?? '/workspace');
  const allowedCommands = allowedCommandSet(options.allowedCommands);

  if (!Array.isArray(servers)) {
    return {
      valid: false,
      errors: [issue('servers', 'invalid_type', 'servers must be an array')],
      warnings
    };
  }

  const seenNames = new Set();
  servers.forEach((server, index) => {
    const base = `servers[${index}]`;
    if (!isPlainObject(server)) {
      errors.push(issue(base, 'invalid_type', `${base} must be an object`));
      return;
    }

    const name = typeof server.name === 'string' ? server.name : '';
    if (!name || name.length > 128 || !NAME_PATTERN.test(name)) {
      errors.push(issue(`${base}.name`, 'invalid_name', 'MCP server names must use only letters, numbers, hyphens, and underscores'));
    } else if (RESERVED_NAMES.has(name.toLowerCase())) {
      errors.push(issue(`${base}.name`, 'reserved_name', `${name} is reserved by Claude Code`));
    } else if (seenNames.has(name)) {
      errors.push(issue(`${base}.name`, 'duplicate_name', `MCP server name ${name} is duplicated`));
    } else {
      seenNames.add(name);
    }

    if (!SUPPORTED_TRANSPORTS.has(server.transport)) {
      errors.push(issue(`${base}.transport`, 'unsupported_transport', 'Claude Code MCP transport must be stdio or http'));
      return;
    }

    if (server.timeoutMs !== undefined && (!Number.isInteger(server.timeoutMs) || server.timeoutMs < 1_000 || server.timeoutMs > 3_600_000)) {
      errors.push(issue(`${base}.timeoutMs`, 'invalid_timeout', 'timeoutMs must be an integer between 1000 and 3600000'));
    }

    if (server.transport === 'stdio') {
      const command = typeof server.command === 'string' ? server.command : '';
      if (!command || command !== command.trim() || command.length > 4096) {
        errors.push(issue(`${base}.command`, 'invalid_command', 'stdio MCP servers require a non-empty command without leading or trailing whitespace'));
      } else if (allowedCommands && !allowedCommands.has(command)) {
        errors.push(issue(`${base}.command`, 'command_not_allowed', 'The requested MCP command is not allowed for this worker'));
      } else if (!allowedCommands && !path.isAbsolute(command)) {
        errors.push(issue(`${base}.command`, 'command_not_allowed', 'A relative command requires an explicit worker command allowlist'));
      }

      if (server.args !== undefined) {
        if (!Array.isArray(server.args) || server.args.length > 100) {
          errors.push(issue(`${base}.args`, 'invalid_args', 'args must be an array containing at most 100 strings'));
        } else {
          server.args.forEach((candidate, argumentIndex) => {
            if (typeof candidate !== 'string' || candidate.length > 4096 || candidate !== candidate.trim()) {
              errors.push(issue(`${base}.args[${argumentIndex}]`, 'invalid_argument', 'Each argument must be a string without leading or trailing whitespace'));
            }
          });
        }
      }

      if (server.cwd !== undefined) {
        if (typeof server.cwd !== 'string' || !path.isAbsolute(server.cwd) || path.resolve(server.cwd) !== workspace) {
          errors.push(issue(`${base}.cwd`, 'unsupported_working_directory', `Claude Code stdio MCP servers managed by Agent Dock run from ${workspace}`));
        }
      }
      validateStringMap(server.environment, `${base}.environment`, ENVIRONMENT_NAME_PATTERN, errors);
      if (hasValue(server.url)) errors.push(issue(`${base}.url`, 'field_conflict', 'stdio MCP servers cannot define a URL'));
      if (hasValue(server.headers)) errors.push(issue(`${base}.headers`, 'field_conflict', 'stdio MCP servers cannot define HTTP headers'));
      return;
    }

    if (typeof server.url !== 'string' || !server.url || server.url !== server.url.trim()) {
      errors.push(issue(`${base}.url`, 'invalid_url', 'HTTP MCP servers require a URL without leading or trailing whitespace'));
    } else {
      try {
        const url = new URL(server.url);
        if (!['http:', 'https:'].includes(url.protocol)) {
          errors.push(issue(`${base}.url`, 'invalid_url', 'HTTP MCP server URLs must use http or https'));
        }
        if (url.username || url.password) {
          errors.push(issue(`${base}.url`, 'embedded_credential', 'HTTP MCP server URLs cannot contain embedded credentials'));
        }
        if (url.hash) errors.push(issue(`${base}.url`, 'invalid_url', 'HTTP MCP server URLs cannot contain fragments'));
        const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
        if (url.protocol === 'http:' && !local) {
          warnings.push(issue(`${base}.url`, 'insecure_transport', 'Use HTTPS for remote MCP servers whenever possible'));
        }
      } catch {
        errors.push(issue(`${base}.url`, 'invalid_url', 'HTTP MCP server URL is invalid'));
      }
    }
    validateStringMap(server.headers, `${base}.headers`, HEADER_NAME_PATTERN, errors);
    if (hasValue(server.command)) errors.push(issue(`${base}.command`, 'field_conflict', 'HTTP MCP servers cannot define a command'));
    if (hasValue(server.args)) errors.push(issue(`${base}.args`, 'field_conflict', 'HTTP MCP servers cannot define command arguments'));
    if (hasValue(server.cwd)) errors.push(issue(`${base}.cwd`, 'field_conflict', 'HTTP MCP servers cannot define a working directory'));
    if (hasValue(server.environment)) errors.push(issue(`${base}.environment`, 'field_conflict', 'HTTP MCP servers cannot define a process environment'));
  });

  return { valid: errors.length === 0, errors, warnings };
}

function invalidConfiguration(errors) {
  const error = new Error('Claude Code MCP configuration is invalid');
  error.code = 'INVALID_MCP_CONFIGURATION';
  error.status = 400;
  error.details = errors;
  return error;
}

/** Render the provider-neutral DTO into Claude Code's `--mcp-config` shape. */
export function renderClaudeMcpConfig(servers, options = {}) {
  const validation = validateClaudeMcpServers(servers, options);
  if (!validation.valid) throw invalidConfiguration(validation.errors);

  const mcpServers = {};
  for (const server of servers) {
    if (server.transport === 'stdio') {
      mcpServers[server.name] = {
        type: 'stdio',
        command: server.command,
        ...(server.args?.length ? { args: [...server.args] } : {}),
        ...(server.environment && Object.keys(server.environment).length ? { env: { ...server.environment } } : {}),
        ...(server.timeoutMs !== undefined ? { timeout: server.timeoutMs } : {})
      };
      continue;
    }
    mcpServers[server.name] = {
      type: 'http',
      url: server.url,
      ...(server.headers && Object.keys(server.headers).length ? { headers: { ...server.headers } } : {}),
      ...(server.timeoutMs !== undefined ? { timeout: server.timeoutMs } : {})
    };
  }
  return { mcpServers };
}

/** CLI arguments that make the worker-owned file the exclusive MCP source. */
export function claudeMcpTaskArguments(configPath) {
  if (typeof configPath !== 'string' || !path.isAbsolute(configPath) || configPath.includes('\0')) {
    throw new TypeError('Claude Code MCP config path must be an absolute path');
  }
  return ['--mcp-config', configPath, '--strict-mcp-config'];
}

function normalizedHealth(status) {
  const value = String(status ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (['connected', 'ready', 'healthy'].includes(value)) return 'healthy';
  if (['pending', 'connecting', 'cached'].includes(value)) return 'pending';
  if (['needsauthentication', 'authenticationrequired', 'unauthorized'].includes(value)) return 'needs_authentication';
  if (['failed', 'error', 'disconnected', 'unhealthy'].includes(value)) return 'unhealthy';
  return 'unknown';
}

function safeClaudeErrorMessage(type) {
  switch (type) {
    case 'unknown_type': return 'Claude Code does not support this MCP server transport.';
    case 'url_missing_type': return 'The MCP server URL is missing an explicit transport type.';
    case 'reserved_name': return 'The MCP server name is reserved by Claude Code.';
    case 'invalid_config': return 'Claude Code rejected this MCP server configuration.';
    default: return 'Claude Code skipped this MCP server during startup.';
  }
}

/**
 * Convert Claude Code's `system/init` MCP fields into a safe cached health
 * observation. Raw provider messages are intentionally not returned because
 * they can contain resolved connection details.
 */
export function observeClaudeMcpInit(event, options = {}) {
  if (event?.type !== 'system' || event?.subtype !== 'init') return null;
  const servers = Array.isArray(event.mcp_servers) ? event.mcp_servers : [];
  const errors = Array.isArray(event.mcp_server_errors) ? event.mcp_server_errors : [];
  return {
    observedAt: options.observedAt ?? new Date().toISOString(),
    servers: servers
      .filter((server) => isPlainObject(server) && typeof server.name === 'string')
      .map((server) => ({
        name: server.name,
        status: typeof server.status === 'string' ? server.status : 'unknown',
        health: normalizedHealth(server.status)
      })),
    errors: errors
      .filter((error) => isPlainObject(error))
      .map((error) => ({
        name: typeof error.name === 'string' ? error.name : null,
        type: typeof error.type === 'string' ? error.type : 'unknown',
        message: safeClaudeErrorMessage(error.type)
      }))
  };
}
