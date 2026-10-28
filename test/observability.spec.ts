import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { Request } from 'express';
import {
  boundedHttpMethod,
  isMetricsRequest,
  requestRouteTemplate,
} from '../src/common/http/request-metadata';
import { sanitizeForLogging } from '../src/common/logging/json-logger.service';
import { DatabaseService } from '../src/database/database.service';
import { MetricsService } from '../src/observability/metrics.service';

function metricsService(pool = { total: 7, idle: 4, waiting: 2 }): MetricsService {
  const database = {
    poolStats: () => pool,
  } as DatabaseService;
  return new MetricsService(database);
}

void describe('observability', () => {
  void it('counts requests and errors by bounded response labels', async () => {
    const metrics = metricsService();
    metrics.recordHttpRequest('GET', '/api/v1/health', 200, 0.012);
    metrics.recordHttpRequest('GET', '/api/v1/health/ready', 503, 0.125);
    metrics.recordHttpRequest('OTHER', 'unmatched', 9999, 0.001);

    const exposition = await metrics.render();
    assert.match(
      exposition,
      /amrutam_http_requests_total\{method="GET",route="\/api\/v1\/health",status_code="200"\} 1/,
    );
    assert.match(
      exposition,
      /amrutam_http_request_errors_total\{method="GET",route="\/api\/v1\/health\/ready",status_code="503"\} 1/,
    );
    assert.doesNotMatch(
      exposition,
      /amrutam_http_request_errors_total\{method="GET",route="\/api\/v1\/health",status_code="200"\}/,
    );
    assert.match(
      exposition,
      /amrutam_http_requests_total\{method="OTHER",route="unmatched",status_code="0"\} 1/,
    );
  });

  void it('records duration observations and current safe pool statistics', async () => {
    const metrics = metricsService();
    metrics.recordHttpRequest('PATCH', '/api/v1/consultations/:consultationId/status', 409, 0.125);

    const exposition = await metrics.render();
    assert.match(
      exposition,
      /amrutam_http_request_duration_seconds_sum\{method="PATCH",route="\/api\/v1\/consultations\/:consultationId\/status",status_code="409"\} 0\.125/,
    );
    assert.match(
      exposition,
      /amrutam_http_request_duration_seconds_count\{method="PATCH",route="\/api\/v1\/consultations\/:consultationId\/status",status_code="409"\} 1/,
    );
    assert.match(exposition, /amrutam_database_pool_connections_total 7/);
    assert.match(exposition, /amrutam_database_pool_connections_idle 4/);
    assert.match(exposition, /amrutam_database_pool_waiting_requests 2/);
  });

  void it('uses router templates and never raw URLs as metric dimensions', () => {
    const identifier = '123e4567-e89b-12d3-a456-426614174000';
    const matched = {
      route: { path: '/api/v1/consultations/:consultationId' },
      originalUrl: `/api/v1/consultations/${identifier}?email=patient@example.test`,
    } as Request;
    const unmatched = {
      originalUrl: `/missing/${identifier}?token=secret`,
    } as Request;

    assert.equal(requestRouteTemplate(matched), '/api/v1/consultations/:consultationId');
    assert.equal(requestRouteTemplate(unmatched), 'unmatched');
    assert.equal(boundedHttpMethod('PROPFIND'), 'OTHER');
    assert.equal(
      isMetricsRequest({
        path: '/',
        originalUrl: '/api/v1/metrics?token=must-not-appear',
      } as Request),
      true,
    );
    assert.doesNotMatch(requestRouteTemplate(matched), new RegExp(identifier));
    assert.doesNotMatch(requestRouteTemplate(matched), /email|example|token|secret/);
  });

  void it('redacts credentials, identity, and clinical fields from structured logs', () => {
    const error = Object.assign(
      new Error('Database failure for patient@example.test with token secret-token'),
      { code: '23505', detail: 'prescription contents' },
    );
    const sanitized = sanitizeForLogging({
      requestId: 'safe-request-id',
      authorization: 'Bearer secret-token',
      databaseUrl: 'postgresql://user:password@example.test/db',
      patient: {
        email: 'patient@example.test',
        phone_e164: '+919999999999',
        fullName: 'Private Patient',
      },
      clinicalNotes: 'Sensitive diagnosis',
      prescription: { medicationName: 'Private medicine', dosage: 'Private dosage' },
      mfaSecret: 'private-mfa-secret',
      error,
    });
    const output = JSON.stringify(sanitized);

    assert.match(output, /safe-request-id/);
    assert.match(output, /\[REDACTED\]/);
    for (const sensitive of [
      'secret-token',
      'postgresql://',
      'patient@example.test',
      '+919999999999',
      'Private Patient',
      'Sensitive diagnosis',
      'Private medicine',
      'Private dosage',
      'private-mfa-secret',
      'prescription contents',
    ]) {
      assert.equal(output.includes(sensitive), false, `Leaked sensitive value: ${sensitive}`);
    }
    assert.match(output, /"code":"23505"/);
  });
});
