# Observability operations

## Prometheus metrics

`GET /api/v1/metrics` returns Prometheus text exposition with `Cache-Control: no-store`. It is public at the application layer so a scraper can reach it without a user session. Restrict it to the monitoring network or require ingress authentication in a deployed environment; it reports aggregate process behavior, never credentials, SQL, request bodies, or medical records.

The application exposes only these metrics:

| Metric                                    | Type      | Labels                                 | Meaning                                                         |
| ----------------------------------------- | --------- | -------------------------------------- | --------------------------------------------------------------- |
| `amrutam_http_requests_total`             | Counter   | `method`, `route`, `status_code`       | Completed requests                                              |
| `amrutam_http_request_errors_total`       | Counter   | `method`, `route`, `status_code`       | Completed requests whose response status is 4xx or 5xx          |
| `amrutam_http_request_duration_seconds`   | Histogram | `method`, `route`, `status_code`, `le` | Request latency using fixed buckets from 5 ms through 10 s      |
| `amrutam_database_pool_connections_total` | Gauge     | none                                   | Connections currently owned by this process's `pg.Pool`         |
| `amrutam_database_pool_connections_idle`  | Gauge     | none                                   | Connections currently idle in this process's pool               |
| `amrutam_database_pool_waiting_requests`  | Gauge     | none                                   | Requests waiting to acquire a connection from this process pool |

HTTP labels use controller route templates such as `/api/v1/consultations/:consultationId`. Unmatched routes use the fixed value `unmatched`, unsupported methods use `OTHER`, and status codes are bounded by the HTTP response space. Raw URLs, path IDs, query strings, request IDs, user IDs, email addresses, tokens, and bodies are never label values. Scrapes of `/api/v1/metrics` are excluded from request counters and histograms.

Metrics are in-process and reset when the process restarts. Each replica exposes its own values; Prometheus should aggregate counters and histograms across instances. Pool gauges are sampled when the endpoint is scraped and expose only the `pg.Pool` total, idle, and waiting counts.

### Local verification

Start the API normally, generate a request, and inspect the endpoint:

```bash
curl http://127.0.0.1:3000/api/v1/health
curl http://127.0.0.1:3000/api/v1/metrics
```

Example Prometheus scrape configuration:

```yaml
scrape_configs:
  - job_name: amrutam-api
    metrics_path: /api/v1/metrics
    static_configs:
      - targets: ['api:3000']
```

The Compose service already exposes the API port, so no second metrics port is required. This repository does not install or claim a running Prometheus server, dashboard, alert manager, or production alert policy.

## Logs and correlation

The API accepts a safe `X-Request-Id` or generates a UUID, returns it in the response, and includes it in request-completion and server-error records. HTTP logs contain the bounded method, controller route template, status, and duration; they do not contain raw URLs, query strings, headers, or bodies.

Recursive key normalization redacts credentials, tokens, database URLs, MFA material, contact/profile fields, prescriptions, clinical notes, medication and dosage fields, and arbitrary payload/body objects. Error diagnostics retain the error class, a bounded machine code when available, and stack frames, but omit the exception message because third-party errors may interpolate SQL parameters or personal data. Unexpected client responses remain the generic `An unexpected error occurred`.

## Health semantics

- `GET /api/v1/health` is process liveness and performs no database call.
- `GET /api/v1/health/ready` executes `SELECT 1`; it returns a minimal success document or a sanitized `503` without hostnames, connection strings, or driver errors.

## Distributed tracing status and safe implementation plan

Distributed tracing is not enabled. OpenTelemetry's Node auto-instrumentation must initialize before NestJS, Express, `http`, and `pg` are imported. A useful deployment also needs an OTLP exporter, collector/backend endpoint, TLS/authentication, sampling, retention, and explicit attribute filtering. Adding only the API package, console spans, or a late Nest provider would create an incomplete and potentially misleading setup.

The minimal safe follow-up is:

1. choose and operate an OpenTelemetry Collector or compatible OTLP backend;
2. add the Node SDK, HTTP/Express and `pg` instrumentation, and an OTLP trace exporter;
3. preload instrumentation before `dist/src/main.js` in local, Docker, and production startup commands;
4. configure service identity, propagation, head sampling, exporter TLS/auth, batching, and graceful SDK shutdown;
5. suppress `/api/v1/health` and `/api/v1/metrics` spans if their volume is not useful;
6. allow SQL operation/table metadata only—never SQL parameters, connection strings, request bodies, tokens, or medical fields; and
7. verify with an in-memory exporter test that an HTTP span and child PostgreSQL span are produced, sensitive attributes are absent, and an end-to-end trace reaches the configured backend.

Until those steps and an exporter-backed verification exist, no distributed tracing capability is claimed.
