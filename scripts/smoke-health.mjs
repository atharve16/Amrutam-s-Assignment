const baseUrl = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const expectedReadiness = Number(process.env.SMOKE_EXPECT_READY_STATUS ?? 200);

async function check(path, expectedStatus) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { 'x-request-id': 'manual-smoke-check' },
  });
  if (response.status !== expectedStatus) {
    throw new Error(`${path} returned ${response.status}; expected ${expectedStatus}`);
  }
  const body = await response.json();
  if (body.statusCode >= 500 && body.requestId !== 'manual-smoke-check') {
    throw new Error(`${path} did not return the expected correlation ID`);
  }
  process.stdout.write(`${path}: ${response.status}\n`);
}

await check('/api/v1/health', 200);
await check('/api/v1/health/ready', expectedReadiness);
