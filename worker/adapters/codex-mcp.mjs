const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const codexMcpCapabilities = Object.freeze({
  supported: true,
  management: true,
  transports: Object.freeze(['stdio', 'http']),
  validate: true,
  apply: true,
  inspect: true,
  configuration: 'provider-native-cli',
  activation: 'next-task',
  restartRequired: false,
  healthObservation: 'provider-inspection',
  secretDelivery: 'worker-resolved-environment',
  // Advertised so the control plane can refuse to send a credentialId
  // definition to a worker that would apply it with no header at all.
  credentialDelivery: true,
  localCommandPolicy: 'allowlist'
});

function issue(index, server, field, code, message) {
  return { index, name: typeof server?.name === 'string' ? server.name : null, field, code, message };
}

function validateMap(value, index, server, field, errors, keyPattern = null) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(issue(index, server, field, 'invalid_type', `${field} must be an object`));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (keyPattern && !keyPattern.test(key)) errors.push(issue(index, server, `${field}.${key}`, 'invalid_name', `${field} contains an invalid name`));
    if (typeof entry !== 'string' || /\0|[\r\n]/.test(entry)) errors.push(issue(index, server, `${field}.${key}`, 'invalid_value', `${field} values must be single-line strings`));
  }
}

export function validateCodexMcpServers(servers, options = {}) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(servers)) return { valid: false, errors: [issue(-1, null, 'servers', 'invalid_type', 'servers must be an array')], warnings };
  const names = new Set();
  const commands = options.allowedCommands instanceof Set ? options.allowedCommands : new Set(options.allowedCommands ?? []);
  for (const [index, server] of servers.entries()) {
    if (!server || typeof server !== 'object' || Array.isArray(server)) {
      errors.push(issue(index, server, '', 'invalid_type', 'Each MCP server must be an object'));
      continue;
    }
    if (typeof server.name !== 'string' || !SERVER_NAME.test(server.name)) errors.push(issue(index, server, 'name', 'invalid_name', 'MCP server name is invalid'));
    const key = String(server.name ?? '').toLowerCase();
    if (names.has(key)) errors.push(issue(index, server, 'name', 'duplicate_name', `MCP server name ${server.name} is duplicated`));
    names.add(key);
    if (!['stdio', 'http'].includes(server.transport)) {
      errors.push(issue(index, server, 'transport', 'unsupported_transport', 'Codex MCP transport must be stdio or http'));
      continue;
    }
    if (!Number.isInteger(server.timeoutMs) || server.timeoutMs < 1_000 || server.timeoutMs > 300_000) {
      errors.push(issue(index, server, 'timeoutMs', 'invalid_timeout', 'timeoutMs must be between 1000 and 300000'));
    }
    if (server.transport === 'stdio') {
      if (typeof server.command !== 'string' || !server.command || /\0|[\r\n]/.test(server.command)) {
        errors.push(issue(index, server, 'command', 'invalid_command', 'stdio MCP servers require a valid command'));
      } else if (!commands.has(server.command)) {
        errors.push(issue(index, server, 'command', 'command_not_allowed', `Command ${server.command} is not allowed by this worker`));
      }
      if (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== 'string' || /\0|[\r\n]/.test(arg))) {
        errors.push(issue(index, server, 'args', 'invalid_arguments', 'args must be an array of single-line strings'));
      }
      validateMap(server.environment, index, server, 'environment', errors, ENV_NAME);
      if (server.url || Object.keys(server.headers ?? {}).length) errors.push(issue(index, server, 'transport', 'mixed_transport_fields', 'stdio servers cannot include HTTP fields'));
    } else {
      try {
        const url = new URL(server.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid');
      } catch {
        errors.push(issue(index, server, 'url', 'invalid_url', 'HTTP MCP servers require an absolute HTTP(S) URL without embedded credentials'));
      }
      if (server.command || (server.args?.length ?? 0) || server.cwd || Object.keys(server.environment ?? {}).length) {
        errors.push(issue(index, server, 'transport', 'mixed_transport_fields', 'HTTP servers cannot include stdio fields'));
      }
      const headers = Object.keys(server.headers ?? {});
      const secretHeaders = Object.keys(server.secretHeaders ?? {});
      const resolvedBearer = headers.length === 1 && headers[0].toLowerCase() === 'authorization' && secretHeaders.some((header) => header.toLowerCase() === 'authorization');
      if (headers.length && !resolvedBearer) errors.push(issue(index, server, 'headers', 'unsupported_field', 'Codex managed HTTP servers do not yet support literal headers'));
      for (const header of secretHeaders) {
        const value = server.secretHeaders[header];
        if (header.toLowerCase() !== 'authorization' || value.prefix !== 'Bearer ' || !ENV_NAME.test(value.sourceEnv ?? '')) {
          errors.push(issue(index, server, `secretHeaders.${header}`, 'unsupported_auth', 'Codex supports a worker environment reference for an Authorization Bearer header'));
        }
      }
      if (secretHeaders.length > 1) errors.push(issue(index, server, 'secretHeaders', 'unsupported_field', 'Codex supports one managed bearer credential'));
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}

export class CodexMcpValidationError extends Error {
  constructor(validation) {
    super(validation.errors.map((error) => error.message).join('; ') || 'Invalid Codex MCP configuration');
    this.name = 'CodexMcpValidationError';
    this.status = 400;
    this.validation = validation;
  }
}

function addArguments(server) {
  if (server.transport === 'http') {
    const args = ['mcp', 'add', server.name, '--url', server.url];
    const bearer = Object.entries(server.secretHeaders ?? {}).find(([header, value]) => header.toLowerCase() === 'authorization' && value.prefix === 'Bearer ');
    if (bearer) args.push('--bearer-token-env-var', bearer[1].sourceEnv);
    return args;
  }
  const args = ['mcp', 'add', server.name];
  for (const [name, value] of Object.entries(server.environment ?? {})) args.push('--env', `${name}=${value}`);
  args.push('--', server.command, ...(server.args ?? []));
  return args;
}

/** Reconcile only Agent Dock-managed names through the provider's native CLI. */
export async function applyCodexMcpServers(servers, options = {}) {
  const validation = validateCodexMcpServers(servers, options);
  if (!validation.valid) throw new CodexMcpValidationError(validation);
  if (options.demoMode) return { changed: true, provider: 'codex', warnings: validation.warnings };
  if (typeof options.run !== 'function') throw new TypeError('Codex MCP apply requires a run(command,args) function');
  const previous = Array.isArray(options.previousServers) ? options.previousServers : [];
  const names = new Set([...previous, ...servers].map((server) => server.name));
  for (const name of names) await options.run('codex', ['mcp', 'remove', name], { env: options.env });
  for (const server of servers) {
    const result = await options.run('codex', addArguments(server), { env: options.env, timeout: 30_000 });
    if (result.code !== 0) {
      let rollbackFailed = false;
      for (const name of names) {
        await options.run('codex', ['mcp', 'remove', name], { env: options.env }).catch(() => { rollbackFailed = true; });
      }
      for (const previousServer of previous) {
        const restored = await options.run('codex', addArguments(previousServer), { env: options.env, timeout: 30_000 }).catch(() => ({ code: -1 }));
        if (restored.code !== 0) rollbackFailed = true;
      }
      const error = new Error(rollbackFailed
        ? `Codex rejected MCP server ${server.name} and the previous configuration could not be fully restored`
        : `Codex rejected MCP server ${server.name}; the previous configuration was restored`);
      error.status = 502;
      error.code = rollbackFailed ? 'CODEX_MCP_APPLY_AND_ROLLBACK_FAILED' : 'CODEX_MCP_APPLY_FAILED';
      throw error;
    }
  }
  return { changed: true, provider: 'codex', warnings: validation.warnings };
}
