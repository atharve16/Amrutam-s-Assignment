export interface ApplicationConfiguration {
  app: {
    environment: string;
    port: number;
    origins: string[];
    logLevel: string;
    swaggerEnabled: boolean;
    requestBodyLimit: string;
  };
  database: {
    url: string;
    ssl: boolean;
    poolMax: number;
    connectionTimeoutMs: number;
    idleTimeoutMs: number;
  };
  jwt: {
    accessSecret: string;
    accessTtl: string;
    refreshTtlDays: number;
  };
  auth: {
    rateLimitMax: number;
    rateLimitWindowSeconds: number;
  };
}

export default function configuration(): ApplicationConfiguration {
  return {
    app: {
      environment: process.env.NODE_ENV ?? 'development',
      port: Number(process.env.PORT ?? 3000),
      origins: (process.env.APP_ORIGIN ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
      logLevel: process.env.LOG_LEVEL ?? 'log',
      swaggerEnabled:
        process.env.SWAGGER_ENABLED === undefined
          ? process.env.NODE_ENV !== 'production'
          : process.env.SWAGGER_ENABLED === 'true',
      requestBodyLimit: process.env.REQUEST_BODY_LIMIT ?? '100kb',
    },
    database: {
      url: process.env.DATABASE_URL ?? '',
      ssl: process.env.DATABASE_SSL !== 'false',
      poolMax: Number(process.env.DATABASE_POOL_MAX ?? 10),
      connectionTimeoutMs: Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS ?? 5000),
      idleTimeoutMs: Number(process.env.DATABASE_IDLE_TIMEOUT_MS ?? 30000),
    },
    jwt: {
      accessSecret: process.env.JWT_ACCESS_SECRET ?? '',
      accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
      refreshTtlDays: Number(process.env.JWT_REFRESH_TTL_DAYS ?? 30),
    },
    auth: {
      rateLimitMax: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 10),
      rateLimitWindowSeconds: Number(process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS ?? 60),
    },
  };
}
