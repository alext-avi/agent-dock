import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  claudeMcpCapabilities,
  claudeMcpTaskArguments,
  observeClaudeMcpInit,
  renderClaudeMcpConfig,
  validateClaudeMcpServers
} from '../worker/adapters/mcp/claude.mjs';
import { claudeAdapterManifest } from '../worker/adapters/claude.mjs';

const WORKSPACE = '/workspace';

test('Claude adapter advertises the common MCP v1 capability', () => {
  assert.equal(claudeAdapterManifest.capabilities.mcp, claudeMcpCapabilities);
  assert.deepEqual(claudeMcpCapabilities.transports, ['stdio', 'http']);
  assert.equal(claudeMcpCapabilities.activation, 'next-task');
});

test('Claude renderer maps stdio and HTTP definitions to a strict config file', () => {
  const rendered = renderClaudeMcpConfig([
    {
      name: 'local_tools',
      transport: 'stdio',
      command: 'node',
      args: ['/opt/mcp/server.mjs'],
      cwd: WORKSPACE,
      environment: { SERVICE_TOKEN: 'test-only-value' },
      timeoutMs: 30_000
    },
    {
      name: 'remote-tools',
      transport: 'http',
      url: 'https://mcp.example.test/mcp',
      headers: { Authorization: 'Bearer test-only-value' }
    }
  ], { workspace: WORKSPACE, allowedCommands: ['node'] });

  assert.deepEqual(rendered, {
    mcpServers: {
      local_tools: {
        type: 'stdio',
        command: 'node',
        args: ['/opt/mcp/server.mjs'],
        env: { SERVICE_TOKEN: 'test-only-value' },
        timeout: 30_000
      },
      'remote-tools': {
        type: 'http',
        url: 'https://mcp.example.test/mcp',
        headers: { Authorization: 'Bearer test-only-value' }
      }
    }
  });
  assert.deepEqual(claudeMcpTaskArguments('/agent-data/mcp/claude.json'), [
    '--mcp-config',
    '/agent-data/mcp/claude.json',
    '--strict-mcp-config'
  ]);
});

test('Claude validation rejects unsafe or transport-conflicting definitions without leaking values', () => {
  const secret = 'TOP_SECRET_VALUE_SENTINEL';
  const result = validateClaudeMcpServers([
    {
      name: 'workspace',
      transport: 'stdio',
      command: 'npx',
      cwd: '/outside-workspace',
      environment: { API_TOKEN: ` ${secret}` },
      url: `https://${secret}.example.test/mcp`
    },
    {
      name: 'workspace',
      transport: 'http',
      url: `https://user:${secret}@mcp.example.test/mcp#fragment`,
      headers: { Authorization: `Bearer ${secret} ` },
      command: '/bin/false'
    }
  ], { workspace: WORKSPACE, allowedCommands: ['/usr/local/bin/mcp-safe'] });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === 'reserved_name'));
  assert.ok(result.errors.some((error) => error.code === 'command_not_allowed'));
  assert.ok(result.errors.some((error) => error.code === 'unsupported_working_directory'));
  assert.ok(result.errors.some((error) => error.code === 'embedded_credential'));
  assert.ok(result.errors.some((error) => error.code === 'hidden_whitespace'));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));

  assert.throws(
    () => renderClaudeMcpConfig([
      { name: 'bad name', transport: 'stdio', command: `/bin/${secret}` }
    ], { workspace: WORKSPACE, allowedCommands: [] }),
    (error) => error.code === 'INVALID_MCP_CONFIGURATION'
      && error.status === 400
      && !JSON.stringify(error.details).includes(secret)
  );
});

test('Claude validation permits localhost HTTP but warns on cleartext remote HTTP', () => {
  const result = validateClaudeMcpServers([
    { name: 'local_http', transport: 'http', url: 'http://127.0.0.1:9000/mcp' },
    { name: 'remote_http', transport: 'http', url: 'http://mcp.example.test/mcp' }
  ]);
  assert.equal(result.valid, true);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, 'insecure_transport');
});

test('Claude system init observation normalizes health and redacts provider diagnostics', () => {
  const secret = 'TOP_SECRET_VALUE_SENTINEL';
  const observation = observeClaudeMcpInit({
    type: 'system',
    subtype: 'init',
    mcp_servers: [
      { name: 'docs', status: 'connected' },
      { name: 'tickets', status: 'needs authentication' }
    ],
    mcp_server_errors: [
      { name: 'broken', type: 'invalid_config', message: `Bad token ${secret}` },
      { name: 'future', type: 'future_error', message: `Private URL https://${secret}.example.test` }
    ]
  }, { observedAt: '2026-08-29T12:00:00.000Z' });

  assert.deepEqual(observation, {
    observedAt: '2026-08-29T12:00:00.000Z',
    servers: [
      { name: 'docs', status: 'connected', health: 'healthy' },
      { name: 'tickets', status: 'needs authentication', health: 'needs_authentication' }
    ],
    errors: [
      { name: 'broken', type: 'invalid_config', message: 'Claude Code rejected this MCP server configuration.' },
      { name: 'future', type: 'future_error', message: 'Claude Code skipped this MCP server during startup.' }
    ]
  });
  assert.doesNotMatch(JSON.stringify(observation), new RegExp(secret));
  assert.equal(observeClaudeMcpInit({ type: 'assistant' }), null);
});
