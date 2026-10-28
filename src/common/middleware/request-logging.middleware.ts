import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { JsonLogger } from '../logging/json-logger.service';

@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  constructor(private readonly logger: JsonLogger) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();
    response.once('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      this.logger.log({
        event: 'http_request_completed',
        requestId: request.requestId,
        method: request.method,
        path: request.path,
        statusCode: response.statusCode,
        durationMs: Number(durationMs.toFixed(2)),
      });
    });
    next();
  }
}
