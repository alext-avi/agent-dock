import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createControlMcp } from '../control-plane/control-mcp.mjs';
import { createDelegationService } from '../control-plane/delegation-service.mjs';

// The custom Responses endpoint below makes the real Codex CLI deterministic and
// keeps this boundary test entirely local: no OpenAI credentials or tokens are used.
const CODEX_BINARY = process.env.AGENT_DOCK_CODEX_BIN || 'codex';
const REQUIRE_CODEX = process.env.AGENT_DOCK_REQUIRE_CODEX_HEADLESS_TEST === '1';
const MODEL_TOKEN = 'local-model-test-token';
const MCP_TOKEN = 'local-mcp-test-token';
const TASK_INPUT = Object.freeze({
  targetAgentId: 'target',
  prompt: 'Perform deterministic test work',
  idempotencyKey: 'headless-delegation-test-001'
});

function codexAvailability() {
  const result = spawnSync(CODEX_BINARY, ['--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    if (REQUIRE_CODEX) {
      throw new Error(`Codex CLI is required for this test: ${result.error?.message ?? result.stderr}`);
    }
    return { skip: 'Codex CLI is not installed' };
  }
  const expected = process.env.AGENT_DOCK_EXPECT_CODEX_VERSION;
  if (expected && !result.stdout.includes(expected)) {
    throw new Error(`Expected Codex CLI ${expected}, received ${result.stdout.trim()}`);
  }
  return { skip: false };
}

const availability = codexAvailability();

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function allows(principal, permission) {
  return principal.roles?.includes('operator')
    && ['fleet:read', 'tasks:execute'].includes(permission);
}

async function createMcpHarness({ dropFirstSubmitResponse = false } = {}) {
  const principal = {
    id: 'oidc:codex-headless-test',
    type: 'user',
    agentId: null,
    roles: ['operator'],
    scopes: []
  };
  let dispatches = 0;
  let capturedTaskId = null;
  const authHeaders = [];
  const delegation = createDelegationService({
    agentExists: (id) => id === 'target',
    dispatch: async (task) => {
      dispatches += 1;
      return {
        status: 'succeeded',
        taskId: `worker-${task.id}`,
        output: 'deterministic result',
        usage: { totalTokens: 17 }
      };
    }
  });
  const delegationApi = {
    submit(input, caller, policy) {
      const task = delegation.submit(input, caller, policy);
      capturedTaskId = task.id;
      return task;
    },
    get: (...args) => delegation.get(...args),
    cancel: (...args) => delegation.cancel(...args)
  };

  let mcp;
  const upstream = createServer((req, res) => {
    authHeaders.push(req.headers.authorization ?? null);
    if (req.headers.authorization !== `Bearer ${MCP_TOKEN}`) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('unauthorized');
      return;
    }
    req.auth = { token: MCP_TOKEN, clientId: 'codex-test', scopes: [], extra: { principal } };
    void mcp.handle(req, res);
  });
  const upstreamOrigin = await listen(upstream);
  mcp = createControlMcp({
    publicOrigin: upstreamOrigin,
    delegation: delegationApi,
    allows,
    allowsMcpPrincipal: () => true,
    listAgents: () => [{
      id: 'target',
      name: 'Target',
      adapter: 'codex-cli',
      runtime: { state: 'running', managed: true, dedicated: true }
    }]
  });

  let droppedSubmitResponses = 0;
  let submitRequests = 0;
  const proxy = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      let isSubmit = false;
      try {
        const parsed = JSON.parse(body.toString('utf8'));
        isSubmit = parsed.method === 'tools/call' && parsed.params?.name === 'submit_agent_task';
      } catch { /* The upstream will report malformed JSON. */ }
      if (isSubmit) submitRequests += 1;

      const headers = { ...req.headers };
      delete headers.host;
      delete headers['content-length'];
      const response = await fetch(`${upstreamOrigin}${req.url}`, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body
      });
      const responseBody = Buffer.from(await response.arrayBuffer());
      if (dropFirstSubmitResponse && isSubmit && droppedSubmitResponses === 0) {
        droppedSubmitResponses += 1;
        res.destroy();
        return;
      }

      const responseHeaders = Object.fromEntries(response.headers);
      delete responseHeaders['content-encoding'];
      delete responseHeaders['content-length'];
      delete responseHeaders['transfer-encoding'];
      responseHeaders['content-length'] = String(responseBody.length);
      res.writeHead(response.status, responseHeaders);
      res.end(responseBody);
    } catch (error) {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(error?.message ?? String(error));
    }
  });
  const proxyOrigin = await listen(proxy);

  return {
    url: `${proxyOrigin}/mcp`,
    get dispatches() { return dispatches; },
    get taskId() { return capturedTaskId; },
    get submitRequests() { return submitRequests; },
    get droppedSubmitResponses() { return droppedSubmitResponses; },
    get authHeaders() { return authHeaders; },
    delegation,
    async close() {
      await closeServer(proxy);
      await closeServer(upstream);
      await mcp.close();
      await delegation.close();
    }
  };
}

function functionCall(sequence, name, argumentsValue) {
  return {
    id: `fc_${sequence}`,
    type: 'function_call',
    status: 'completed',
    namespace: 'mcp__agent_dock',
    name,
    arguments: JSON.stringify(argumentsValue),
    call_id: `call_${sequence}`
  };
}

function assistantMessage(sequence, text = 'DONE') {
  return {
    id: `msg_${sequence}`,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [], logprobs: [] }]
  };
}

function responseShape(id, output, status = 'completed') {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: 'agent-dock-mock',
    output,
    parallel_tool_calls: false,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: 1,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    truncation: 'disabled',
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 11
    }
  };
}

async function createModelHarness(responder) {
  const requests = [];
  let sequence = 0;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [] }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/responses') {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(request);
    sequence += 1;
    const item = responder({ request, sequence });
    const id = `resp_${sequence}`;
    const response = responseShape(id, [item]);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(`event: response.created\ndata: ${JSON.stringify({
      type: 'response.created',
      response: responseShape(id, [], 'in_progress'),
      sequence_number: 0
    })}\n\n`);
    res.write(`event: response.output_item.done\ndata: ${JSON.stringify({
      type: 'response.output_item.done', output_index: 0, item, sequence_number: 1
    })}\n\n`);
    res.write(`event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed', response, sequence_number: 2
    })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  const origin = await listen(server);
  return { url: `${origin}/v1`, requests, close: () => closeServer(server) };
}

async function runCodex({ modelUrl, mcpUrl, approveSubmit }) {
  const args = [
    'exec',
    '--ignore-user-config',
    '--strict-config',
    '--skip-git-repo-check',
    '--ephemeral',
    '--json',
    '--sandbox', 'read-only',
    '--disable', 'apps',
    '--disable', 'plugins',
    '-c', 'model="agent-dock-mock"',
    '-c', 'model_provider="agent_dock_mock"',
    '-c', 'model_context_window=200000',
    '-c', 'model_providers.agent_dock_mock.name="Agent Dock mock"',
    '-c', `model_providers.agent_dock_mock.base_url="${modelUrl}"`,
    '-c', 'model_providers.agent_dock_mock.env_key="AGENT_DOCK_TEST_MODEL_TOKEN"',
    '-c', 'model_providers.agent_dock_mock.wire_api="responses"',
    '-c', 'model_providers.agent_dock_mock.requires_openai_auth=false',
    '-c', 'model_providers.agent_dock_mock.supports_websockets=false',
    '-c', `mcp_servers.agent-dock.url="${mcpUrl}"`,
    '-c', 'mcp_servers.agent-dock.bearer_token_env_var="AGENT_DOCK_TEST_MCP_TOKEN"',
    '-c', 'mcp_servers.agent-dock.default_tools_approval_mode="writes"'
  ];
  if (approveSubmit) {
    args.push('-c', 'mcp_servers.agent-dock.tools.submit_agent_task.approval_mode="approve"');
  }
  args.push('Use only the Agent Dock MCP tools required by the deterministic test model, then finish.');

  const child = spawn(CODEX_BINARY, args, {
    env: {
      ...process.env,
      AGENT_DOCK_TEST_MODEL_TOKEN: MODEL_TOKEN,
      AGENT_DOCK_TEST_MCP_TOKEN: MCP_TOKEN
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code, signal] = await once(child, 'exit');
  assert.equal(signal, null, stderr);
  assert.equal(code, 0, stderr);
  const events = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { events, stdout, stderr };
}

test('Codex headless denies an MCP write tool without explicit preauthorization', {
  skip: availability.skip,
  timeout: 30_000
}, async (t) => {
  const mcp = await createMcpHarness();
  const model = await createModelHarness(({ sequence }) => sequence === 1
    ? functionCall(sequence, 'submit_agent_task', TASK_INPUT)
    : assistantMessage(sequence));
  t.after(async () => {
    await model.close();
    await mcp.close();
  });

  const result = await runCodex({ modelUrl: model.url, mcpUrl: mcp.url, approveSubmit: false });
  const submit = result.events.find((event) => event.item?.tool === 'submit_agent_task' && event.type === 'item.completed');
  assert.equal(submit?.item.status, 'failed');
  assert.match(submit?.item.error?.message ?? '', /cancelled MCP tool call/i);
  assert.equal(mcp.dispatches, 0);
  assert.ok(mcp.authHeaders.length > 0, 'Codex should authenticate while discovering MCP tools');
  assert.ok(mcp.authHeaders.every((header) => header === `Bearer ${MCP_TOKEN}`));
});

test('Codex headless can list, submit, recover from a lost response, and poll with scoped approval', {
  skip: availability.skip,
  timeout: 30_000
}, async (t) => {
  const mcp = await createMcpHarness({ dropFirstSubmitResponse: true });
  const model = await createModelHarness(({ sequence }) => {
    if (sequence === 1) return functionCall(sequence, 'list_agents', {});
    if (sequence === 2 || sequence === 3) return functionCall(sequence, 'submit_agent_task', TASK_INPUT);
    if (sequence === 4) {
      assert.ok(mcp.taskId, 'the accepted submission should expose a durable task id before polling');
      return functionCall(sequence, 'get_agent_task', { taskId: mcp.taskId });
    }
    return assistantMessage(sequence);
  });
  t.after(async () => {
    await model.close();
    await mcp.close();
  });

  const result = await runCodex({ modelUrl: model.url, mcpUrl: mcp.url, approveSubmit: true });
  await mcp.delegation.whenIdle();
  const calls = result.events
    .filter((event) => event.type === 'item.completed' && event.item?.type === 'mcp_tool_call')
    .map((event) => event.item);

  assert.equal(calls.find((call) => call.tool === 'list_agents')?.status, 'completed');
  assert.ok(calls.some((call) => call.tool === 'submit_agent_task' && call.status === 'completed'));
  assert.equal(calls.find((call) => call.tool === 'get_agent_task')?.status, 'completed');
  assert.equal(mcp.droppedSubmitResponses, 1);
  assert.ok(mcp.submitRequests >= 2, 'the submission must be retried after its first response is lost');
  assert.equal(mcp.dispatches, 1, 'the idempotency key must prevent duplicate worker dispatch');
  const namespace = model.requests[0]?.tools?.find((tool) => tool.name === 'mcp__agent_dock');
  assert.deepEqual(
    namespace?.tools?.map((tool) => tool.name).sort(),
    ['cancel_agent_task', 'get_agent_status', 'get_agent_task', 'list_agents', 'submit_agent_task']
  );
  assert.match(result.stdout, /"idempotentReplay":true/);
  assert.match(result.stdout, /"status":"succeeded"/);
  assert.ok(mcp.authHeaders.length > 0);
  assert.ok(mcp.authHeaders.every((header) => header === `Bearer ${MCP_TOKEN}`));
});
