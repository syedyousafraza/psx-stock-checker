import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';

const BACKEND_PORT = process.env.PORT || 8787;
const VITE_PORT = process.env.VITE_PORT || 5175;
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;
const MAX_WAIT_MS = 30_000;

function waitForBackend(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const interval = setInterval(() => {
      const client = request(new URL('/health/live', url), { method: 'GET' });
      client.setTimeout(2000, () => { client.destroy(); });
      client.on('response', (res) => {
        if (res.statusCode === 200) {
          clearInterval(interval);
          resolve();
        }
      });
      client.on('error', () => {});
      client.end();
      if (Date.now() - startTime > timeoutMs) {
        clearInterval(interval);
        reject(new Error('Backend did not start within timeout'));
      }
    }, 500);
  });
}

async function main() {
  console.log('[startup] Starting backend server...');
  const backend = spawn('node', ['backend/server.js'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: false,
  });

  backend.on('error', (err) => {
    console.error('[startup] Failed to start backend:', err);
    process.exit(1);
  });

  try {
    await waitForBackend(BACKEND_URL, MAX_WAIT_MS);
    console.log('[startup] Backend ready at', BACKEND_URL);
  } catch (err) {
    console.error('[startup]', err.message);
    backend.kill();
    process.exit(1);
  }

  console.log('[startup] Starting Vite frontend...');
  const vite = spawn('node', ['node_modules/vite/bin/vite.js', '--host', '0.0.0.0', '--port', String(VITE_PORT)], {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: false,
  });

  vite.on('error', (err) => {
    console.error('[startup] Failed to start Vite:', err);
    backend.kill();
    process.exit(1);
  });

  vite.on('close', (code) => {
    backend.kill();
    process.exit(code || 0);
  });

  process.on('SIGINT', () => {
    vite.kill();
    backend.kill();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    vite.kill();
    backend.kill();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[startup] Fatal:', err);
  process.exit(1);
});
