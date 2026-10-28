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
  'body',
  'cancellationreason',
  'clinicalnotes',
  'cookie',
  'databaseurl',
  'dosage',
  'email',
  'fullname',
  'jwtaccesssecret',
  'medicationname',
  'mfasecret',
  'password',
  'passwordhash',
  'payload',
  'phone',
  'phonee164',
  'prescription',
  'refreshtoken',
  'secret',
  'secretciphertext',
  'token',
  'tokenhash',
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
}

function safeError(value: Error): Record<string, unknown> {
  const name = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value.name) ? value.name : 'Error';
  const candidateCode = (value as Error & { code?: unknown }).code;
  const code =
    typeof candidateCode === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(candidateCode)
      ? candidateCode
      : undefined;
  const stackFrames = value.stack?.split(/\r?\n/).slice(1, 9).join('\n').trim();
  return {
    name,
    ...(code ? { code } : {}),
    ...(stackFrames ? { stack: stackFrames } : {}),
  };
}

export function sanitizeForLogging(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) return safeError(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeForLogging(item, seen));
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      REDACTED_KEYS.has(normalizedKey(key)) ? '[REDACTED]' : sanitizeForLogging(item, seen),
    ]),
  );
}

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
      message: sanitizeForLogging(message),
      ...(optionalParams.length > 0 ? { details: sanitizeForLogging(optionalParams) } : {}),
    };
    const output = `${JSON.stringify(record)}\n`;
    if (LEVEL_PRIORITY[level] >= LEVEL_PRIORITY.error) {
      process.stderr.write(output);
    } else {
      process.stdout.write(output);
    }
  }
}
