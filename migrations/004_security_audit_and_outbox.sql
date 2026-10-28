-- Milestone 2, stage 3: secure sessions, MFA, idempotency, audit, and outbox.
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  token_family_id uuid NOT NULL DEFAULT gen_random_uuid(),
  parent_session_id uuid UNIQUE,
  token_hash bytea NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active',
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  terminal_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT uq_sessions_identity_family UNIQUE (id, user_id, token_family_id),
  CONSTRAINT fk_sessions_parent_family FOREIGN KEY (
    parent_session_id, user_id, token_family_id
  ) REFERENCES sessions (id, user_id, token_family_id) ON DELETE CASCADE,
  CONSTRAINT ck_sessions_token_hash CHECK (octet_length(token_hash) = 32),
  CONSTRAINT ck_sessions_status CHECK (status IN ('active', 'rotated', 'revoked', 'compromised')),
  CONSTRAINT ck_sessions_expiry CHECK (expires_at > created_at),
  CONSTRAINT ck_sessions_last_used CHECK (last_used_at IS NULL OR last_used_at >= created_at),
  CONSTRAINT ck_sessions_lifecycle CHECK (
    (status = 'active' AND terminal_at IS NULL)
    OR (status <> 'active' AND terminal_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uq_sessions_one_active_per_family
  ON sessions (token_family_id)
  WHERE status = 'active';
CREATE INDEX idx_sessions_active_user_expiry
  ON sessions (user_id, expires_at)
  WHERE status = 'active';
CREATE INDEX idx_sessions_family_created
  ON sessions (token_family_id, created_at DESC);

CREATE TABLE mfa_factors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  factor_type text NOT NULL DEFAULT 'totp',
  secret_ciphertext bytea NOT NULL,
  encryption_key_version smallint NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  confirmed_at timestamptz,
  revoked_at timestamptz,
  last_used_time_step bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_mfa_factors_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT ck_mfa_factors_type CHECK (factor_type IN ('totp')),
  CONSTRAINT ck_mfa_factors_ciphertext CHECK (octet_length(secret_ciphertext) >= 16),
  CONSTRAINT ck_mfa_factors_key_version CHECK (encryption_key_version > 0),
  CONSTRAINT ck_mfa_factors_status CHECK (status IN ('pending', 'active', 'revoked')),
  CONSTRAINT ck_mfa_factors_time_step CHECK (
    last_used_time_step IS NULL OR last_used_time_step >= 0
  ),
  CONSTRAINT ck_mfa_factors_lifecycle CHECK (
    (
      status = 'pending'
      AND confirmed_at IS NULL
      AND revoked_at IS NULL
    ) OR (
      status = 'active'
      AND confirmed_at IS NOT NULL
      AND revoked_at IS NULL
    ) OR (
      status = 'revoked'
      AND revoked_at IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX uq_mfa_factors_one_current_type
  ON mfa_factors (user_id, factor_type)
  WHERE status IN ('pending', 'active');

CREATE TABLE idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid,
  anonymous_scope_hash bytea,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint char(64) NOT NULL,
  status text NOT NULL DEFAULT 'processing',
  response_status smallint,
  response_body jsonb,
  resource_type text,
  resource_id uuid,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_idempotency_records_actor FOREIGN KEY (actor_id)
    REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT ck_idempotency_records_scope CHECK (
    (actor_id IS NOT NULL) <> (anonymous_scope_hash IS NOT NULL)
  ),
  CONSTRAINT ck_idempotency_records_anonymous_hash CHECK (
    anonymous_scope_hash IS NULL OR octet_length(anonymous_scope_hash) = 32
  ),
  CONSTRAINT ck_idempotency_records_operation CHECK (
    char_length(btrim(operation)) BETWEEN 1 AND 100
  ),
  CONSTRAINT ck_idempotency_records_key CHECK (
    char_length(idempotency_key) BETWEEN 1 AND 200
  ),
  CONSTRAINT ck_idempotency_records_fingerprint CHECK (
    request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ck_idempotency_records_status CHECK (
    status IN ('processing', 'completed', 'failed')
  ),
  CONSTRAINT ck_idempotency_records_response_body CHECK (
    response_body IS NULL OR jsonb_typeof(response_body) = 'object'
  ),
  CONSTRAINT ck_idempotency_records_resource CHECK (
    (resource_type IS NULL) = (resource_id IS NULL)
  ),
  CONSTRAINT ck_idempotency_records_expiry CHECK (expires_at > created_at),
  CONSTRAINT ck_idempotency_records_lifecycle CHECK (
    (
      status = 'processing'
      AND response_status IS NULL
      AND response_body IS NULL
      AND resource_id IS NULL
    ) OR (
      status = 'completed'
      AND response_status BETWEEN 100 AND 599
    ) OR (
      status = 'failed'
      AND response_status BETWEEN 100 AND 599
      AND resource_id IS NULL
    )
  )
);

CREATE UNIQUE INDEX uq_idempotency_authenticated_scope
  ON idempotency_records (actor_id, operation, idempotency_key)
  WHERE actor_id IS NOT NULL;
CREATE UNIQUE INDEX uq_idempotency_anonymous_scope
  ON idempotency_records (anonymous_scope_hash, operation, idempotency_key)
  WHERE actor_id IS NULL;
CREATE INDEX idx_idempotency_records_expiry ON idempotency_records (expires_at);

CREATE TRIGGER trg_idempotency_records_updated_at
BEFORE UPDATE ON idempotency_records
FOR EACH ROW EXECUTE FUNCTION amrutam_set_updated_at();

CREATE TABLE audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid,
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_audit_logs_actor FOREIGN KEY (actor_id)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ck_audit_logs_action CHECK (char_length(btrim(action)) BETWEEN 1 AND 100),
  CONSTRAINT ck_audit_logs_resource_type CHECK (
    char_length(btrim(resource_type)) BETWEEN 1 AND 100
  ),
  CONSTRAINT ck_audit_logs_request_id CHECK (
    request_id IS NULL OR char_length(request_id) BETWEEN 1 AND 128
  ),
  CONSTRAINT ck_audit_logs_metadata CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX idx_audit_logs_occurred_at ON audit_logs (occurred_at DESC, id DESC);
CREATE INDEX idx_audit_logs_actor_time
  ON audit_logs (actor_id, occurred_at DESC, id DESC)
  WHERE actor_id IS NOT NULL;
CREATE INDEX idx_audit_logs_resource_time
  ON audit_logs (resource_type, resource_id, occurred_at DESC, id DESC)
  WHERE resource_id IS NOT NULL;

CREATE FUNCTION amrutam_reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Permit only FK-driven actor anonymization. Production grants must still deny
  -- arbitrary UPDATE so callers cannot invoke this path themselves.
  IF TG_OP = 'UPDATE'
    AND OLD.actor_id IS NOT NULL
    AND NEW.actor_id IS NULL
    AND NEW.id = OLD.id
    AND NEW.action = OLD.action
    AND NEW.resource_type = OLD.resource_type
    AND NEW.resource_id IS NOT DISTINCT FROM OLD.resource_id
    AND NEW.request_id IS NOT DISTINCT FROM OLD.request_id
    AND NEW.metadata = OLD.metadata
    AND NEW.occurred_at = OLD.occurred_at
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$;

CREATE TRIGGER trg_audit_logs_append_only
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION amrutam_reject_audit_mutation();

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  deduplication_key text UNIQUE,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  processed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_outbox_events_event_type CHECK (
    char_length(btrim(event_type)) BETWEEN 1 AND 150
  ),
  CONSTRAINT ck_outbox_events_aggregate_type CHECK (
    char_length(btrim(aggregate_type)) BETWEEN 1 AND 100
  ),
  CONSTRAINT ck_outbox_events_deduplication_key CHECK (
    deduplication_key IS NULL OR char_length(deduplication_key) BETWEEN 1 AND 200
  ),
  CONSTRAINT ck_outbox_events_payload CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT ck_outbox_events_status CHECK (
    status IN ('pending', 'processing', 'processed', 'dead_letter')
  ),
  CONSTRAINT ck_outbox_events_attempt_count CHECK (attempt_count >= 0),
  CONSTRAINT ck_outbox_events_lock_pair CHECK ((locked_at IS NULL) = (locked_by IS NULL)),
  CONSTRAINT ck_outbox_events_locked_by CHECK (
    locked_by IS NULL OR char_length(btrim(locked_by)) BETWEEN 1 AND 200
  ),
  CONSTRAINT ck_outbox_events_last_error CHECK (
    last_error IS NULL OR char_length(last_error) <= 1000
  ),
  CONSTRAINT ck_outbox_events_lifecycle CHECK (
    (
      status = 'pending'
      AND locked_at IS NULL
      AND processed_at IS NULL
    ) OR (
      status = 'processing'
      AND locked_at IS NOT NULL
      AND processed_at IS NULL
    ) OR (
      status = 'processed'
      AND locked_at IS NULL
      AND processed_at IS NOT NULL
    ) OR (
      status = 'dead_letter'
      AND locked_at IS NULL
      AND processed_at IS NULL
    )
  )
);

CREATE INDEX idx_outbox_events_pending_claim
  ON outbox_events (next_attempt_at, created_at, id)
  WHERE status = 'pending';
CREATE INDEX idx_outbox_events_processing_recovery
  ON outbox_events (locked_at, id)
  WHERE status = 'processing';
CREATE INDEX idx_outbox_events_aggregate
  ON outbox_events (aggregate_type, aggregate_id, created_at DESC);
