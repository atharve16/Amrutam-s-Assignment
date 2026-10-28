-- Milestone 2, stage 2: booking history, clinical prescriptions, and payment attempts.
CREATE TABLE consultations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL,
  doctor_id uuid NOT NULL,
  slot_id uuid NOT NULL,
  scheduled_start_at timestamptz NOT NULL,
  scheduled_end_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled',
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_consultations_patient FOREIGN KEY (patient_id)
    REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_consultations_doctor FOREIGN KEY (doctor_id)
    REFERENCES doctors (id) ON DELETE RESTRICT,
  CONSTRAINT fk_consultations_slot_snapshot FOREIGN KEY (
    slot_id, doctor_id, scheduled_start_at, scheduled_end_at
  ) REFERENCES availability_slots (id, doctor_id, starts_at, ends_at) ON DELETE RESTRICT,
  CONSTRAINT fk_consultations_cancelled_by FOREIGN KEY (cancelled_by)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT uq_consultations_id_doctor UNIQUE (id, doctor_id),
  CONSTRAINT ck_consultations_scheduled_time CHECK (scheduled_end_at > scheduled_start_at),
  CONSTRAINT ck_consultations_status CHECK (
    status IN ('scheduled', 'in_progress', 'completed', 'cancelled', 'no_show')
  ),
  CONSTRAINT ck_consultations_cancellation_reason CHECK (
    cancellation_reason IS NULL
    OR char_length(btrim(cancellation_reason)) BETWEEN 1 AND 500
  ),
  CONSTRAINT ck_consultations_cancellation_actor CHECK (
    status = 'cancelled' OR (cancelled_by IS NULL AND cancellation_reason IS NULL)
  ),
  CONSTRAINT ck_consultations_lifecycle CHECK (
    (
      status = 'scheduled'
      AND started_at IS NULL
      AND completed_at IS NULL
      AND cancelled_at IS NULL
    ) OR (
      status = 'in_progress'
      AND started_at IS NOT NULL
      AND completed_at IS NULL
      AND cancelled_at IS NULL
    ) OR (
      status = 'completed'
      AND started_at IS NOT NULL
      AND completed_at IS NOT NULL
      AND completed_at >= started_at
      AND cancelled_at IS NULL
    ) OR (
      status = 'cancelled'
      AND completed_at IS NULL
      AND cancelled_at IS NOT NULL
      AND (started_at IS NULL OR cancelled_at >= started_at)
    ) OR (
      status = 'no_show'
      AND started_at IS NULL
      AND completed_at IS NULL
      AND cancelled_at IS NULL
    )
  )
);

-- Cancelled rows remain historical but no longer occupy the slot.
CREATE UNIQUE INDEX uq_consultations_one_non_cancelled_per_slot
  ON consultations (slot_id)
  WHERE status <> 'cancelled';

CREATE INDEX idx_consultations_patient_scheduled
  ON consultations (patient_id, scheduled_start_at DESC, id);
CREATE INDEX idx_consultations_doctor_scheduled
  ON consultations (doctor_id, scheduled_start_at DESC, id);

CREATE TRIGGER trg_consultations_updated_at
BEFORE UPDATE ON consultations
FOR EACH ROW EXECUTE FUNCTION amrutam_set_updated_at();

CREATE TABLE prescriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL,
  doctor_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1,
  supersedes_id uuid,
  status text NOT NULL DEFAULT 'draft',
  clinical_notes text,
  issued_at timestamptz,
  voided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_prescriptions_consultation_version UNIQUE (consultation_id, version),
  CONSTRAINT uq_prescriptions_id_consultation UNIQUE (id, consultation_id),
  CONSTRAINT fk_prescriptions_consultation_doctor FOREIGN KEY (consultation_id, doctor_id)
    REFERENCES consultations (id, doctor_id) ON DELETE RESTRICT,
  CONSTRAINT fk_prescriptions_supersedes_same_consultation FOREIGN KEY (
    supersedes_id, consultation_id
  ) REFERENCES prescriptions (id, consultation_id) ON DELETE RESTRICT,
  CONSTRAINT ck_prescriptions_version CHECK (version > 0),
  CONSTRAINT ck_prescriptions_not_self_superseding CHECK (
    supersedes_id IS NULL OR supersedes_id <> id
  ),
  CONSTRAINT ck_prescriptions_status CHECK (status IN ('draft', 'issued', 'void')),
  CONSTRAINT ck_prescriptions_notes CHECK (
    clinical_notes IS NULL OR char_length(clinical_notes) <= 4000
  ),
  CONSTRAINT ck_prescriptions_lifecycle CHECK (
    (
      status = 'draft'
      AND issued_at IS NULL
      AND voided_at IS NULL
    ) OR (
      status = 'issued'
      AND issued_at IS NOT NULL
      AND voided_at IS NULL
    ) OR (
      status = 'void'
      AND issued_at IS NOT NULL
      AND voided_at IS NOT NULL
      AND voided_at >= issued_at
    )
  )
);

CREATE UNIQUE INDEX uq_prescriptions_one_issued_per_consultation
  ON prescriptions (consultation_id)
  WHERE status = 'issued';

CREATE TRIGGER trg_prescriptions_updated_at
BEFORE UPDATE ON prescriptions
FOR EACH ROW EXECUTE FUNCTION amrutam_set_updated_at();

CREATE TABLE prescription_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prescription_id uuid NOT NULL,
  medication_name text NOT NULL,
  dosage text NOT NULL,
  frequency text NOT NULL,
  duration text NOT NULL,
  instructions text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_prescription_items_prescription FOREIGN KEY (prescription_id)
    REFERENCES prescriptions (id) ON DELETE RESTRICT,
  CONSTRAINT ck_prescription_items_medication CHECK (
    char_length(btrim(medication_name)) BETWEEN 1 AND 300
  ),
  CONSTRAINT ck_prescription_items_dosage CHECK (
    char_length(btrim(dosage)) BETWEEN 1 AND 200
  ),
  CONSTRAINT ck_prescription_items_frequency CHECK (
    char_length(btrim(frequency)) BETWEEN 1 AND 200
  ),
  CONSTRAINT ck_prescription_items_duration CHECK (
    char_length(btrim(duration)) BETWEEN 1 AND 200
  ),
  CONSTRAINT ck_prescription_items_instructions CHECK (
    instructions IS NULL OR char_length(instructions) <= 1000
  )
);

CREATE INDEX idx_prescription_items_prescription
  ON prescription_items (prescription_id, created_at, id);

CREATE TRIGGER trg_prescription_items_updated_at
BEFORE UPDATE ON prescription_items
FOR EACH ROW EXECUTE FUNCTION amrutam_set_updated_at();

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL,
  currency char(3) NOT NULL,
  status text NOT NULL DEFAULT 'created',
  provider text,
  provider_reference text,
  failure_code text,
  settled_at timestamptz,
  refunded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_payments_consultation FOREIGN KEY (consultation_id)
    REFERENCES consultations (id) ON DELETE RESTRICT,
  CONSTRAINT ck_payments_amount CHECK (amount > 0),
  CONSTRAINT ck_payments_currency CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT ck_payments_status CHECK (
    status IN ('created', 'pending', 'succeeded', 'failed', 'cancelled', 'refunded')
  ),
  CONSTRAINT ck_payments_provider CHECK (
    provider IS NULL OR char_length(btrim(provider)) BETWEEN 1 AND 100
  ),
  CONSTRAINT ck_payments_provider_reference CHECK (
    provider_reference IS NULL OR (
      provider IS NOT NULL
      AND char_length(btrim(provider_reference)) BETWEEN 1 AND 200
    )
  ),
  CONSTRAINT ck_payments_failure_code CHECK (
    failure_code IS NULL OR (
      status = 'failed'
      AND char_length(btrim(failure_code)) BETWEEN 1 AND 100
    )
  ),
  CONSTRAINT ck_payments_lifecycle CHECK (
    (
      status IN ('created', 'pending', 'failed', 'cancelled')
      AND settled_at IS NULL
      AND refunded_at IS NULL
    ) OR (
      status = 'succeeded'
      AND settled_at IS NOT NULL
      AND refunded_at IS NULL
    ) OR (
      status = 'refunded'
      AND settled_at IS NOT NULL
      AND refunded_at IS NOT NULL
      AND refunded_at >= settled_at
    )
  )
);

CREATE UNIQUE INDEX uq_payments_provider_reference
  ON payments (provider, provider_reference)
  WHERE provider IS NOT NULL AND provider_reference IS NOT NULL;
CREATE INDEX idx_payments_consultation_created
  ON payments (consultation_id, created_at DESC, id);

CREATE TRIGGER trg_payments_updated_at
BEFORE UPDATE ON payments
FOR EACH ROW EXECUTE FUNCTION amrutam_set_updated_at();
