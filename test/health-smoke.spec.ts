import { strict as assert } from 'node:assert';
import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

let application: ChildProcess;
let baseUrl: string;
let startupOutput = '';

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not allocate a test port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

async function waitForApplication(): Promise<void> {
  // Windows CI and endpoint security scanners can make the first Node process cold start slow.
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (application.exitCode !== null) {
      throw new Error(`Application exited during startup: ${startupOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/v1/health`);
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Application did not start before the timeout: ${startupOutput}`);
}

void describe('health endpoints smoke test', () => {
  void before(async () => {
    const port = await availablePort();
    baseUrl = `http://127.0.0.1:${port}`;
    application = spawn(process.execPath, [resolve('dist/src/main.js')], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(port),
        DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/unavailable',
        DATABASE_SSL: 'false',
        DATABASE_CONNECTION_TIMEOUT_MS: '100',
        JWT_ACCESS_SECRET: 'test-only-secret-that-is-long-enough-123',
        JWT_ACCESS_TTL: '15m',
        APP_ORIGIN: 'http://localhost:3001',
        LOG_LEVEL: 'error',
        SWAGGER_ENABLED: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    application.stdout?.on('data', (chunk: Buffer) => {
      startupOutput += chunk.toString();
    });
    application.stderr?.on('data', (chunk: Buffer) => {
      startupOutput += chunk.toString();
    });
    await waitForApplication();
  });

  void after(() => {
    if (application && application.exitCode === null) application.kill();
  });

  void it('returns liveness without requiring the database', async () => {
    const response = await fetch(`${baseUrl}/api/v1/health`, {
      headers: { 'x-request-id': 'health-test-request' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), 'health-test-request');
    assert.equal(((await response.json()) as { status: string }).status, 'ok');
  });

  void it('returns a sanitized 503 response when the database is unavailable', async () => {
    const response = await fetch(`${baseUrl}/api/v1/health/ready`, {
      headers: { 'x-request-id': 'readiness-test-request' },
    });
    assert.equal(response.status, 503);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.statusCode, 503);
    assert.equal(body.requestId, 'readiness-test-request');
    assert.equal(JSON.stringify(body).includes('postgresql://'), false);
    assert.equal(JSON.stringify(body).includes('ECONNREFUSED'), false);
  });

  void it('serves Swagger at the documented path when enabled', async () => {
    const response = await fetch(`${baseUrl}/api/docs`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Amrutam API documentation/);
  });
});
