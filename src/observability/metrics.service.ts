import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';
import { DatabaseService } from '../database/database.service';

type HttpLabel = 'method' | 'route' | 'status_code';

@Injectable()
export class MetricsService {
  private readonly registry = new Registry();
  private readonly requests = new Counter<HttpLabel>({
    name: 'amrutam_http_requests_total',
    help: 'Completed HTTP requests handled by this process.',
    labelNames: ['method', 'route', 'status_code'],
    registers: [this.registry],
  });
  private readonly errors = new Counter<HttpLabel>({
    name: 'amrutam_http_request_errors_total',
    help: 'Completed HTTP requests with a 4xx or 5xx response.',
    labelNames: ['method', 'route', 'status_code'],
    registers: [this.registry],
  });
  private readonly duration = new Histogram<HttpLabel>({
    name: 'amrutam_http_request_duration_seconds',
    help: 'HTTP request duration in seconds.',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });
  private readonly poolTotal = new Gauge({
    name: 'amrutam_database_pool_connections_total',
    help: 'PostgreSQL connections currently owned by this process pool.',
    registers: [this.registry],
  });
  private readonly poolIdle = new Gauge({
    name: 'amrutam_database_pool_connections_idle',
    help: 'Idle PostgreSQL connections in this process pool.',
    registers: [this.registry],
  });
  private readonly poolWaiting = new Gauge({
    name: 'amrutam_database_pool_waiting_requests',
    help: 'Requests waiting to acquire a PostgreSQL connection from this process pool.',
    registers: [this.registry],
  });

  constructor(private readonly database: DatabaseService) {}

  recordHttpRequest(method: string, route: string, statusCode: number, seconds: number): void {
    const boundedStatusCode =
      Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? statusCode : 0;
    const labels = {
      method,
      route,
      status_code: String(boundedStatusCode),
    };
    this.requests.inc(labels);
    if (boundedStatusCode >= 400) this.errors.inc(labels);
    this.duration.observe(labels, Math.max(0, seconds));
  }

  async render(): Promise<string> {
    const pool = this.database.poolStats();
    this.poolTotal.set(pool.total);
    this.poolIdle.set(pool.idle);
    this.poolWaiting.set(pool.waiting);
    return this.registry.metrics();
  }

  contentType(): string {
    return this.registry.contentType;
  }
}
