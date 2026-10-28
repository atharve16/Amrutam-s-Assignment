export const NODE_ENVIRONMENTS = ['development', 'test', 'production'] as const;
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'] as const;

export type NodeEnvironment = (typeof NODE_ENVIRONMENTS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface ValidatedEnvironment {
  NODE_ENV: NodeEnvironment;
  PORT: number;
  DATABASE_URL: string;
  DATABASE_SSL: boolean;
  DATABASE_POOL_MAX: number;
  DATABASE_CONNECTION_TIMEOUT_MS: number;
  DATABASE_IDLE_TIMEOUT_MS: number;
  JWT_ACCESS_SECRET: string;
  JWT_ACCESS_TTL: string;
  JWT_REFRESH_TTL_DAYS: number;
  AUTH_RATE_LIMIT_MAX: number;
  AUTH_RATE_LIMIT_WINDOW_SECONDS: number;
  APP_ORIGIN: string;
  LOG_LEVEL: LogLevel;
  SWAGGER_ENABLED: boolean;
  REQUEST_BODY_LIMIT: string;
}

type EnvironmentInput = Record<string, string | undefined>;

function required(input: EnvironmentInput, name: string): string {
  const value = input[name]?.trim();
  if (!value) {
    throw new Error(`Environment variable ${name} is required`);
  }
  return value;
}

function integerInRange(
  input: EnvironmentInput,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const raw = input[name]?.trim();
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `Environment variable ${name} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return parsed;
}

function booleanValue(input: EnvironmentInput, name: string, defaultValue: boolean): boolean {
  const raw = input[name]?.trim().toLowerCase();
  if (!raw) return defaultValue;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`Environment variable ${name} must be true or false`);
}

function oneOf<T extends string>(
  input: EnvironmentInput,
  name: string,
  allowed: readonly T[],
  defaultValue: T,
): T {
  const value = input[name]?.trim() || defaultValue;
  if (!allowed.includes(value as T)) {
    throw new Error(`Environment variable ${name} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function validateDatabaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Environment variable DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname) {
    throw new Error('Environment variable DATABASE_URL must be a valid PostgreSQL URL');
  }
  return value;
}

function validateOrigins(value: string): string {
  const origins = value.split(',').map((origin) => origin.trim());
  if (origins.some((origin) => !origin || origin === '*')) {
    throw new Error(
      'Environment variable APP_ORIGIN must contain explicit comma-separated origins',
    );
  }
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error('Environment variable APP_ORIGIN contains an invalid origin');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
      throw new Error('Environment variable APP_ORIGIN must contain origins without paths');
    }
  }
  return origins.join(',');
}

export function validateEnvironment(input: EnvironmentInput): ValidatedEnvironment {
  const nodeEnvironment = oneOf(input, 'NODE_ENV', NODE_ENVIRONMENTS, 'development');
  const jwtSecret = required(input, 'JWT_ACCESS_SECRET');
  if (jwtSecret.length < 32) {
    throw new Error('Environment variable JWT_ACCESS_SECRET must be at least 32 characters');
  }

  const accessTtl = required(input, 'JWT_ACCESS_TTL');
  if (!/^\d+(ms|s|m|h|d)$/.test(accessTtl)) {
    throw new Error('Environment variable JWT_ACCESS_TTL must use a duration such as 15m or 1h');
  }

  const bodyLimit = input.REQUEST_BODY_LIMIT?.trim() || '100kb';
  if (!/^\d+(b|kb|mb)$/i.test(bodyLimit)) {
    throw new Error('Environment variable REQUEST_BODY_LIMIT must use b, kb, or mb');
  }

  return {
    NODE_ENV: nodeEnvironment,
    PORT: integerInRange(input, 'PORT', 3000, 1, 65535),
    DATABASE_URL: validateDatabaseUrl(required(input, 'DATABASE_URL')),
    DATABASE_SSL: booleanValue(input, 'DATABASE_SSL', true),
    DATABASE_POOL_MAX: integerInRange(input, 'DATABASE_POOL_MAX', 10, 1, 50),
    DATABASE_CONNECTION_TIMEOUT_MS: integerInRange(
      input,
      'DATABASE_CONNECTION_TIMEOUT_MS',
      5000,
      100,
      60000,
    ),
    DATABASE_IDLE_TIMEOUT_MS: integerInRange(
      input,
      'DATABASE_IDLE_TIMEOUT_MS',
      30000,
      1000,
      300000,
    ),
    JWT_ACCESS_SECRET: jwtSecret,
    JWT_ACCESS_TTL: accessTtl,
    JWT_REFRESH_TTL_DAYS: integerInRange(input, 'JWT_REFRESH_TTL_DAYS', 30, 1, 90),
    AUTH_RATE_LIMIT_MAX: integerInRange(input, 'AUTH_RATE_LIMIT_MAX', 10, 1, 100),
    AUTH_RATE_LIMIT_WINDOW_SECONDS: integerInRange(
      input,
      'AUTH_RATE_LIMIT_WINDOW_SECONDS',
      60,
      10,
      3600,
    ),
    APP_ORIGIN: validateOrigins(required(input, 'APP_ORIGIN')),
    LOG_LEVEL: oneOf(input, 'LOG_LEVEL', LOG_LEVELS, 'log'),
    SWAGGER_ENABLED: booleanValue(input, 'SWAGGER_ENABLED', nodeEnvironment !== 'production'),
    REQUEST_BODY_LIMIT: bodyLimit.toLowerCase(),
  };
}
