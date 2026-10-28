# Amrutam relational model

The diagram shows physical foreign-key cardinalities. Generic `resource_id`/`aggregate_id` values in audit, idempotency, and outbox records deliberately have no polymorphic foreign key.

```mermaid
erDiagram
  USERS {
    uuid id PK
    text email UK
    text phone_e164 UK
    text password_hash
    text role
    text status
    timestamptz created_at
    timestamptz updated_at
  }

  PROFILES {
    uuid user_id PK,FK
    text full_name
    text timezone
    timestamptz created_at
    timestamptz updated_at
  }

  DOCTORS {
    uuid id PK
    uuid user_id FK,UK
    text license_number
    text license_jurisdiction
    text specialization
    text verification_status
    uuid verified_by FK
  }

  AVAILABILITY_SLOTS {
    uuid id PK
    uuid doctor_id FK
    timestamptz starts_at
    timestamptz ends_at
    text status
  }

  CONSULTATIONS {
    uuid id PK
    uuid patient_id FK
    uuid doctor_id FK
    uuid slot_id FK
    timestamptz scheduled_start_at
    timestamptz scheduled_end_at
    text status
  }

  PRESCRIPTIONS {
    uuid id PK
    uuid consultation_id FK
    uuid doctor_id FK
    uuid supersedes_id FK
    integer version
    text status
  }

  PRESCRIPTION_ITEMS {
    uuid id PK
    uuid prescription_id FK
    text medication_name
    text dosage
    text frequency
    text duration
  }

  PAYMENTS {
    uuid id PK
    uuid consultation_id FK
    numeric amount
    char currency
    text status
    text provider
    text provider_reference
  }

  SESSIONS {
    uuid id PK
    uuid user_id FK
    uuid token_family_id
    uuid parent_session_id FK
    bytea token_hash UK
    text status
    timestamptz expires_at
  }

  MFA_FACTORS {
    uuid id PK
    uuid user_id FK
    text factor_type
    bytea secret_ciphertext
    text status
  }

  IDEMPOTENCY_RECORDS {
    uuid id PK
    uuid actor_id FK
    bytea anonymous_scope_hash
    text operation
    text idempotency_key
    char request_fingerprint
    text status
    uuid resource_id
  }

  AUDIT_LOGS {
    bigint id PK
    uuid actor_id FK
    text action
    text resource_type
    uuid resource_id
    text request_id
    jsonb metadata
    timestamptz occurred_at
  }

  OUTBOX_EVENTS {
    uuid id PK
    text event_type
    text aggregate_type
    uuid aggregate_id
    jsonb payload
    text status
    integer attempt_count
  }

  USERS ||--o| PROFILES : has
  USERS ||--o| DOCTORS : represents
  USERS o|--o{ DOCTORS : verifies
  DOCTORS ||--o{ AVAILABILITY_SLOTS : offers
  USERS ||--o{ CONSULTATIONS : books_as_patient
  USERS o|--o{ CONSULTATIONS : cancels
  DOCTORS ||--o{ CONSULTATIONS : attends
  AVAILABILITY_SLOTS ||--o{ CONSULTATIONS : retains_booking_history
  CONSULTATIONS ||--o{ PRESCRIPTIONS : has_versions
  DOCTORS ||--o{ PRESCRIPTIONS : authors
  PRESCRIPTIONS o|--o{ PRESCRIPTIONS : supersedes
  PRESCRIPTIONS ||--o{ PRESCRIPTION_ITEMS : contains
  CONSULTATIONS ||--o{ PAYMENTS : has_attempts
  USERS ||--o{ SESSIONS : owns
  SESSIONS o|--o| SESSIONS : rotates_to
  USERS ||--o{ MFA_FACTORS : enrolls
  USERS o|--o{ IDEMPOTENCY_RECORDS : scopes
  USERS o|--o{ AUDIT_LOGS : acts_in
```

Important cardinality nuance: one availability slot may have many historical cancelled consultations, but the partial unique index permits at most one consultation whose status is not `cancelled`.
