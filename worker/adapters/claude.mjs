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


// Claude Code is the one harness that accepts an id we choose, so there is
// nothing to observe: the worker supplies --session-id on the first turn and
// --resume afterwards. Kept as a function so every adapter answers the same
// question, and so a future Claude release that renames the field has one place
// to change.
export function observeClaudeSessionId() {
  return null;
}
