import { normalizeTokenUsage } from '../protocol.mjs';
import { claudeMcpCapabilities } from './mcp/claude.mjs';

export const claudeAdapterManifest = Object.freeze({
  id: 'claude-code',
  provider: 'anthropic',
  displayName: 'Claude Code',
  capabilities: {
    authentication: { methods: ['browser_oauth'], refresh: false },
    tasks: { streaming: 'ndjson', cancellation: true, profileInstructions: true, conversations: true },
    mcp: claudeMcpCapabilities,
    usage: { requestTokens: true, accountActivity: false, quotaWindows: false },
    workspace: { list: true }
  }
});

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
