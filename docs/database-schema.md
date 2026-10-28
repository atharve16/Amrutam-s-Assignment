# Database schema — Milestone 2

This is the schema implemented by migrations `002`–`004`. It maps the assignment's identity, doctor availability, booking, consultation, prescription, payment, audit, idempotency, and async-work requirements without implementing their APIs.

## Requirements-to-schema mapping

| Requirement                     | Tables and invariant                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User lifecycle, roles, MFA      | `users`, `profiles`, `sessions`, `mfa_factors`; canonical contacts, server-controlled role/status checks, hashed refresh tokens, encrypted MFA secret storage |
| Doctor profile and verification | `doctors`; one doctor per user, jurisdiction/license uniqueness, explicit verification state                                                                  |
| Availability/search             | `availability_slots`; UTC-aware ranges, GiST overlap exclusion, doctor/time partial index                                                                     |
| Booking/concurrency             | `consultations`; composite slot snapshot FK and one-non-cancelled-consultation partial unique index                                                           |
| Consultation lifecycle          | `consultations`; state/timestamp check and patient/doctor history indexes                                                                                     |
| Prescriptions                   | `prescriptions`, `prescription_items`; assigned-doctor composite FK and version/current-issued constraints                                                    |
| Payments                        | `payments`; many attempts per consultation, exact amount, provider reference uniqueness, lifecycle timestamp checks                                           |
| Idempotent writes               | `idempotency_records`; authenticated/anonymous scope uniqueness and request fingerprints                                                                      |
| Compliance/audit                | `audit_logs`; actor/resource/time indexes and mutation-rejection trigger                                                                                      |
| Reliable async work             | `outbox_events`; transactionally inserted events and pending/stale-worker indexes                                                                             |
| Migration safety                | `schema_migrations`; immutable filename/checksum history owned by the existing runner                                                                         |

## Identity and professional records

### `users`

| Column              | PostgreSQL type | Null/default                  | Meaning                         |
| ------------------- | --------------- | ----------------------------- | ------------------------------- |
| `id`                | `uuid`          | not null, `gen_random_uuid()` | Primary key                     |
| `email`             | `text`          | nullable                      | Canonical lower-case email      |
| `phone_e164`        | `text`          | nullable                      | Canonical E.164 phone           |
| `password_hash`     | `text`          | not null                      | Future Argon2id encoded hash    |
| `role`              | `text`          | not null, `patient`           | `patient`, `doctor`, or `admin` |
| `status`            | `text`          | not null, `pending`           | Account lifecycle state         |
| `email_verified_at` | `timestamptz`   | nullable                      | Email verification event time   |
| `phone_verified_at` | `timestamptz`   | nullable                      | Phone verification event time   |
| `deactivated_at`    | `timestamptz`   | nullable                      | Required only for `deactivated` |
| `created_at`        | `timestamptz`   | not null, `now()`             | Creation event                  |
| `updated_at`        | `timestamptz`   | not null, `now()`             | Maintained by trigger           |

Checks require at least one contact, canonical/length-limited email, E.164 phone shape, verification only for a present contact, recognized role/status, and consistent deactivation state. Partial unique indexes independently protect non-null email and phone. Account removal is not the normal lifecycle; `deactivated` preserves references.

### `profiles`

| Column       | PostgreSQL type | Null/default      | Meaning                                                    |
| ------------ | --------------- | ----------------- | ---------------------------------------------------------- |
| `user_id`    | `uuid`          | not null          | Primary key and FK to `users(id)` with `ON DELETE CASCADE` |
| `full_name`  | `text`          | not null          | Minimal display/legal name, 1–200 characters               |
| `timezone`   | `text`          | not null, `UTC`   | IANA presentation zone, service-validated                  |
| `created_at` | `timestamptz`   | not null, `now()` | Creation event                                             |
| `updated_at` | `timestamptz`   | not null, `now()` | Maintained by trigger                                      |

This is a zero-or-one profile per user. Medical history, address, gender, and date of birth are not collected because the assignment does not require them.

### `doctors`

| Column                     | PostgreSQL type | Null/default        | Meaning                                             |
| -------------------------- | --------------- | ------------------- | --------------------------------------------------- |
| `id`                       | `uuid`          | not null, generated | Primary key                                         |
| `user_id`                  | `uuid`          | not null            | Unique FK to `users`, `RESTRICT`                    |
| `license_number`           | `text`          | not null            | Canonical upper-case professional number            |
| `license_jurisdiction`     | `text`          | not null            | Canonical upper-case issuer/region                  |
| `specialization`           | `text`          | not null            | Searchable professional specialization              |
| `bio`                      | `text`          | nullable            | Optional public biography, at most 2,000 characters |
| `verification_status`      | `text`          | not null, `pending` | `pending`, `verified`, `rejected`, `suspended`      |
| `verified_by`              | `uuid`          | nullable            | Reviewer FK to `users`, `SET NULL`                  |
| `verified_at`              | `timestamptz`   | nullable            | Verification event time                             |
| `created_at`, `updated_at` | `timestamptz`   | not null, `now()`   | Lifecycle timestamps                                |

`(license_jurisdiction, license_number)` is unique, and a user can own only one doctor row. Verified and subsequently suspended rows retain the verification timestamp; the service supplies a reviewer, but `verified_by` can later become null through its documented deletion policy. Pending/rejected rows have no reviewer or verification timestamp. The admin-only service promotes the account role and records the authenticated reviewer in the same transaction; a foreign key alone cannot express either rule.

## Scheduling and consultations

### `availability_slots`

| Column                     | PostgreSQL type | Null/default        | Meaning                           |
| -------------------------- | --------------- | ------------------- | --------------------------------- |
| `id`                       | `uuid`          | not null, generated | Primary key                       |
| `doctor_id`                | `uuid`          | not null            | FK to `doctors`, `RESTRICT`       |
| `starts_at`, `ends_at`     | `timestamptz`   | not null            | Half-open UTC-aware interval      |
| `status`                   | `text`          | not null, `open`    | `open`, `blocked`, `cancelled`    |
| `cancelled_at`             | `timestamptz`   | nullable            | Required only for cancelled slots |
| `created_at`, `updated_at` | `timestamptz`   | not null, `now()`   | Lifecycle timestamps              |

`ends_at > starts_at`. A GiST exclusion constraint rejects overlapping `[start,end)` ranges for the same doctor while either row is `open` or `blocked`; cancelled history does not block a replacement. A doctor/start index restricted to open rows supports availability searches. A composite unique key on `(id, doctor_id, starts_at, ends_at)` supports consultation snapshot integrity.

Allowed service transitions are `open → blocked/cancelled` and `blocked → open/cancelled`. Cancellation is terminal. A slot with a non-cancelled consultation must first have that consultation cancelled before the slot changes away from open.

### `consultations`

| Column                                   | PostgreSQL type | Null/default          | Meaning                                                     |
| ---------------------------------------- | --------------- | --------------------- | ----------------------------------------------------------- |
| `id`                                     | `uuid`          | not null, generated   | Primary key                                                 |
| `patient_id`                             | `uuid`          | not null              | FK to `users`, `RESTRICT`                                   |
| `doctor_id`                              | `uuid`          | not null              | FK to `doctors`, `RESTRICT`                                 |
| `slot_id`                                | `uuid`          | not null              | Part of composite FK to exact slot/doctor/times, `RESTRICT` |
| `scheduled_start_at`, `scheduled_end_at` | `timestamptz`   | not null              | Immutable scheduled snapshot                                |
| `status`                                 | `text`          | not null, `scheduled` | Consultation lifecycle                                      |
| `started_at`, `completed_at`             | `timestamptz`   | nullable              | Actual lifecycle events                                     |
| `cancelled_at`                           | `timestamptz`   | nullable              | Cancellation event                                          |
| `cancelled_by`                           | `uuid`          | nullable              | Actor FK to `users`, `SET NULL`                             |
| `cancellation_reason`                    | `text`          | nullable              | Safe reason, at most 500 characters                         |
| `created_at`, `updated_at`               | `timestamptz`   | not null, `now()`     | Lifecycle timestamps                                        |

The state check requires: scheduled rows have no terminal/started timestamps; in-progress rows have only `started_at`; completed rows have ordered start/completion timestamps; cancelled rows have `cancelled_at`; no-show rows have none of those event timestamps. Cancellation actor/reason can exist only on cancelled rows.

The partial unique index on `slot_id WHERE status <> 'cancelled'` permits many cancelled historical attempts but only one non-cancelled booking. Only cancellation releases a slot. Patient and doctor indexes order histories by scheduled time. `(id, doctor_id)` is unique for the prescription-author FK.

Service transitions are `scheduled → in_progress/completed/cancelled/no_show` and `in_progress → completed/cancelled`. Terminal states do not reopen. PostgreSQL validates the resulting state and uniqueness; the implemented service validates role, ownership, and transitions and maps booking uniqueness conflicts to HTTP 409.

## Clinical and payment records

### `prescriptions`

| Column                     | PostgreSQL type | Null/default        | Meaning                                                     |
| -------------------------- | --------------- | ------------------- | ----------------------------------------------------------- |
| `id`                       | `uuid`          | not null, generated | Primary key                                                 |
| `consultation_id`          | `uuid`          | not null            | Composite FK with author doctor to consultation, `RESTRICT` |
| `doctor_id`                | `uuid`          | not null            | Must equal consultation doctor                              |
| `version`                  | `integer`       | not null, `1`       | Positive per-consultation version                           |
| `supersedes_id`            | `uuid`          | nullable            | Same-consultation predecessor, `RESTRICT`                   |
| `status`                   | `text`          | not null, `draft`   | `draft`, `issued`, `void`                                   |
| `clinical_notes`           | `text`          | nullable            | Minimal sensitive note, at most 4,000 characters            |
| `issued_at`, `voided_at`   | `timestamptz`   | nullable            | Status event timestamps                                     |
| `created_at`, `updated_at` | `timestamptz`   | not null, `now()`   | Lifecycle timestamps                                        |

`(consultation_id, version)` is unique. At most one version per consultation may have `issued` status. Draft has no issue/void timestamp, issued requires only `issued_at`, and void requires both. The self composite FK ensures a successor references a prescription from the same consultation.

### `prescription_items`

| Column                            | PostgreSQL type | Null/default        | Meaning                                                   |
| --------------------------------- | --------------- | ------------------- | --------------------------------------------------------- |
| `id`                              | `uuid`          | not null, generated | Primary key                                               |
| `prescription_id`                 | `uuid`          | not null            | FK to `prescriptions`, `RESTRICT`                         |
| `medication_name`                 | `text`          | not null            | 1–300 characters                                          |
| `dosage`, `frequency`, `duration` | `text`          | not null            | Structured human-readable directions with bounded lengths |
| `instructions`                    | `text`          | nullable            | Optional instructions, at most 1,000 characters           |
| `created_at`, `updated_at`        | `timestamptz`   | not null, `now()`   | Lifecycle timestamps                                      |

The database structures medication lines but does not attempt to validate drug catalogs or medical correctness.

### `payments`

| Column                      | PostgreSQL type | Null/default        | Meaning                           |
| --------------------------- | --------------- | ------------------- | --------------------------------- |
| `id`                        | `uuid`          | not null, generated | Payment-attempt primary key       |
| `consultation_id`           | `uuid`          | not null            | FK to `consultations`, `RESTRICT` |
| `amount`                    | `numeric(12,2)` | not null            | Positive exact amount             |
| `currency`                  | `char(3)`       | not null            | Uppercase three-letter code       |
| `status`                    | `text`          | not null, `created` | Provider-independent lifecycle    |
| `provider`                  | `text`          | nullable            | Future provider name              |
| `provider_reference`        | `text`          | nullable            | Future provider identifier        |
| `failure_code`              | `text`          | nullable            | Safe provider-independent code    |
| `settled_at`, `refunded_at` | `timestamptz`   | nullable            | Success/refund event times        |
| `created_at`, `updated_at`  | `timestamptz`   | not null, `now()`   | Lifecycle timestamps              |

The provider/reference pair is unique when both exist. Succeeded rows require `settled_at`; refunded rows require ordered settled/refunded timestamps; other states have neither. Failure codes are accepted only for `failed`. The schema supports multiple attempts and does not claim real payment processing.

## Security and reliability support

### `sessions`

| Column              | PostgreSQL type | Null/default        | Meaning                                                                 |
| ------------------- | --------------- | ------------------- | ----------------------------------------------------------------------- |
| `id`                | `uuid`          | not null, generated | Session/rotation primary key                                            |
| `user_id`           | `uuid`          | not null            | FK to `users`, `CASCADE`                                                |
| `token_family_id`   | `uuid`          | not null, generated | Rotation/reuse-detection family                                         |
| `parent_session_id` | `uuid`          | nullable, unique    | Prior rotation row; deletion cascades through its ephemeral descendants |
| `token_hash`        | `bytea`         | not null, unique    | Cryptographic refresh-token hash                                        |
| `status`            | `text`          | not null, `active`  | Rotation/revocation state                                               |
| `expires_at`        | `timestamptz`   | not null            | Expiration event                                                        |
| `last_used_at`      | `timestamptz`   | nullable            | Last successful refresh                                                 |
| `terminal_at`       | `timestamptz`   | nullable            | Required for non-active states                                          |
| `created_at`        | `timestamptz`   | not null, `now()`   | Creation event                                                          |

One active row per token family is enforced by a partial unique index. A composite self foreign key guarantees that a rotated child has the same user and token family as its parent. Active-session cleanup/search uses `(user_id, expires_at)`. Raw bearer tokens and request metadata are not stored.

### `mfa_factors`

| Column                       | PostgreSQL type | Null/default        | Meaning                       |
| ---------------------------- | --------------- | ------------------- | ----------------------------- |
| `id`                         | `uuid`          | not null, generated | Factor primary key            |
| `user_id`                    | `uuid`          | not null            | FK to `users`, `CASCADE`      |
| `factor_type`                | `text`          | not null, `totp`    | Currently only `totp`         |
| `secret_ciphertext`          | `bytea`         | not null            | Application-encrypted secret  |
| `encryption_key_version`     | `smallint`      | not null            | Positive external key version |
| `status`                     | `text`          | not null, `pending` | Enrollment state              |
| `confirmed_at`, `revoked_at` | `timestamptz`   | nullable            | State events                  |
| `last_used_time_step`        | `bigint`        | nullable            | TOTP replay guard             |
| `created_at`                 | `timestamptz`   | not null, `now()`   | Creation event                |

Only one pending/active TOTP factor is allowed per user. State/timestamp checks prevent an unconfirmed active factor or unmarked revocation.

### `idempotency_records`

| Column                         | PostgreSQL type | Null/default           | Meaning                                    |
| ------------------------------ | --------------- | ---------------------- | ------------------------------------------ |
| `id`                           | `uuid`          | not null, generated    | Primary key                                |
| `actor_id`                     | `uuid`          | nullable               | Authenticated scope FK to users, `CASCADE` |
| `anonymous_scope_hash`         | `bytea`         | nullable               | Exactly 32-byte anonymous scope            |
| `operation`                    | `text`          | not null               | Stable operation identifier                |
| `idempotency_key`              | `text`          | not null               | Client key, 1–200 characters               |
| `request_fingerprint`          | `char(64)`      | not null               | Lowercase SHA-256 hex                      |
| `status`                       | `text`          | not null, `processing` | Processing/result state                    |
| `response_status`              | `smallint`      | nullable               | Safe replay HTTP status                    |
| `response_body`                | `jsonb`         | nullable               | Minimal replay-safe JSON object            |
| `resource_type`, `resource_id` | `text`, `uuid`  | nullable               | Optional resulting resource                |
| `expires_at`                   | `timestamptz`   | not null               | Cleanup boundary                           |
| `created_at`, `updated_at`     | `timestamptz`   | not null, `now()`      | Lifecycle timestamps                       |

Exactly one of actor or anonymous scope is required. Two partial unique indexes enforce the respective `(scope, operation, key)`. State checks require processing rows to have no response and terminal rows to have one. An expiry index supports bounded cleanup.

### `audit_logs`

| Column          | PostgreSQL type   | Null/default      | Meaning                                                |
| --------------- | ----------------- | ----------------- | ------------------------------------------------------ |
| `id`            | `bigint identity` | not null          | Primary key                                            |
| `actor_id`      | `uuid`            | nullable          | User actor FK, `SET NULL`; null means system/anonymous |
| `action`        | `text`            | not null          | Stable security/business action                        |
| `resource_type` | `text`            | not null          | Resource namespace                                     |
| `resource_id`   | `uuid`            | nullable          | Generic resource identifier                            |
| `request_id`    | `text`            | nullable          | Correlation ID, at most 128 characters                 |
| `metadata`      | `jsonb`           | not null, `{}`    | Non-sensitive object only                              |
| `occurred_at`   | `timestamptz`     | not null, `now()` | Event time                                             |

Indexes support reverse-time global, actor, and resource searches. A trigger rejects update/delete operations except the exact actor-nulling update required by `ON DELETE SET NULL`. Least-privilege grants must prevent callers from invoking that exception directly. The trigger does not stop a database owner from bypassing it.

### `outbox_events`

| Column                           | PostgreSQL type       | Null/default        | Meaning                             |
| -------------------------------- | --------------------- | ------------------- | ----------------------------------- |
| `id`                             | `uuid`                | not null, generated | Event primary key                   |
| `event_type`                     | `text`                | not null            | Versioned event name                |
| `aggregate_type`, `aggregate_id` | `text`, `uuid`        | not null            | Owning resource reference           |
| `deduplication_key`              | `text`                | nullable, unique    | Optional producer deduplication key |
| `payload`                        | `jsonb`               | not null            | Minimal JSON object                 |
| `status`                         | `text`                | not null, `pending` | Delivery state                      |
| `attempt_count`                  | `integer`             | not null, `0`       | Non-negative delivery attempts      |
| `next_attempt_at`                | `timestamptz`         | not null, `now()`   | Claim eligibility                   |
| `locked_at`, `locked_by`         | `timestamptz`, `text` | nullable            | Processing lease                    |
| `processed_at`                   | `timestamptz`         | nullable            | Delivery completion                 |
| `last_error`                     | `text`                | nullable            | Sanitized bounded failure text      |
| `created_at`                     | `timestamptz`         | not null, `now()`   | Creation event                      |

State checks align leases and processed timestamps. A partial `(next_attempt_at, created_at)` index supports pending claims; another on `locked_at` supports stale-processing recovery. Events are inserted in the same transaction as the aggregate and are not automatically processed in this milestone.

## Migration metadata

`schema_migrations` is bootstrapped by `scripts/migrate.ts` before migration `001`. It stores `filename text` primary key, SHA-256 `checksum text`, `applied_at timestamptz`, and non-negative `duration_ms integer`. The runner takes one session advisory lock, validates existing checksums/files, and records a file only in the same transaction as its successful SQL.

## Index rationale summary

| Index/access path                             | Purpose                                         |
| --------------------------------------------- | ----------------------------------------------- |
| Users email/phone partial unique              | Canonical login lookup and duplicate prevention |
| Verified doctor specialization                | Public verified-doctor search                   |
| Open slot doctor/start partial                | Doctor/date availability scans                  |
| Availability GiST exclusion                   | Database-level schedule overlap rejection       |
| Consultation slot partial unique              | Atomic double-booking prevention                |
| Patient/doctor scheduled time                 | Paginated consultation histories                |
| Prescription consultation/version             | Version lookup and uniqueness                   |
| Payment consultation/time and provider unique | Attempt history and reconciliation              |
| Active session user/expiry and family unique  | Refresh, cleanup, and one-live-token rotation   |
| Idempotency scope unique and expiry           | Retry coordination and cleanup                  |
| Audit time/actor/resource                     | Protected administrative investigations         |
| Outbox pending/stale partial                  | `SKIP LOCKED` worker claims and crash recovery  |

Detailed alternatives, transitions, transaction boundaries, deletion choices, capacity, and retention assumptions are in [database-decisions.md](database-decisions.md).
