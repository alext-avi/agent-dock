export const AGENT_WRAPPER_API_VERSION = 'agent-wrapper/v1';

export function normalizeTokenUsage(raw = {}) {
  const numberFrom = (...values) => {
    const value = values.find((candidate) => Number.isFinite(Number(candidate)));
    return value === undefined ? 0 : Number(value);
  };
  const inputTokens = numberFrom(raw.input_tokens, raw.inputTokens);
  const cachedInputTokens = numberFrom(raw.cached_input_tokens, raw.cachedInputTokens);
  const outputTokens = numberFrom(raw.output_tokens, raw.outputTokens);
  const totalTokens = numberFrom(raw.total_tokens, raw.totalTokens, inputTokens + outputTokens);
  return { inputTokens, cachedInputTokens, outputTokens, totalTokens };
}

export function wrapperEvent(type, { taskId = null, data = {} } = {}) {
  return {
    apiVersion: AGENT_WRAPPER_API_VERSION,
    at: new Date().toISOString(),
    type,
    taskId,
    data
  };
}

export function wrapperResponse(value = {}) {
  return { apiVersion: AGENT_WRAPPER_API_VERSION, ...value };
}
