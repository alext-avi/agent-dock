import { normalizeTokenUsage } from '../protocol.mjs';
import { codexMcpCapabilities } from './codex-mcp.mjs';

export const codexAdapterManifest = Object.freeze({
  id: 'codex-cli',
  provider: 'openai',
  displayName: 'Codex',
  capabilities: {
    authentication: { methods: ['device_code'], refresh: true },
    tasks: { streaming: 'ndjson', cancellation: true, profileInstructions: true },
    mcp: codexMcpCapabilities,
    usage: { requestTokens: true, accountActivity: true, quotaWindows: true },
    workspace: { list: true }
  }
});

function textFrom(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return null;
  try { return JSON.stringify(value); }
  catch { return String(value); }
}

export function normalizeCodexEvent(event = {}) {
  if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
    return { type: 'message.completed', data: { role: 'assistant', text: textFrom(event.item.text) ?? '' } };
  }

  if (event.type === 'item.started' || event.type === 'item.completed') {
    const item = event.item ?? {};
    return {
      type: event.type === 'item.started' ? 'activity.started' : 'activity.completed',
      data: {
        kind: item.type ?? 'provider_activity',
        name: item.name ?? null,
        command: textFrom(item.command),
        text: textFrom(item.text)
      }
    };
  }

  if (event.type === 'turn.completed' && event.usage) {
    return { type: 'usage.observed', data: { request: normalizeTokenUsage(event.usage) } };
  }

  if (event.type === 'turn.started' || event.type === 'thread.started') {
    return { type: 'provider.lifecycle', data: { name: event.type } };
  }

  return { type: 'provider.event', data: { name: event.type || 'unknown' } };
}
