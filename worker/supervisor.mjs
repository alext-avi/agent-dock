// Process-tree supervision for one harness task.
//
// The harness is spawned into its own process group so that a cancel or a
// timeout can reach every descendant it started, not just the CLI itself. That
// is the whole point: the subtree that stalls is rarely the process the wrapper
// holds a handle to. Signalling a group is only safe for a process we detached
// ourselves — signalling the negative pid of a non-detached child would target
// the worker's own group — so the caller must say so explicitly.

const FORCE_SIGNAL = 'SIGKILL';

function signalGroup(pid, signal, kill) {
  try {
    kill(-pid, signal);
    return true;
  } catch (error) {
    // ESRCH simply means the tree is already gone, which is the outcome we want.
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

function signalChild(child, signal) {
  try {
    return child.kill?.(signal) ?? false;
  } catch {
    return false;
  }
}

// Sends the graceful signal now and schedules the forced one. Returns a handle
// whose `dispose()` cancels the escalation, which the caller invokes when the
// process actually exits — an uncooperative harness is the only case that should
// ever reach SIGKILL.
export function terminateProcessTree(child, {
  graceMs = 10_000,
  processGroup = false,
  signal = 'SIGTERM',
  kill = process.kill,
  onPhase = null
} = {}) {
  const pid = child?.pid;
  const useGroup = processGroup && Number.isInteger(pid) && pid > 0;
  let forceTimer = null;
  let forced = false;

  const deliver = (phase, deliveredSignal) => {
    let delivered = false;
    if (useGroup) {
      try {
        delivered = signalGroup(pid, deliveredSignal, kill);
      } catch {
        delivered = signalChild(child, deliveredSignal);
      }
      // A detached child can still be signalled directly if the group call found
      // nothing — the group may have been reaped while a straggler lingers.
      if (!delivered) delivered = signalChild(child, deliveredSignal);
    } else {
      delivered = signalChild(child, deliveredSignal);
    }
    onPhase?.({ phase, signal: deliveredSignal, delivered, processGroup: useGroup });
    return delivered;
  };

  deliver('graceful', signal);
  forceTimer = setTimeout(() => {
    forced = true;
    deliver('force', FORCE_SIGNAL);
  }, Math.max(0, graceMs));
  // Never hold the event loop open for a grace period: the wrapper must be able
  // to exit even while an escalation is pending.
  forceTimer.unref?.();

  return {
    get forced() { return forced; },
    dispose() {
      if (forceTimer) clearTimeout(forceTimer);
      forceTimer = null;
    }
  };
}

// Tracks wall-clock and idle deadlines for one task. Activity is whatever the
// harness actually produced: meaningful stdout/stderr, or a normalized event.
export function createTaskSupervisor({
  policy,
  stallAfterMs,
  onStalled = null,
  onResumed = null,
  onExpired = null,
  now = () => Date.now()
} = {}) {
  const startedAtMs = now();
  let lastActivityAtMs = startedAtMs;
  let stalled = false;
  let expired = null;
  let timer = null;

  const idleLimit = policy.taskIdleTimeoutMs;
  const wallLimit = policy.taskWallTimeoutMs;
  const stallLimit = Math.max(1, stallAfterMs ?? Math.floor(idleLimit / 2));
  // Fine enough that a 100 ms test bound is observed promptly, coarse enough that
  // a 30-minute production bound costs one wakeup a second.
  const tickMs = Math.max(5, Math.min(1_000, Math.floor(Math.min(idleLimit, wallLimit, stallLimit) / 2) || 5));

  function snapshot() {
    const current = now();
    return {
      startedAt: new Date(startedAtMs).toISOString(),
      lastActivityAt: new Date(lastActivityAtMs).toISOString(),
      elapsedMs: current - startedAtMs,
      idleMs: current - lastActivityAtMs,
      stalled,
      expiredReason: expired
    };
  }

  function tick() {
    if (expired) return;
    const current = now();
    if (current - startedAtMs >= wallLimit) {
      expired = 'wall_timeout';
      stop();
      onExpired?.('wall_timeout', snapshot());
      return;
    }
    const idleMs = current - lastActivityAtMs;
    if (idleMs >= idleLimit) {
      expired = 'idle_timeout';
      stop();
      onExpired?.('idle_timeout', snapshot());
      return;
    }
    if (!stalled && idleMs >= stallLimit) {
      stalled = true;
      onStalled?.(snapshot());
    }
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  timer = setInterval(tick, tickMs);
  timer.unref?.();

  return {
    touch() {
      if (expired) return;
      lastActivityAtMs = now();
      if (stalled) {
        stalled = false;
        onResumed?.(snapshot());
      }
    },
    snapshot,
    stop,
    get expired() { return expired; },
    get stalled() { return stalled; }
  };
}

// stdout and stderr chunks arrive constantly for reasons that are not progress:
// a trailing newline, an empty flush, an ANSI repaint. Treating those as activity
// is how an idle bound silently stops meaning anything.
export function isMeaningfulOutput(text) {
  return typeof text === 'string' && text.replace(/\s+/g, '') !== '';
}

// After the harness process itself has exited, anything still alive in its group
// is an orphaned descendant — the background `npm test` subtree that outlived its
// parent in issue #44. Ending a task must not leave one behind, so the group is
// reaped unconditionally rather than only on the cancel and timeout paths.
export function reapProcessGroup(child, { processGroup = false, kill = process.kill } = {}) {
  const pid = child?.pid;
  if (!processGroup || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    return signalGroup(pid, FORCE_SIGNAL, kill);
  } catch {
    return false;
  }
}
