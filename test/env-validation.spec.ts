import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { validateEnvironment } from '../src/config/env.validation';

const validEnvironment = {
  NODE_ENV: 'test',
  PORT: '3100',
  DATABASE_URL: 'postgresql://user:password@localhost:5432/amrutam',
  DATABASE_SSL: 'false',
  JWT_ACCESS_SECRET: 'a-development-secret-with-32-characters',
  JWT_ACCESS_TTL: '15m',
  APP_ORIGIN: 'http://localhost:3001',
  LOG_LEVEL: 'warn',
};

void describe('validateEnvironment', () => {
  void it('normalizes valid values and applies bounded defaults', () => {
    const result = validateEnvironment(validEnvironment);
    assert.equal(result.PORT, 3100);
    assert.equal(result.DATABASE_SSL, false);
    assert.equal(result.DATABASE_POOL_MAX, 10);
    assert.equal(result.SWAGGER_ENABLED, true);
  });

  void it('rejects missing required variables without printing secret values', () => {
    const invalid = { ...validEnvironment };
    delete (invalid as Partial<typeof validEnvironment>).DATABASE_URL;
    assert.throws(() => validateEnvironment(invalid), /DATABASE_URL is required/);
  });

  void it('rejects wildcard CORS configuration', () => {
    assert.throws(
      () => validateEnvironment({ ...validEnvironment, APP_ORIGIN: '*' }),
      /explicit comma-separated origins/,
    );
  });

  void it('rejects weak JWT secrets', () => {
    assert.throws(
      () => validateEnvironment({ ...validEnvironment, JWT_ACCESS_SECRET: 'too-short' }),
      /at least 32 characters/,
    );
  });
});
