import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';

const READ_TOOLS = new Set(['list_agents', 'get_agent_status']);
const TASK_TOOLS = new Set(['submit_agent_task', 'get_agent_task', 'cancel_agent_task']);
const ALL_TOOLS = new Set([...READ_TOOLS, ...TASK_TOOLS]);

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function stringList(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

export function parseAgentMcpPolicies(value = '{}') {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value || '{}'); }
    catch { throw new Error('MCP_AGENT_POLICIES_JSON must be valid JSON'); }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MCP_AGENT_POLICIES_JSON must be an object keyed by agent id');
  }
  const policies = new Map();
  for (const [agentId, raw] of Object.entries(parsed)) {
    if (!agentId || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`MCP policy for ${agentId || '<empty>'} must be an object`);
    }
    const tools = stringList(raw.tools, `MCP policy ${agentId}.tools`);
    const unsupported = tools.find((tool) => !ALL_TOOLS.has(tool));
    if (unsupported) throw new Error(`MCP policy ${agentId} names unsupported tool ${unsupported}`);
    const targetAgentIds = stringList(raw.targetAgentIds, `MCP policy ${agentId}.targetAgentIds`);
    const maxDepth = raw.maxDepth === undefined ? undefined : Number(raw.maxDepth);
    const maxConcurrent = raw.maxConcurrent === undefined ? undefined : Number(raw.maxConcurrent);
    if (maxDepth !== undefined && (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 20)) {
      throw new Error(`MCP policy ${agentId}.maxDepth must be between 1 and 20`);
    }
    if (maxConcurrent !== undefined && (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 100)) {
      throw new Error(`MCP policy ${agentId}.maxConcurrent must be between 1 and 100`);
    }
    policies.set(agentId, {
      tools: new Set(tools),
      targetAgentIds: new Set(targetAgentIds),
      ...(maxDepth === undefined ? {} : { maxDepth }),
      ...(maxConcurrent === undefined ? {} : { maxConcurrent })
    });
  }
  return policies;
}

function hasPermission(principal, permission) {
  if (principal?.scopes?.includes('*') || principal?.scopes?.includes(permission)) return true;
  if (principal?.roles?.includes('admin')) return true;
  if (permission === 'fleet:read') return principal?.roles?.some((role) => ['viewer', 'operator'].includes(role)) ?? false;
  if (permission === 'tasks:execute') return principal?.roles?.includes('operator') ?? false;
  return false;
}

function callerFor(principal) {
  return {
    id: principal.id,
    type: principal.type,
    agentId: principal.agentId ?? null,
    isAdmin: principal.roles?.includes('admin') ?? false
  };
}

function safeAgent(agent) {
  return {
    id: agent.id,
    name: agent.name,
    adapter: agent.adapter,
    runtime: {
      state: agent.runtime?.state ?? 'unknown',
      managed: agent.runtime?.managed ?? false,
      dedicated: agent.runtime?.dedicated ?? false
    }
  };
}

function toolResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value
  };
}

function toolError(error) {
  return {
    isError: true,
    content: [{ type: 'text', text: error?.message ?? String(error) }]
  };
}

function guarded(callback) {
  return async (...args) => {
    try { return await callback(...args); }
    catch (error) { return toolError(error); }
  };
}

function allowedTargets(principal, policy) {
  if (principal.type !== 'agent') return null;
  return policy?.targetAgentIds ?? new Set();
}

function targetAllowed(principal, policy, targetAgentId) {
  const targets = allowedTargets(principal, policy);
  return targets === null || targets.has('*') || targets.has(targetAgentId);
}

function canExposeTool(principal, policy, tool) {
  const permission = READ_TOOLS.has(tool) ? 'fleet:read' : 'tasks:execute';
  if (!hasPermission(principal, permission)) return false;
  return principal.type !== 'agent' || policy?.tools.has(tool) === true;
}

export function createControlMcp(options = {}) {
  const listAgents = options.listAgents ?? (() => []);
  const getAgentStatus = options.getAgentStatus ?? (async () => { throw httpError('Agent status is unavailable', 503); });
  const delegation = options.delegation;
  if (!delegation) throw new Error('Control-plane MCP requires a delegation service');
  const policies = options.agentPolicies instanceof Map
    ? options.agentPolicies
    : parseAgentMcpPolicies(options.agentPolicies ?? process.env.MCP_AGENT_POLICIES_JSON ?? '{}');
  const publicOrigin = new URL(options.publicOrigin ?? 'http://127.0.0.1:3000');
  const allowedHostnames = [...new Set([
    publicOrigin.hostname,
    ...(options.allowedHostnames ?? [])
  ])];
  const validateHost = hostHeaderValidation(allowedHostnames);
  const validateOrigin = originValidation(allowedHostnames);

  function buildServer(principal) {
    if (!principal?.id) throw httpError('Authenticated MCP principal is required', 401);
    const policy = principal.type === 'agent' ? policies.get(principal.agentId) : null;
    const caller = callerFor(principal);
    const server = new McpServer({ name: 'agent-dock-control-plane', version: '0.1.0' });

    if (canExposeTool(principal, policy, 'list_agents')) {
      server.registerTool('list_agents', {
        title: 'List agents',
        description: 'List agents visible as delegation targets. Does not expose credentials, MCP configuration, runtime controls, or storage.',
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true }
      }, guarded(async () => {
        const agents = (await listAgents()).filter((agent) => targetAllowed(principal, policy, agent.id)).map(safeAgent);
        return toolResult({ agents });
      }));
    }

    if (canExposeTool(principal, policy, 'get_agent_status')) {
      server.registerTool('get_agent_status', {
        title: 'Get agent status',
        description: 'Read the current operational status of an allowed agent.',
        inputSchema: z.object({ agentId: z.string().min(1).max(200) }),
        annotations: { readOnlyHint: true }
      }, guarded(async ({ agentId }) => {
        if (!targetAllowed(principal, policy, agentId)) throw httpError('Target agent is not allowed by caller policy', 403);
        return toolResult({ agentId, status: await getAgentStatus(agentId) });
      }));
    }

    if (canExposeTool(principal, policy, 'submit_agent_task')) {
      server.registerTool('submit_agent_task', {
        title: 'Submit agent task',
        description: 'Queue autonomous work on an allowed agent and return a durable task handle immediately.',
        inputSchema: z.object({
          targetAgentId: z.string().min(1).max(200),
          prompt: z.string().min(1).max(50_000),
          parentTaskId: z.string().min(1).max(200).optional()
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
      }, guarded(async (input) => {
        if (!targetAllowed(principal, policy, input.targetAgentId)) throw httpError('Target agent is not allowed by caller policy', 403);
        return toolResult({ task: delegation.submit(input, caller, policy ?? {}) });
      }));
    }

    if (canExposeTool(principal, policy, 'get_agent_task')) {
      server.registerTool('get_agent_task', {
        title: 'Get delegated task',
        description: 'Read a delegated task result by its durable handle.',
        inputSchema: z.object({ taskId: z.string().min(1).max(200) }),
        annotations: { readOnlyHint: true }
      }, guarded(async ({ taskId }) => toolResult({ task: delegation.get(taskId, caller) })));
    }

    if (canExposeTool(principal, policy, 'cancel_agent_task')) {
      server.registerTool('cancel_agent_task', {
        title: 'Cancel delegated task',
        description: 'Request cancellation of a delegated task owned by the caller.',
        inputSchema: z.object({ taskId: z.string().min(1).max(200) }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
      }, guarded(async ({ taskId }) => toolResult({ task: await delegation.cancel(taskId, caller) })));
    }

    return server;
  }

  const handler = createMcpHandler(({ authInfo }) => buildServer(authInfo?.extra?.principal), {
    legacy: 'stateless',
    onerror: options.onerror
  });
  const nodeHandler = toNodeHandler(handler, { onerror: options.onerror });

  return {
    policies,
    validate: (req, res) => validateHost(req, res) && validateOrigin(req, res),
    handle: async (req, res, { validated = false } = {}) => {
      if (!validated && (!validateHost(req, res) || !validateOrigin(req, res))) return;
      await nodeHandler(req, res);
    },
    close: () => handler.close()
  };
}

export const controlMcpTools = Object.freeze([...ALL_TOOLS]);
