# Assignment requirements and traceability

Source: `Backend Developer Assignment  (3).pdf`. Status is based on implemented code and executed checks, not schema presence alone.

## Explicit assignment requirements

| Requirement                              | Implementation / evidence                                                                            | Status                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| User authentication and roles            | Argon2id registration/login, JWT, hashed rotating sessions, global guards, patient/doctor/admin RBAC | Implemented MVP                                    |
| MFA                                      | Schema supports encrypted factors                                                                    | Not implemented; no challenge claim                |
| Doctor availability and booking          | Verified directory, paginated search, UTC slots, GiST overlap prevention, transactional booking      | Implemented MVP; live endpoint DB test pending     |
| Consultation lifecycle and prescriptions | Role/ownership transitions, lifecycle timestamps, assigned-doctor prescription after completion      | Implemented MVP                                    |
| Search and filtering                     | Verified doctor filters/availability and scoped consultation filters                                 | Implemented MVP                                    |
| Compliance and audit trails              | Append-only audit schema plus auth/doctor/booking/lifecycle/prescription/payment events              | Implemented MVP; external archive pending          |
| Admin analytics                          | Admin-only bounded consultation/payment/utilization aggregates                                       | Implemented MVP                                    |
| Idempotency for writes                   | Scoped keys, canonical fingerprints, replay/conflict behavior for critical writes                    | Implemented MVP                                    |
| Async heavy work                         | Transactional outbox rows from consultation flows                                                    | Partial; worker/retries not implemented            |
| Rate limiting and validation             | Strict global DTO validation and in-process auth throttle                                            | Partial; distributed limiter pending               |
| Metrics, logs, traces                    | Structured redacted JSON logs and request IDs                                                        | Partial; metrics/traces pending                    |
| 100k daily consultations                 | Indexed model and no-cache correctness design                                                        | Unverified; no load-test claim                     |
| p95 read/write targets                   | No measured result                                                                                   | Not verified                                       |
| 99.95% availability                      | Health/readiness and graceful shutdown                                                               | Partial; deployment/SLO evidence pending           |
| Architecture/data flow                   | `docs/architecture.md`                                                                               | Implemented                                        |
| Booking sequence                         | `docs/diagrams/booking-sequence.md`                                                                  | Updated to implementation                          |
| ER diagram                               | `docs/diagrams/er-diagram.md`                                                                        | Implemented                                        |
| API schema                               | Runtime Swagger/OpenAPI with Bearer scheme and endpoint metadata                                     | Implemented MVP                                    |
| Retry/backoff                            | Outbox retry schema                                                                                  | Design only; worker pending                        |
| Partition/caching/concurrency decisions  | Database decisions plus DB constraints and slot locking                                              | Implemented design; load evidence pending          |
| Transaction management                   | Dedicated-client helper; booking/idempotency/audit/outbox atomicity                                  | Implemented MVP                                    |
| Backup/DR strategy                       | Retention assumptions only                                                                           | Restore exercise not implemented                   |
| Containerization and CI/CD               | Docker, Compose, GitHub Actions                                                                      | Implemented                                        |
| Tests                                    | Node test suite, HTTP health smoke, migration contracts, optional PostgreSQL verifier                | Implemented; endpoint integration DB tests pending |
| Security checklist/threat model          | `docs/security-threat-model.md`                                                                      | Updated for MVP                                    |
| Five-minute demo                         | `docs/demo.md`                                                                                       | Implemented artifact; video external               |

## Implementation decisions

The repository uses NestJS, TypeScript, REST, Swagger, Supabase PostgreSQL through `pg`, immutable SQL migrations, JWT sessions, Argon2id, DTO validation, Helmet, JSON logs, Docker/Compose, GitHub Actions, and Node’s built-in test runner. It does not introduce an ORM, Redis, BullMQ, Kafka, GraphQL, MongoDB, OpenAI, Jest, or Supertest.

Payment endpoints deliberately record internal attempts without a gateway. MFA, outbox delivery, metrics/tracing, load evidence, backup restoration, and distributed throttling are accurately reported as incomplete.
