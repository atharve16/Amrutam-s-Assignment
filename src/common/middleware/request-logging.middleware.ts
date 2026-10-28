import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import {
  boundedHttpMethod,
  isMetricsRequest,
  requestRouteTemplate,
} from '../http/request-metadata';
import { JsonLogger } from '../logging/json-logger.service';
import { MetricsService } from '../../observability/metrics.service';

@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  constructor(
    private readonly logger: JsonLogger,
    private readonly metrics: MetricsService,
  ) {}

  use(request: Request, response: Response, next: NextFunction): void {
    if (isMetricsRequest(request)) {
      next();
      return;
    }
    const startedAt = process.hrtime.bigint();
    response.once('finish', () => {
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      const method = boundedHttpMethod(request.method);
      const route = requestRouteTemplate(request);
      this.metrics.recordHttpRequest(method, route, response.statusCode, durationSeconds);
      this.logger.log({
        event: 'http_request_completed',
        requestId: request.requestId,
        method,
        route,
        statusCode: response.statusCode,
        durationMs: Number((durationSeconds * 1000).toFixed(2)),
      });
    });
    next();
  }
}
