import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMcpWorkshopPrompt,
  createWorkshopRunState,
  extractMcpWorkshopProposal,
  mergeMcpQuickEdit,
  observeWorkshopRunEvent,
  requireSuccessfulWorkshopRun
} from '../control-plane/public/mcp-workshop.js';

test('workshop prompt preserves the operator objective and the approval boundary', () => {
  const prompt = buildMcpWorkshopPrompt('Investigate the official GitHub MCP server.');

  assert.match(prompt, /Investigate the official GitHub MCP server\./);
  assert.match(prompt, /do not call the Agent Dock control-plane API/i);
  assert.match(prompt, /do not .*include any credential value/i);
  assert.match(prompt, /<agent-dock-mcp-proposal>/);
  assert.throws(() => buildMcpWorkshopPrompt('   '), /Describe the connector/);
});

test('extracts a canonical HTTP proposal and drops literal secrets', () => {
  const result = extractMcpWorkshopProposal(`Research notes.
<agent-dock-mcp-proposal>
{
  "name": "github_tools",
  "transport": "http",
  "url": "https://example.test/mcp",
  "environment": { "LEAK": "literal-secret" },
  "headers": { "X-Token": "literal-secret" },
  "secretHeaders": {
    "Authorization": { "sourceEnv": "GITHUB_TOKEN", "prefix": "Bearer " }
  },
  "timeoutMs": 45000
}
</agent-dock-mcp-proposal>`);

  assert.deepEqual(result.proposal, {
    name: 'github_tools',
    transport: 'http',
    command: null,
    args: [],
    cwd: null,
    url: 'https://example.test/mcp',
    environment: {},
    secretEnvironment: {},
    headers: {},
    secretHeaders: {
      Authorization: { sourceEnv: 'GITHUB_TOKEN', prefix: 'Bearer ' }
    },
    timeoutMs: 45000
  });
  assert.deepEqual(result.warnings, [
    'Literal environment values were removed; use worker secret references.',
    'Literal header values were removed; use worker secret references.'
  ]);
  assert.doesNotMatch(JSON.stringify(result), /literal-secret/);
});

test('extracts a fenced stdio proposal and normalizes unsafe fields', () => {
  const result = extractMcpWorkshopProposal(`\`\`\`json
{
  "name": "local_tools",
  "transport": "stdio",
  "command": "node",
  "args": ["server.mjs", "--safe"],
  "cwd": "/workspace/connectors",
  "secretEnvironment": {
    "SERVICE_TOKEN": "WORKER_SERVICE_TOKEN",
    "bad-name": "NOT VALID"
  },
  "timeoutMs": 100
}
\`\`\``);

  assert.equal(result.proposal.transport, 'stdio');
  assert.equal(result.proposal.command, 'node');
  assert.deepEqual(result.proposal.args, ['server.mjs', '--safe']);
  assert.deepEqual(result.proposal.secretEnvironment, {
    SERVICE_TOKEN: { sourceEnv: 'WORKER_SERVICE_TOKEN' }
  });
  assert.equal(result.proposal.timeoutMs, 30000);
  assert.match(result.warnings.join(' '), /invalid secret environment/i);
});

test('rejects missing, malformed, and non-object proposals', () => {
  assert.throws(() => extractMcpWorkshopProposal('No payload here.'), /did not contain/);
  assert.throws(
    () => extractMcpWorkshopProposal('<agent-dock-mcp-proposal>{nope}</agent-dock-mcp-proposal>'),
    /not valid JSON/
  );
  assert.throws(
    () => extractMcpWorkshopProposal('<agent-dock-mcp-proposal>[]</agent-dock-mcp-proposal>'),
    /must be a JSON object/
  );
});

test('quick edits preserve canonical fields the compact editor does not represent', () => {
  const result = mergeMcpQuickEdit({
    transport: 'http',
    headers: { 'X-Tenant': 'acme' },
    secretHeaders: {
      Authorization: { sourceEnv: 'OLD_TOKEN', prefix: 'Bearer ' },
      'X-Api-Key': { sourceEnv: 'API_KEY', prefix: '' }
    }
  }, {
    name: 'remote_tools',
    transport: 'http',
    url: 'https://example.test/mcp',
    bearerEnv: 'NEW_TOKEN',
    timeoutMs: 45000
  });

  assert.deepEqual(result.headers, { 'X-Tenant': 'acme' });
  assert.deepEqual(result.secretHeaders, {
    'X-Api-Key': { sourceEnv: 'API_KEY', prefix: '' },
    Authorization: { sourceEnv: 'NEW_TOKEN', prefix: 'Bearer ' }
  });
});

test('quick stdio edits preserve cwd, literals, and additional secret mappings', () => {
  const result = mergeMcpQuickEdit({
    transport: 'stdio',
    cwd: '/workspace/connectors',
    environment: { LOG_LEVEL: 'warn' },
    secretEnvironment: {
      PRIMARY_TOKEN: { sourceEnv: 'OLD_PRIMARY' },
      SECONDARY_TOKEN: { sourceEnv: 'SECONDARY' }
    }
  }, {
    name: 'local_tools',
    transport: 'stdio',
    command: 'node',
    args: ['server.mjs'],
    secretTarget: 'PRIMARY_TOKEN',
    secretSource: 'NEW_PRIMARY',
    timeoutMs: 30000
  });

  assert.equal(result.cwd, '/workspace/connectors');
  assert.deepEqual(result.environment, { LOG_LEVEL: 'warn' });
  assert.deepEqual(result.secretEnvironment, {
    SECONDARY_TOKEN: { sourceEnv: 'SECONDARY' },
    PRIMARY_TOKEN: { sourceEnv: 'NEW_PRIMARY' }
  });
});

test('workshop accepts proposals only from a matching successful task', () => {
  const success = createWorkshopRunState();
  observeWorkshopRunEvent(success, { type: 'task.started', taskId: 'task-1' });
  observeWorkshopRunEvent(success, { type: 'task.completed', taskId: 'task-1', data: { status: 'succeeded' } });
  assert.doesNotThrow(() => requireSuccessfulWorkshopRun(success));

  for (const status of ['failed', 'cancelled']) {
    const state = createWorkshopRunState();
    observeWorkshopRunEvent(state, { type: 'task.started', taskId: 'task-1' });
    observeWorkshopRunEvent(state, { type: 'task.completed', taskId: 'task-1', data: { status } });
    assert.throws(() => requireSuccessfulWorkshopRun(state), new RegExp(status));
  }

  const mismatched = createWorkshopRunState();
  observeWorkshopRunEvent(mismatched, { type: 'task.started', taskId: 'task-1' });
  observeWorkshopRunEvent(mismatched, { type: 'task.completed', taskId: 'task-2', data: { status: 'succeeded' } });
  assert.throws(() => requireSuccessfulWorkshopRun(mismatched), /matching terminal event/);

  const errored = createWorkshopRunState();
  observeWorkshopRunEvent(errored, { type: 'task.started', taskId: 'task-1' });
  observeWorkshopRunEvent(errored, { type: 'error', taskId: 'task-1', data: { message: 'provider error' } });
  observeWorkshopRunEvent(errored, { type: 'task.completed', taskId: 'task-1', data: { status: 'succeeded' } });
  assert.throws(() => requireSuccessfulWorkshopRun(errored), /not accepted/);
});

// The prompt now tells a harness that credentials are not its business, because
// Agent Dock stores keys itself and the operator attaches one afterwards. The
// extraction must not depend on that instruction being followed.
test('a harness that ignores the instruction and returns a key cannot smuggle it into the form', () => {
  const { proposal, warnings } = extractMcpWorkshopProposal(`
    <agent-dock-mcp-proposal>
    {
      "name": "leaky",
      "transport": "http",
      "url": "https://leaky.example.test/mcp",
      "headers": { "Authorization": "Bearer sk-live-LEAKED" },
      "environment": { "TOKEN": "sk-live-ALSO-LEAKED" },
      "timeoutMs": 30000
    }
    </agent-dock-mcp-proposal>
  `);

  assert.deepEqual(proposal.headers, {});
  assert.deepEqual(proposal.environment, {});
  assert.doesNotMatch(JSON.stringify(proposal), /sk-live/);
  // And it says so, rather than discarding quietly.
  assert.ok(warnings.some((warning) => /header values were removed/i.test(warning)));
  assert.ok(warnings.some((warning) => /environment values were removed/i.test(warning)));
});

test('the prompt tells the harness that keys are not its to invent', () => {
  const prompt = buildMcpWorkshopPrompt('the GitHub MCP server');
  assert.match(prompt, /Agent Dock stores API keys itself/);
  assert.match(prompt, /leave secretHeaders and secretEnvironment empty/);
  assert.match(prompt, /the GitHub MCP server/);
});
