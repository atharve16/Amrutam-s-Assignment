# Amrutam Telemedicine Backend

NestJS/TypeScript REST API for the Amrutam assignment. The MVP implements password authentication, rotating sessions, RBAC, verified-doctor search and availability, transactional idempotent booking, consultation lifecycle controls, prescriptions, payment-record simulation, audit events, outbox writes, and protected analytics using direct parameterized PostgreSQL queries.

## Prerequisites

- Node.js 22.13+ or Node.js 24+
- npm 11+
- A non-production Supabase PostgreSQL project
- Docker only for the container workflow

## Install, configure, and run

```bash
npm ci
cp .env.example .env
# Fill required values without committing .env.
npm run migration:run
npm run start:dev
```

PowerShell uses `Copy-Item .env.example .env`. The API prefix is `/api/v1`; Swagger UI is at `http://localhost:3000/api/docs` when `SWAGGER_ENABLED=true`.

Required application values are `DATABASE_URL`, `JWT_ACCESS_SECRET` (at least 32 independently generated characters), `JWT_ACCESS_TTL`, and `APP_ORIGIN`. Supabase should use `DATABASE_SSL=true`. Session and auth-throttle defaults are:

```dotenv
JWT_REFRESH_TTL_DAYS=30
AUTH_RATE_LIMIT_MAX=10
AUTH_RATE_LIMIT_WINDOW_SECONDS=60
```

See [database setup](docs/database-setup.md) for Supabase connection mode, TLS, migrations, and disposable schema verification.

## Initial administrator

Public registration always creates a patient and rejects extra properties such as `role`. Create the first administrator once, after migrations, using temporary server-side environment values:

```powershell
$env:ADMIN_BOOTSTRAP_EMAIL = 'admin@example.com'
$env:ADMIN_BOOTSTRAP_PASSWORD = Read-Host 'Temporary strong admin password'
$env:ADMIN_BOOTSTRAP_FULL_NAME = 'Amrutam Administrator'
npm run admin:bootstrap
Remove-Item Env:ADMIN_BOOTSTRAP_EMAIL,Env:ADMIN_BOOTSTRAP_PASSWORD,Env:ADMIN_BOOTSTRAP_FULL_NAME
```

The bootstrap refuses to run when an administrator already exists. It creates no token; log in normally afterward. Rotate the temporary password operationally before production use.

## MVP endpoints

| Method and path                                | Access                       | Purpose                                      |
| ---------------------------------------------- | ---------------------------- | -------------------------------------------- |
| `POST /api/v1/auth/register`                   | Public                       | Register patient and create session          |
| `POST /api/v1/auth/login`                      | Public                       | Issue access and refresh tokens              |
| `POST /api/v1/auth/refresh`                    | Public                       | Rotate refresh token                         |
| `POST /api/v1/auth/logout`                     | Authenticated                | Revoke current session                       |
| `GET /api/v1/doctors`                          | Public                       | Paginated verified-doctor search             |
| `GET /api/v1/doctors/:id/availability`         | Public                       | Unbooked open slots in a UTC-aware range     |
| `POST /api/v1/doctors/me/availability`         | Doctor                       | Create non-overlapping availability          |
| `POST /api/v1/consultations`                   | Patient                      | Transactional booking                        |
| `GET /api/v1/consultations`                    | Authenticated                | Role/ownership-scoped history                |
| `GET /api/v1/consultations/:id`                | Authenticated                | Authorized detail                            |
| `PATCH /api/v1/consultations/:id/status`       | Owner/assigned doctor/admin  | Valid lifecycle transition                   |
| `POST /api/v1/consultations/:id/prescriptions` | Assigned doctor              | Issue after completion                       |
| `GET /api/v1/consultations/:id/prescriptions`  | Authorized participant/admin | Read prescriptions                           |
| `POST /api/v1/consultations/:id/payments`      | Patient owner                | Create record-only payment attempt           |
| `GET /api/v1/consultations/:id/payments`       | Authorized participant/admin | Read payment records                         |
| `POST /api/v1/admin/doctors`                   | Admin                        | Promote an active account to verified doctor |
| `GET /api/v1/admin/analytics`                  | Admin                        | Bounded aggregate analytics                  |
| `GET /api/v1/health`                           | Public                       | Liveness without database dependency         |
| `GET /api/v1/health/ready`                     | Public                       | Database readiness                           |

Availability creation, doctor promotion, booking, consultation transitions, prescription issuance, and payment creation require an `Idempotency-Key` header. Repeating the same scoped key and payload replays the committed response; changing the payload returns `409`. Booking reports success only after its database transaction commits.

## Commands

| Command                                | Purpose                                                   |
| -------------------------------------- | --------------------------------------------------------- |
| `npm run start:dev`                    | Development server with watch mode                        |
| `npm run build` / `npm run start:prod` | Compile and run production output                         |
| `npm run migration:run`                | Apply immutable SQL migrations                            |
| `npm run admin:bootstrap`              | One-time initial administrator creation                   |
| `npm run schema:verify`                | Destructive tests on a dedicated disposable database only |
| `npm run format:check`                 | Prettier verification                                     |
| `npm run lint`                         | Type-aware ESLint                                         |
| `npm run typecheck`                    | Strict TypeScript check                                   |
| `npm test`                             | Build and run `node:test` unit/static/HTTP smoke tests    |
| `npm run smoke`                        | Check an independently running API                        |

## Docker

```bash
docker build -t amrutam-api .
docker compose up --build
```

Compose reads the ignored `.env` at runtime and does not start PostgreSQL or embed credentials. Apply migrations as an explicit release step before starting the new image.

## Security and current limitations

- Passwords use Argon2id; refresh tokens are random and stored only as SHA-256 hashes; access requests verify both JWT and active database session.
- Roles come from PostgreSQL, not request bodies. Ownership and doctor assignment are enforced in services.
- Payment endpoints create internal records only. No gateway is integrated and clients cannot report payment success.
- MFA storage exists but enrollment/challenge/verification is **not implemented**.
- Auth throttling is per-process memory and should be replaced or supplemented by a trusted ingress/distributed limiter for multi-replica production.
- The transactional outbox is written by booking/lifecycle flows, but no delivery worker exists.
- Metrics, distributed tracing, measured load targets, backup/restore exercise, email verification, password reset, and automated retention jobs remain incomplete.
- Database-backed endpoint integration tests require a dedicated migrated test database and were not part of the secret-free default test command.

## Documentation

- [Assignment traceability](docs/assignment-requirements.md)
- [Architecture and data flow](docs/architecture.md)
- [Database schema](docs/database-schema.md) and [ER diagram](docs/diagrams/er-diagram.md)
- [Booking sequence](docs/diagrams/booking-sequence.md)
- [Security threat model](docs/security-threat-model.md)
- [Five-minute demo](docs/demo.md)
