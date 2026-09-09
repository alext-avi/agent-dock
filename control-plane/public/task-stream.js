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
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) await consume(line);
      if (done) {
        await consume(buffer);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
