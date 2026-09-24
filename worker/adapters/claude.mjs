import { normalizeTokenUsage } from '../protocol.mjs';
import { claudeMcpCapabilities } from './mcp/claude.mjs';

export const claudeAdapterManifest = Object.freeze({
  id: 'claude-code',
  provider: 'anthropic',
  displayName: 'Claude Code',
  capabilities: {
    authentication: {
      methods: ['browser_oauth'],
      refresh: false,
      // A manual, user-triggered probe distinct from `refresh`: it exercises
      // Claude Code's supported OAuth refresh path with one tiny `claude -p`
      // request rather than any endpoint this wrapper could call directly.
      sessionCheck: { supported: true, mayConsumeUsage: true }
    },
    tasks: { streaming: 'ndjson', cancellation: true, profileInstructions: true, conversations: true, runtimeLimits: true },
    // Which provider-neutral runtime limits Claude Code itself enforces. The
    // wall-clock bound, the idle bound, and graceful-then-forced process-tree
    // termination are wrapper supervision and are deliberately not listed: they
    // apply to every adapter. Anything absent here is reported unsupported
    // rather than configured and quietly ignored.
    runtimeLimits: {
      harnessControls: [
        'maxHarnessTurns',
        'childCommandTimeoutMs',
        'childCommandMaxTimeoutMs',
        'maxConcurrentSubagents',
        'maxSubagentDepth',
        'allowBackgroundTasks'
      ],
      // Claude Code announces its own tool use on the main stream, so subagent
      // and child-command starts and stops are observable. Work inside a
      // subagent is not forwarded there, so nesting below the first level is
      // bounded by the harness control but never reported as observed.
      observes: ['subagent', 'childCommand'],
      observedSubagentDepth: 1
    },
    mcp: claudeMcpCapabilities,
    usage: { requestTokens: true, accountActivity: false, quotaWindows: false },
    workspace: { list: true }
  }
});

// Claude Code's own names for the two things this policy bounds. They stay
// here, below the wrapper, like every other provider-shaped string.
const CLAUDE_SUBAGENT_TOOL = 'Task';
const CLAUDE_CHILD_COMMAND_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell']);

// Translates the effective provider-neutral policy into Claude Code's supported
// flags and environment. Only fields the manifest claims are read: a null means
// the control plane configured something this harness cannot enforce, and
// inventing a flag for it would be worse than reporting the gap.
export function claudeRuntimeLimitArgs(effective = {}) {
  const args = [];
  if (Number.isInteger(effective.maxHarnessTurns)) args.push('--max-turns', String(effective.maxHarnessTurns));
  return args;
}

export function claudeRuntimeLimitEnv(effective = {}) {
  const env = {};
  if (Number.isInteger(effective.childCommandTimeoutMs)) {
    env.BASH_DEFAULT_TIMEOUT_MS = String(effective.childCommandTimeoutMs);
  }
  if (Number.isInteger(effective.childCommandMaxTimeoutMs)) {
    env.BASH_MAX_TIMEOUT_MS = String(effective.childCommandMaxTimeoutMs);
  }
  if (Number.isInteger(effective.maxConcurrentSubagents)) {
    env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = String(effective.maxConcurrentSubagents);
  }
  if (Number.isInteger(effective.maxSubagentDepth)) {
    env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = String(effective.maxSubagentDepth);
  }
  if (effective.allowBackgroundTasks === false) env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  return env;
}

// Observable subagent and child-command lifecycle, returned as descriptors
// rather than finished events: a tool result names only the tool-use id it
// answers, so the caller correlates it with the start it already saw. Pure, and
// deliberately carrying no tool input — a command line or a delegated prompt is
// exactly what must not leave the worker on a lifecycle event.
export function observeClaudeLifecycle(event = {}) {
  const descriptors = [];
  if (event.type === 'assistant') {
    for (const block of event.message?.content ?? []) {
      if (block?.type !== 'tool_use') continue;
      const scope = block.name === CLAUDE_SUBAGENT_TOOL
        ? 'subagent'
        : CLAUDE_CHILD_COMMAND_TOOLS.has(block.name) ? 'child' : null;
      if (!scope) continue;
      descriptors.push({
        phase: 'started',
        scope,
        id: typeof block.id === 'string' ? block.id : null,
        // For a subagent this is the named agent type, never the delegated
        // prompt. For a child command it is the tool, never the command line.
        name: scope === 'subagent' && typeof block.input?.subagent_type === 'string'
          ? block.input.subagent_type
          : block.name ?? null
      });
    }
  }
  if (event.type === 'user') {
    for (const block of event.message?.content ?? []) {
      if (block?.type !== 'tool_result') continue;
      descriptors.push({
        phase: 'completed',
        id: typeof block.tool_use_id === 'string' ? block.tool_use_id : null,
        status: block.is_error === true ? 'failed' : 'succeeded'
      });
    }
  }
  return descriptors;
}

function contentText(content = []) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function claudeUsage(raw = {}) {
  const cachedInputTokens = Number(raw.cache_read_input_tokens ?? 0) + Number(raw.cache_creation_input_tokens ?? 0);
  return normalizeTokenUsage({
    input_tokens: Number(raw.input_tokens ?? 0) + cachedInputTokens,
    cached_input_tokens: cachedInputTokens,
    output_tokens: raw.output_tokens
  });
}

export function normalizeClaudeEvent(event = {}) {
  if (event.type === 'assistant') {
    const text = contentText(event.message?.content);
    if (text) return { type: 'message.completed', data: { role: 'assistant', text } };
    const tool = event.message?.content?.find((block) => block?.type === 'tool_use');
    if (tool) {
      return {
        type: 'activity.started',
        data: {
          kind: 'tool_use',
          name: tool.name ?? null,
          command: null,
          text: tool.input ? JSON.stringify(tool.input) : null
        }
      };
    }
  }

  if (event.type === 'user') {
    const toolResult = event.message?.content?.find((block) => block?.type === 'tool_result');
    if (toolResult) {
      return {
        type: 'activity.completed',
        data: {
          kind: 'tool_result',
          name: null,
          command: null,
          text: typeof toolResult.content === 'string' ? toolResult.content : null
        }
      };
    }
  }

  if (event.type === 'result') {
    return { type: 'usage.observed', data: { request: claudeUsage(event.usage) } };
  }

  if (event.type === 'system') {
    return { type: 'provider.lifecycle', data: { name: event.subtype ? `system.${event.subtype}` : 'system' } };
  }

  return { type: 'provider.event', data: { name: event.type || 'unknown' } };
}


// Claude Code is the one harness that accepts an id we choose, but it still
// announces the session it actually opened:
//   {"type":"system","subtype":"init","session_id":"b95e3a83-...","cwd":...}
// Observed from a real `claude -p --output-format stream-json` run. Recording it
// on announcement rather than before spawning matters: the id is only worth
// keeping once the harness has accepted it, and a conversation that recorded a
// session Claude never opened would report itself resumable and then fail every
// later turn with no way back.
export function observeClaudeSessionId(event = {}) {
  if (event.type !== 'system') return null;
  const id = event.session_id;
  return typeof id === 'string' && id ? id : null;
}
