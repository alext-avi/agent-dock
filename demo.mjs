import { createControlPlane } from './control-plane/server.mjs';
import { createWorkerServer } from './worker/server.mjs';

const token = 'local-demo-worker';
const worker = createWorkerServer({
  token,
  demoMode: true,
  workspace: new URL('./workspace', import.meta.url).pathname
});
const control = createControlPlane({
  workerUrl: 'http://127.0.0.1:7777',
  workerToken: token
});

worker.listen(7777, '127.0.0.1', () => console.log('[demo-worker] http://127.0.0.1:7777'));
control.listen(3000, '127.0.0.1', () => console.log('[demo-ui] http://127.0.0.1:3000'));

function shutdown() {
  control.close(() => worker.close(() => process.exit(0)));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
