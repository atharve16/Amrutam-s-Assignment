# Implemented booking transaction sequence

`POST /api/v1/consultations` implements the transaction below. The outbox worker shown after commit is planned and not implemented.

```mermaid
sequenceDiagram
  autonumber
  actor A as Patient A
  actor B as Concurrent patient B
  participant API as ConsultationsService
  participant DB as PostgreSQL transaction
  participant UQ as Partial unique index
  participant Worker as Future outbox worker

  par Request A
    A->>API: POST consultation + Idempotency-Key A
    API->>DB: BEGIN
    API->>DB: INSERT/lock idempotency record and fingerprint
    API->>DB: SELECT verified open future slot FOR UPDATE
    API->>DB: INSERT consultation(scheduled)
    DB->>UQ: reserve slot_id where status != cancelled
    UQ-->>DB: accepted
    API->>DB: INSERT audit log + outbox event
    API->>DB: complete idempotency response
    API->>DB: COMMIT
    API-->>A: 201 response after commit
  and Request B for same slot
    B->>API: POST consultation + Idempotency-Key B
    API->>DB: BEGIN and wait for slot lock
    API->>DB: attempt consultation insert
    DB->>UQ: reserve same slot_id
    UQ-->>DB: unique violation 23505
    API->>DB: ROLLBACK
    API-->>B: 409 Conflict
  end

  Note over API,DB: A matching scoped key replays its safe committed response. A different fingerprint returns 409.
  Note over DB,Worker: Consultation and outbox become visible atomically after COMMIT.
  Worker->>DB: Future claim with FOR UPDATE SKIP LOCKED
```

Cancellation is another idempotent transaction. It locks the consultation, validates patient/doctor/admin authority and the transition, sets cancellation fields, appends audit/outbox records, completes idempotency, and commits. The cancelled historical row no longer participates in the partial unique index, so one replacement booking can succeed.
