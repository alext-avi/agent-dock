import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OpenCodeMcpValidationError,
  openCodeAdapterManifest,
  openCodeMcpTaskEnvironment,
  parseOpenCodeMcpList,
  renderOpenCodeMcpConfig,
  validateOpenCodeMcpServers
} from '../worker/adapters/opencode.mjs';

const servers = [
  {
    name: 'local-tools',
    transport: 'stdio',
    command: 'node',
    args: ['/opt/mcp/server.mjs'],
    cwd: '/workspace',
    environment: { MCP_TOKEN: 'worker-only-secret' },
    timeoutMs: 12_000,
    enabled: true
  },
  {
    name: 'remote-tools',
    transport: 'http',
    url: 'https://mcp.example.test/mcp',
    headers: { Authorization: 'Bearer worker-only-secret' },
    enabled: true
  }
];

test('OpenCode exposes the common MCP management capabilities', () => {
  assert.deepEqual(openCodeAdapterManifest.capabilities.mcp.transports, ['stdio', 'http']);
  assert.equal(openCodeAdapterManifest.capabilities.mcp.dynamicApply, true);
  assert.equal(openCodeAdapterManifest.capabilities.mcp.restartRequired, false);
  assert.equal(openCodeAdapterManifest.capabilities.mcp.configDialect, 'opencode-v1');
});

test('OpenCode renders common stdio and HTTP servers without replacing provider config', () => {
  const config = renderOpenCodeMcpConfig(servers, {
    allowedCommands: ['node'],
    baseConfig: {
      $schema: 'https://opencode.ai/config.json',
      provider: { ollama: { name: 'Local Ollama', options: { baseURL: 'http://ollama:11434/v1' } } },
      model: 'ollama/qwen3'
    }
  });

  assert.equal(config.provider.ollama.name, 'Local Ollama');
  assert.equal(config.model, 'ollama/qwen3');
  assert.deepEqual(config.mcp['local-tools'], {
    type: 'local',
    command: ['node', '/opt/mcp/server.mjs'],
    enabled: true,
    cwd: '/workspace',
    environment: { MCP_TOKEN: 'worker-only-secret' },
    timeout: 12_000
  });
  assert.deepEqual(config.mcp['remote-tools'], {
    type: 'remote',
    url: 'https://mcp.example.test/mcp',
    enabled: true,
    headers: { Authorization: 'Bearer worker-only-secret' },
    oauth: false
  });
});

test('OpenCode MCP validation rejects dangerous or ambiguous configurations', () => {
  const validation = validateOpenCodeMcpServers([
    { name: 'Duplicate', transport: 'stdio', command: 'npx', args: ['malicious-package'] },
    { name: 'duplicate', transport: 'http', url: 'https://user:password@example.test/mcp' },
    { name: 'bad-url', transport: 'http', url: 'file:///tmp/server.sock' },
    { name: 'mixed', transport: 'stdio', command: 'node', url: 'https://example.test/mcp' }
  ], { allowedCommands: ['node'] });

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.code === 'command_not_allowed'));
  assert.ok(validation.errors.some((error) => error.code === 'duplicate_name'));
  assert.ok(validation.errors.some((error) => error.code === 'embedded_credentials'));
  assert.ok(validation.errors.some((error) => error.code === 'invalid_url'));
  assert.ok(validation.errors.some((error) => error.code === 'mixed_transport_fields'));
  assert.throws(
    () => renderOpenCodeMcpConfig([{ name: 'local', transport: 'stdio', command: 'node' }]),
    OpenCodeMcpValidationError
  );
});

test('OpenCode task environment keeps unrelated inline config and disables unmanaged MCPs', () => {
  const environment = openCodeMcpTaskEnvironment({
    HOME: '/opencode-home',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'ollama/qwen3', plugin: [] })
  }, servers, {
    allowedCommands: ['node'],
    disableServerNames: ['project.added', 'remote-tools']
  });
  const content = JSON.parse(environment.OPENCODE_CONFIG_CONTENT);

  assert.equal(environment.HOME, '/opencode-home');
  assert.equal(content.model, 'ollama/qwen3');
  assert.deepEqual(content.plugin, []);
  assert.deepEqual(content.mcp['project.added'], { enabled: false });
  assert.equal(content.mcp['remote-tools'].type, 'remote');
  assert.equal(content.mcp['remote-tools'].enabled, true);
});

test('OpenCode MCP inspection parses known status and redacts provider details', () => {
  const output = `
┌  MCP Servers
│
●  ✓ local-tools connected
│      node /opt/mcp/server.mjs
│
●  ✗ remote-tools failed
│      Authorization Bearer worker-only-secret failed at https://mcp.example.test/mcp
│
●  ✓ workspace-injected connected
│      /tmp/unmanaged-command
│
└  3 server(s)
`;
  const inspection = parseOpenCodeMcpList(output, servers);

  assert.deepEqual(inspection.servers.map(({ name, status }) => ({ name, status })), [
    { name: 'local-tools', status: 'connected' },
    { name: 'remote-tools', status: 'failed' }
  ]);
  const error = inspection.servers[1].error;
  assert.match(error, /\[redacted\]/);
  assert.match(error, /\[redacted-url\]/);
  assert.doesNotMatch(JSON.stringify(inspection), /worker-only-secret|mcp\.example\.test|workspace-injected|unmanaged-command/);
});
