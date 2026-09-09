import assert from 'node:assert/strict';
import test from 'node:test';
import { streamTaskEvents } from '../control-plane/public/task-stream.js';

test('a stream chunk read after invalidation is not delivered to the abandoned consumer', async () => {
  let controller;
  let current = true;
  const events = [];
  const response = new Response(new ReadableStream({
    start(value) { controller = value; }
  }));
  const consuming = streamTaskEvents(response, {
    continueWhile: () => current,
    onEvent: (event) => events.push(event)
  });

  current = false;
  controller.enqueue(new TextEncoder().encode('{"type":"message.completed","data":{"text":"stale"}}\n'));
  controller.close();
  await consuming;

  assert.deepEqual(events, []);
});
