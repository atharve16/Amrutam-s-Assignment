import { Injectable, LoggerService } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type LogLevel = 'fatal' | 'error' | 'warn' | 'log' | 'debug' | 'verbose';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  verbose: 10,
  debug: 20,
  log: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const REDACTED_KEYS = new Set([
  'authorization',
  'accesstoken',
  'cookie',
  'database_url',
  'jwt_access_secret',
  'password',
  'password_hash',
  'refresh_token',
  'refreshtoken',
  'secret',
  'secret_ciphertext',
  'token',
  'token_hash',
]);

@Injectable()
export class JsonLogger implements LoggerService {
  private readonly minimumPriority: number;

  constructor(private readonly config: ConfigService) {
    const configuredLevel = this.config.get<string>('app.logLevel') ?? 'log';
    this.minimumPriority = LEVEL_PRIORITY[configuredLevel as LogLevel] ?? LEVEL_PRIORITY.log;
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('log', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('verbose', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('fatal', message, optionalParams);
  }

  private write(level: LogLevel, message: unknown, optionalParams: unknown[]): void {
    if (LEVEL_PRIORITY[level] < this.minimumPriority) return;

    const context =
      typeof optionalParams.at(-1) === 'string' ? (optionalParams.pop() as string) : undefined;
    const record = {
      timestamp: new Date().toISOString(),
      level,
      ...(context ? { context } : {}),
      message: this.sanitize(message),
      ...(optionalParams.length > 0 ? { details: this.sanitize(optionalParams) } : {}),
    };
    const output = `${JSON.stringify(record)}\n`;
    if (LEVEL_PRIORITY[level] >= LEVEL_PRIORITY.error) {
      process.stderr.write(output);
    } else {
      process.stdout.write(output);
    }
  }

  private sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        ...(value.stack ? { stack: value.stack } : {}),
      };
    }
    if (Array.isArray(value)) return value.map((item) => this.sanitize(item, seen));
    if (typeof value !== 'object' || value === null) return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        REDACTED_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : this.sanitize(item, seen),
      ]),
    );
  }
}
