export async function streamTaskEvents(response, options = {}) {
  if (!response?.ok || !response.body) {
    const failure = await response?.json?.().catch(() => ({ error: `HTTP ${response?.status ?? 'unknown'}` }));
    throw new Error(failure?.error ?? `HTTP ${response?.status ?? 'unknown'}`);
  }

  const onEvent = options.onEvent ?? (() => {});
  const onMalformedLine = options.onMalformedLine ?? (() => {});
  const continueWhile = options.continueWhile ?? (() => true);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const consume = async (line) => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); }
    catch { return onMalformedLine(line); }
    await onEvent(event);
  };

  try {
    while (continueWhile()) {
      const { done, value } = await reader.read();
      // continueWhile() was true when this read began, but the read was
      // in flight — a new conversation started, the agent changed, or the
      // caller otherwise walked away — while it awaited. A chunk read before
      // that point must not be applied after it.
      if (!continueWhile()) return;
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!continueWhile()) return;
        await consume(line);
      }
      if (done) {
        if (!continueWhile()) return;
        await consume(buffer);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
