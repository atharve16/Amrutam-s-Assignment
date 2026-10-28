-- Milestone 2, stage 1: identities, professional profiles, and discrete availability.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE FUNCTION amrutam_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  phone_e164 text,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'patient',
  status text NOT NULL DEFAULT 'pending',
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  deactivated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_users_contact_required CHECK (email IS NOT NULL OR phone_e164 IS NOT NULL),
  CONSTRAINT ck_users_email_canonical CHECK (
    email IS NULL OR (
      email = lower(btrim(email))
      AND char_length(email) BETWEEN 3 AND 254
      AND email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    )
  ),
  CONSTRAINT ck_users_phone_e164 CHECK (
    phone_e164 IS NULL OR phone_e164 ~ '^[+][1-9][0-9]{7,14}$'
  ),
  CONSTRAINT ck_users_password_hash CHECK (char_length(password_hash) BETWEEN 20 AND 500),
  CONSTRAINT ck_users_role CHECK (role IN ('patient', 'doctor', 'admin')),
  CONSTRAINT ck_users_status CHECK (status IN ('pending', 'active', 'suspended', 'deactivated')),
  CONSTRAINT ck_users_email_verification CHECK (email_verified_at IS NULL OR email IS NOT NULL),
  CONSTRAINT ck_users_phone_verification CHECK (
    phone_verified_at IS NULL OR phone_e164 IS NOT NULL
  ),
  CONSTRAINT ck_users_deactivation CHECK (
    (status = 'deactivated') = (deactivated_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uq_users_email ON users (email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX uq_users_phone_e164 ON users (phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE INDEX idx_users_status_created_at ON users (status, created_at DESC);

CREATE TRIGGER trg_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION amrutam_set_updated_at();

CREATE TABLE profiles (
  user_id uuid PRIMARY KEY,
  full_name text NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_profiles_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT ck_profiles_full_name CHECK (char_length(btrim(full_name)) BETWEEN 1 AND 200),
  CONSTRAINT ck_profiles_timezone CHECK (char_length(btrim(timezone)) BETWEEN 1 AND 100)
);

CREATE TRIGGER trg_profiles_updated_at
BEFORE UPDATE ON profiles
FOR EACH ROW EXECUTE FUNCTION amrutam_set_updated_at();

CREATE TABLE doctors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  license_number text NOT NULL,
  license_jurisdiction text NOT NULL,
  specialization text NOT NULL,
  bio text,
  verification_status text NOT NULL DEFAULT 'pending',
  verified_by uuid,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_doctors_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_doctors_verified_by FOREIGN KEY (verified_by)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT uq_doctors_license UNIQUE (license_jurisdiction, license_number),
  CONSTRAINT ck_doctors_license_number CHECK (
    license_number = upper(btrim(license_number))
    AND char_length(license_number) BETWEEN 2 AND 100
  ),
  CONSTRAINT ck_doctors_license_jurisdiction CHECK (
    license_jurisdiction = upper(btrim(license_jurisdiction))
    AND char_length(license_jurisdiction) BETWEEN 2 AND 100
  ),
  CONSTRAINT ck_doctors_specialization CHECK (
    char_length(btrim(specialization)) BETWEEN 2 AND 200
  ),
  CONSTRAINT ck_doctors_bio CHECK (bio IS NULL OR char_length(bio) <= 2000),
  CONSTRAINT ck_doctors_verification_status CHECK (
    verification_status IN ('pending', 'verified', 'rejected', 'suspended')
  ),
  CONSTRAINT ck_doctors_verification_state CHECK (
    (
      verification_status IN ('verified', 'suspended')
      AND verified_at IS NOT NULL
    ) OR (
      verification_status IN ('pending', 'rejected')
      AND verified_at IS NULL
      AND verified_by IS NULL
    )
  )
);

CREATE INDEX idx_doctors_verified_specialization
  ON doctors (specialization, created_at DESC)
  WHERE verification_status = 'verified';

CREATE TRIGGER trg_doctors_updated_at
BEFORE UPDATE ON doctors
FOR EACH ROW EXECUTE FUNCTION amrutam_set_updated_at();

CREATE TABLE availability_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open',
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_availability_slots_doctor FOREIGN KEY (doctor_id)
    REFERENCES doctors (id) ON DELETE RESTRICT,
  CONSTRAINT uq_availability_slot_snapshot UNIQUE (id, doctor_id, starts_at, ends_at),
  CONSTRAINT ck_availability_slots_time CHECK (ends_at > starts_at),
  CONSTRAINT ck_availability_slots_status CHECK (status IN ('open', 'blocked', 'cancelled')),
  CONSTRAINT ck_availability_slots_cancellation CHECK (
    (status = 'cancelled') = (cancelled_at IS NOT NULL)
  ),
  CONSTRAINT ex_availability_slots_doctor_time EXCLUDE USING gist (
    doctor_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status IN ('open', 'blocked'))
);

CREATE INDEX idx_availability_slots_open_doctor_start
  ON availability_slots (doctor_id, starts_at)
  INCLUDE (ends_at)
  WHERE status = 'open';

CREATE TRIGGER trg_availability_slots_updated_at
BEFORE UPDATE ON availability_slots
FOR EACH ROW EXECUTE FUNCTION amrutam_set_updated_at();
