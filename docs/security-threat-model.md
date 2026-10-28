# MVP security checklist and threat model

## Data classification

| Class                     | Examples                                                 | Handling                                                       |
| ------------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| Restricted                | Database password, JWT secret, passwords, refresh tokens | Runtime secrets; Argon2id/hash storage; redacted; never logged |
| Sensitive health/identity | Profiles, consultations, prescriptions                   | Ownership/RBAC checks; no body logging; TLS in transit         |
| Financial                 | Payment attempts and amounts                             | Exact numeric storage; record-only; client cannot set success  |
| Internal                  | Stack traces, SQL/database errors                        | Server logs only; generic unexpected client errors             |
| Public                    | Liveness, verified doctor directory                      | Minimal bounded output                                         |

## Threats and mitigations

| Threat                | Implemented mitigation                                                             | Remaining risk/work                              |
| --------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------ |
| SQL injection         | Parameterized values; dynamic fragments are fixed server strings                   | Database-backed query tests and continued review |
| Mass assignment       | Explicit DTOs; global whitelist and forbidden extras                               | Maintain DTO coverage                            |
| Password/token theft  | Argon2id; opaque refresh hashes; short access TTL; TLS                             | Secret manager and rotation exercise             |
| Token replay          | Refresh rotation, family reuse detection, active-session check                     | MFA and security alert delivery                  |
| Broken access control | Global JWT/RBAC guards plus patient/doctor ownership checks                        | Full integration/penetration suite               |
| Brute force           | Per-process bounded auth throttle; generic login error                             | Distributed ingress limiter for replicas         |
| Double booking        | Slot lock and database partial unique index                                        | Endpoint race test on dedicated PostgreSQL       |
| Availability overlap  | GiST exclusion constraint and `409` mapping                                        | Integration coverage                             |
| Payment forgery       | Only `created` record accepted; no client success field                            | Real provider webhook verification if integrated |
| Audit tampering       | Append-only trigger and service audit writes                                       | Least-privilege grants and external archive      |
| Async event loss      | Outbox written in business transaction                                             | Worker, retries, dead-letter recovery            |
| Sensitive logs        | Route-template request logs, recursive field redaction, message-free error objects | Central collector access/retention policy        |

## Checklist

- [x] Environment secrets are validated without echoing values; `.env` is ignored.
- [x] PostgreSQL TLS verification, bounded pool, CORS allowlist, Helmet, body limits, correlation IDs, and safe errors are enabled.
- [x] Public registration is patient-only; administrator bootstrap is server-side and one-time.
- [x] Passwords use Argon2id; refresh tokens are hashed and rotate; protected calls check session/account state.
- [x] RBAC, ownership, doctor assignment, and doctor verification are enforced.
- [x] Idempotency keys and fingerprints protect booking, lifecycle transitions, and payment creation.
- [x] Booking and availability have database concurrency invariants.
- [x] Important state changes append audit records; audit updates/deletes are rejected.
- [x] Payment behavior is clearly record-only and cannot accept client success.
- [ ] Implement MFA enrollment/challenge/recovery and encrypt operational key material with a managed KMS.
- [ ] Add distributed throttling, secret/SAST/container scanning, and security alerting.
- [ ] Configure least-privilege database grants and external audit retention.
- [ ] Exercise backup/restore and disaster recovery.

The HTTPS API is the primary trust boundary. Clients are untrusted. PostgreSQL is authoritative for identities, roles, state, idempotency, and booking uniqueness. Supabase dashboard, deployment secrets, CI, and the admin bootstrap environment are privileged surfaces and require operational MFA and least privilege outside this repository.
