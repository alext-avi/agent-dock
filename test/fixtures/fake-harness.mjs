// A deliberately uncooperative stand-in for a provider CLI, used by
// test/runtime-limits.test.mjs. It exists to produce a real process tree — a
// child and a grandchild with real PIDs — so process-tree termination is tested
// against the operating system rather than against a mocked kill().
//
//   node fake-harness.mjs <mode> <pidFile>
//
//   silent    start a grandchild, then never speak again
//   chatty    start a grandchild, then emit one event every 40 ms forever
//   stubborn  like silent, but ignore SIGTERM so only SIGKILL ends it
//   burst     emit three events, fall silent, then exit cleanly
//
// The grandchild always ignores SIGTERM and always detaches its stdio, so a
// test that finds it dead has watched a group SIGKILL actually work, and a
// lingering grandchild can never hold the parent's stdout open.

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [, , mode = 'silent', pidFile] = process.argv;

if (mode === 'stubborn') process.on('SIGTERM', () => {});

const grandchild = spawn(
  process.execPath,
  ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
  { stdio: 'ignore' }
);

if (pidFile) writeFileSync(pidFile, JSON.stringify({ harness: process.pid, grandchild: grandchild.pid }));

function emit(text) {
  process.stdout.write(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`);
}

if (mode === 'chatty') {
  setInterval(() => emit('still working'), 40);
} else if (mode === 'burst') {
  let sent = 0;
  const timer = setInterval(() => {
    emit(`burst ${++sent}`);
    if (sent < 3) return;
    clearInterval(timer);
    // Exit while deliberately leaving the grandchild alive. The wrapper must
    // reap the process group even on normal completion; if the fixture killed
    // its own descendant, that regression test would pass without testing the
    // behaviour it claims to cover.
    process.exit(0);
  }, 20);
} else {
  // silent and stubborn: hold the process open with nothing to say.
  setInterval(() => {}, 1000);
}
