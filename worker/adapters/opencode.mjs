import { normalizeTokenUsage } from '../protocol.mjs';
import { openCodeMcpCapabilities } from './opencode-mcp.mjs';

export {
  OpenCodeMcpValidationError,
  openCodeMcpCapabilities,
  openCodeMcpTaskEnvironment,
  parseOpenCodeMcpList,
  renderOpenCodeMcpConfig,
  validateOpenCodeMcpServers
} from './opencode-mcp.mjs';

export const opencodeAdapterManifest = Object.freeze({
  id: 'opencode',
  provider: 'multi-provider',
  displayName: 'OpenCode',
  capabilities: {
    authentication: { methods: ['provider_device_code'], refresh: false },
    tasks: { streaming: 'ndjson', cancellation: true, profileInstructions: true, conversations: true },
    providers: { list: true, discovery: true, localConnections: true },
    models: { discovery: true, selection: true, orderedFallback: false },
    usage: { requestTokens: true, accountActivity: false, quotaWindows: false },
    workspace: { list: true },
    mcp: openCodeMcpCapabilities
  }
});

export const openCodeAdapterManifest = opencodeAdapterManifest;

function textFrom(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return null;
  try { return JSON.stringify(value); }
  catch { return String(value); }
}

export function normalizeOpenCodeEvent(event = {}) {
  const part = event.part ?? event.properties?.part ?? {};

  if (event.type === 'text' || part.type === 'text') {
    const text = textFrom(part.text ?? event.text ?? event.properties?.delta);
    if (text) return { type: 'message.completed', data: { role: 'assistant', text } };
  }

  if (event.type === 'tool_use' || part.type === 'tool') {
    const status = part.state?.status ?? event.status ?? 'started';
    return {
      type: status === 'completed' || status === 'error' ? 'activity.completed' : 'activity.started',
      data: {
        kind: 'tool_use',
        name: part.tool ?? part.name ?? event.tool ?? null,
        command: textFrom(part.state?.input?.command ?? part.input?.command),
        text: textFrom(part.state?.output ?? part.output ?? part.state?.input ?? part.input)
      }
    };
  }

  if (event.type === 'step_finish' || part.type === 'step-finish') {
    const raw = part.tokens ?? event.tokens ?? {};
    const cached = Number(raw.cache?.read ?? raw.cache_read ?? 0) + Number(raw.cache?.write ?? raw.cache_write ?? 0);
    return {
      type: 'usage.observed',
      data: {
        request: normalizeTokenUsage({
          input_tokens: Number(raw.input ?? 0) + cached,
          cached_input_tokens: cached,
          output_tokens: Number(raw.output ?? 0) + Number(raw.reasoning ?? 0)
        })
      }
    };
  }

  if (event.type === 'step_start' || part.type === 'step-start') {
    return { type: 'provider.lifecycle', data: { name: 'step.started' } };
  }

  if (event.type === 'error') {
    return { type: 'error', data: { source: 'provider', message: textFrom(event.error ?? event.message) ?? 'OpenCode task failed' } };
  }

  return { type: 'provider.event', data: { name: event.type || part.type || 'unknown' } };
}


// OpenCode stamps sessionID on every event it emits, so any of them identifies
// the session. Observed from a real `opencode run --format json` run.
export function observeOpenCodeSessionId(event = {}) {
  const id = event.sessionID ?? event.part?.sessionID;
  return typeof id === 'string' && id ? id : null;
}
