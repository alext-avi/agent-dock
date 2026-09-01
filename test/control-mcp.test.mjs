import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createControlMcp, parseAgentMcpPolicies } from '../control-plane/control-mcp.mjs';
import { createDelegationService } from '../control-plane/delegation-service.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function rpcBody(text) {
  const data = text.split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(data ? data.slice(6) : text);
}

async function rpc(url, principal, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-06-18',
      'x-test-principal': Buffer.from(JSON.stringify(principal)).toString('base64url')
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return rpcBody(text);
}

async function modernRpc(url, principal, method, params = {}, name = null) {
  const headers = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': '2026-07-28',
    'mcp-method': method,
    'x-test-principal': Buffer.from(JSON.stringify(principal)).toString('base64url')
  };
  if (name) headers['mcp-name'] = name;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 100,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'agent-dock-test', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {}
        }
      }
    })
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return rpcBody(text);
}

test('agent MCP policies reject unknown tools and invalid limits', () => {
  assert.throws(() => parseAgentMcpPolicies('{'), /valid JSON/);
  assert.throws(() => parseAgentMcpPolicies({ caller: { tools: ['configure_mcp'] } }), /unsupported tool/);
  assert.throws(() => parseAgentMcpPolicies({ caller: { tools: [], maxDepth: 0 } }), /between 1 and 20/);
});

test('control-plane MCP exposes only policy-scoped delegation tools and targets', async (t) => {
  const delegation = createDelegationService({
    dispatch: async (task) => ({ status: 'succeeded', taskId: `worker-${task.id}`, output: `done:${task.prompt}` })
  });
  const mcp = createControlMcp({
    publicOrigin: 'http://127.0.0.1:3000',
    agentPolicies: {
      caller: {
        tools: ['list_agents', 'submit_agent_task', 'get_agent_task'],
        targetAgentIds: ['target'],
        maxDepth: 2,
        maxConcurrent: 1
      }
    },
    delegation,
    listAgents: () => [
      { id: 'target', name: 'Target', description: '', adapter: 'codex-cli', runtime: { state: 'running', managed: true, dedicated: true } },
      { id: 'hidden', name: 'Hidden', description: '', adapter: 'claude-code', runtime: { state: 'running', managed: true, dedicated: true } }
    ]
  });
  const server = createServer((req, res) => {
    const principal = JSON.parse(Buffer.from(req.headers['x-test-principal'], 'base64url').toString('utf8'));
    req.auth = { token: 'test', clientId: 'test', scopes: principal.scopes, extra: { principal } };
    void mcp.handle(req, res);
  });
  const base = await listen(server);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await mcp.close();
    await delegation.close();
  });
  const principal = {
    id: 'agent:caller',
    type: 'agent',
    agentId: 'caller',
    roles: [],
    scopes: ['fleet:read', 'tasks:execute']
  };

  const listed = await rpc(`${base}/mcp`, principal, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  assert.deepEqual(listed.result.tools.map((tool) => tool.name).sort(), ['get_agent_task', 'list_agents', 'submit_agent_task']);
  const modernListed = await modernRpc(`${base}/mcp`, principal, 'tools/list');
  assert.deepEqual(modernListed.result.tools.map((tool) => tool.name).sort(), ['get_agent_task', 'list_agents', 'submit_agent_task']);

  const visible = await rpc(`${base}/mcp`, principal, {
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_agents', arguments: {} }
  });
  assert.deepEqual(visible.result.structuredContent.agents.map((agent) => agent.id), ['target']);

  const denied = await rpc(`${base}/mcp`, principal, {
    jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      name: 'submit_agent_task', arguments: { targetAgentId: 'hidden', prompt: 'should fail' }
    }
  });
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /not allowed/);

  const submitted = await rpc(`${base}/mcp`, principal, {
    jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
      name: 'submit_agent_task', arguments: { targetAgentId: 'target', prompt: 'do work' }
    }
  });
  const taskId = submitted.result.structuredContent.task.id;
  await delegation.whenIdle();
  const completed = await rpc(`${base}/mcp`, principal, {
    jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_agent_task', arguments: { taskId } }
  });
  assert.equal(completed.result.structuredContent.task.status, 'succeeded');
  assert.equal(completed.result.structuredContent.task.output, 'done:do work');
});
