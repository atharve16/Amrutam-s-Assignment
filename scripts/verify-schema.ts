import { strict as assert } from 'node:assert';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Client, QueryResultRow } from 'pg';
import { cleanupOwnedSchemas, createOwnedSchema, quoteIdentifier } from './schema-verifier-cleanup';

const EXPECTED_MIGRATION_COUNT = 4;
const EXPECTED_TABLES = [
  'audit_logs',
  'availability_slots',
  'consultations',
  'doctors',
  'idempotency_records',
  'mfa_factors',
  'outbox_events',
  'payments',
  'prescription_items',
  'prescriptions',
  'profiles',
  'sessions',
  'users',
];

interface IdRow extends QueryResultRow {
  id: string;
}

interface NameRow extends QueryResultRow {
  name: string;
}

interface ExtensionRow extends QueryResultRow {
  extname: string;
  schema_name: string;
}

interface HistoryRow extends QueryResultRow {
  filename: string;
  checksum: string;
  applied_at: Date;
}

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Environment variable ${name} is required`);
  return value;
}

function testSchemaName(label: string): string {
  return `amrutam_${label}_${randomBytes(16).toString('hex')}`;
}

function withSearchPath(databaseUrl: string, schemas: string[]): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schemas.join(',')}`);
  return url.toString();
}

function sslConfiguration(): false | { rejectUnauthorized: true } {
  return process.env.SCHEMA_TEST_DATABASE_SSL === 'false' ? false : { rejectUnauthorized: true };
}

function log(event: string, details: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ event, ...details })}\n`);
}

async function runMigration(
  databaseUrl: string,
  migrationsDirectory?: string,
): Promise<ProcessResult> {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(process.execPath, [resolve('dist/scripts/migrate.js')], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: databaseUrl,
        DATABASE_SSL: process.env.SCHEMA_TEST_DATABASE_SSL ?? 'true',
        ...(migrationsDirectory ? { MIGRATIONS_DIRECTORY: migrationsDirectory } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      rejectProcess(new Error('Migration process exceeded 90 seconds'));
    }, 90_000);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectProcess(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolveProcess({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function postgresCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

let savepointSequence = 0;

async function expectPostgresError(
  client: Client,
  expectedCode: string,
  text: string,
  values: readonly unknown[] = [],
): Promise<void> {
  savepointSequence += 1;
  const savepoint = `expected_error_${savepointSequence}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  let caught: unknown;
  try {
    await client.query(text, [...values]);
  } catch (error) {
    caught = error;
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  assert.ok(caught, `Expected PostgreSQL error ${expectedCode}`);
  assert.equal(postgresCode(caught), expectedCode);
}

async function prepareExtensionSchemas(
  adminClient: Client,
  temporarySchema: string,
  ownedSchemas: Set<string>,
): Promise<{ schemas: string[]; createdTemporarySchema: boolean }> {
  const result = await adminClient.query<ExtensionRow>(`
    SELECT extension.extname, namespace.nspname AS schema_name
    FROM pg_extension AS extension
    JOIN pg_namespace AS namespace ON namespace.oid = extension.extnamespace
    WHERE extension.extname IN ('pgcrypto', 'btree_gist')
  `);
  const existing = new Map(result.rows.map((row) => [row.extname, row.schema_name]));
  const missing = ['pgcrypto', 'btree_gist'].filter((name) => !existing.has(name));
  let createdTemporarySchema = false;

  if (missing.length > 0) {
    await createOwnedSchema(adminClient, ownedSchemas, temporarySchema);
    createdTemporarySchema = true;
    for (const extension of missing) {
      await adminClient.query(
        `CREATE EXTENSION ${quoteIdentifier(extension)} WITH SCHEMA ${quoteIdentifier(temporarySchema)}`,
      );
      existing.set(extension, temporarySchema);
    }
  }

  return {
    schemas: [...new Set(existing.values())],
    createdTemporarySchema,
  };
}

async function verifyHistoryAndReplay(client: Client, databaseUrl: string): Promise<void> {
  const before = await client.query<HistoryRow>(
    'SELECT filename, checksum, applied_at FROM schema_migrations ORDER BY filename',
  );
  assert.equal(before.rowCount, EXPECTED_MIGRATION_COUNT);
  const replay = await runMigration(databaseUrl);
  assert.equal(replay.exitCode, 0, replay.stderr);
  const after = await client.query<HistoryRow>(
    'SELECT filename, checksum, applied_at FROM schema_migrations ORDER BY filename',
  );
  assert.deepEqual(after.rows, before.rows);
}

async function verifySchemaObjectsAndConstraints(client: Client): Promise<void> {
  try {
    const tableResult = await client.query<NameRow>(`
      SELECT tablename AS name
      FROM pg_tables
      WHERE schemaname = current_schema()
        AND tablename <> 'schema_migrations'
      ORDER BY tablename
    `);
    assert.deepEqual(
      tableResult.rows.map((row) => row.name),
      EXPECTED_TABLES,
    );

    const foreignKeys = await client.query<NameRow>(`
      SELECT constraint_name AS name
      FROM information_schema.table_constraints
      WHERE constraint_schema = current_schema()
        AND constraint_type = 'FOREIGN KEY'
    `);
    const foreignKeyNames = new Set(foreignKeys.rows.map((row) => row.name));
    for (const name of [
      'fk_availability_slots_doctor',
      'fk_consultations_slot_snapshot',
      'fk_prescriptions_consultation_doctor',
      'fk_payments_consultation',
      'fk_sessions_user',
      'fk_sessions_parent_family',
      'fk_idempotency_records_actor',
      'fk_audit_logs_actor',
    ]) {
      assert.ok(foreignKeyNames.has(name), `Missing foreign key ${name}`);
    }

    const indexes = await client.query<NameRow>(`
      SELECT indexname AS name
      FROM pg_indexes
      WHERE schemaname = current_schema()
    `);
    const indexNames = new Set(indexes.rows.map((row) => row.name));
    for (const name of [
      'ex_availability_slots_doctor_time',
      'uq_consultations_one_non_cancelled_per_slot',
      'uq_idempotency_authenticated_scope',
      'uq_idempotency_anonymous_scope',
      'idx_audit_logs_actor_time',
      'idx_audit_logs_resource_time',
      'idx_outbox_events_pending_claim',
      'idx_outbox_events_processing_recovery',
    ]) {
      assert.ok(indexNames.has(name), `Missing index ${name}`);
    }

    await client.query('BEGIN');
    const passwordHash = '$argon2id$schema-test-placeholder-hash';
    const admin = await client.query<IdRow>(
      `INSERT INTO users (email, password_hash, role, status, email_verified_at)
       VALUES ($1, $2, 'admin', 'active', now()) RETURNING id`,
      ['schema-admin@example.test', passwordHash],
    );
    const doctorUser = await client.query<IdRow>(
      `INSERT INTO users (email, password_hash, role, status, email_verified_at)
       VALUES ($1, $2, 'doctor', 'active', now()) RETURNING id`,
      ['schema-doctor@example.test', passwordHash],
    );
    const patientOne = await client.query<IdRow>(
      `INSERT INTO users (email, password_hash, role, status, email_verified_at)
       VALUES ($1, $2, 'patient', 'active', now()) RETURNING id`,
      ['schema-patient-one@example.test', passwordHash],
    );
    const patientTwo = await client.query<IdRow>(
      `INSERT INTO users (email, password_hash, role, status, email_verified_at)
       VALUES ($1, $2, 'patient', 'active', now()) RETURNING id`,
      ['schema-patient-two@example.test', passwordHash],
    );
    const adminId = admin.rows[0]?.id;
    const doctorUserId = doctorUser.rows[0]?.id;
    const patientOneId = patientOne.rows[0]?.id;
    const patientTwoId = patientTwo.rows[0]?.id;
    assert.ok(adminId && doctorUserId && patientOneId && patientTwoId);

    const doctor = await client.query<IdRow>(
      `INSERT INTO doctors (
         user_id, license_number, license_jurisdiction, specialization,
         verification_status, verified_by, verified_at
       ) VALUES ($1, 'SCHEMA-001', 'IN-KA', 'Ayurveda', 'verified', $2, now())
       RETURNING id`,
      [doctorUserId, adminId],
    );
    const doctorId = doctor.rows[0]?.id;
    assert.ok(doctorId);

    const startsAt = '2035-01-01T09:00:00.000Z';
    const endsAt = '2035-01-01T09:30:00.000Z';
    const slot = await client.query<IdRow>(
      `INSERT INTO availability_slots (doctor_id, starts_at, ends_at)
       VALUES ($1, $2, $3) RETURNING id`,
      [doctorId, startsAt, endsAt],
    );
    const slotId = slot.rows[0]?.id;
    assert.ok(slotId);

    await expectPostgresError(
      client,
      '23514',
      `INSERT INTO users (email, password_hash, status)
       VALUES ('invalid-status@example.test', $1, 'unknown')`,
      [passwordHash],
    );
    await expectPostgresError(
      client,
      '23505',
      `INSERT INTO users (email, password_hash)
       VALUES ('schema-patient-one@example.test', $1)`,
      [passwordHash],
    );
    await expectPostgresError(
      client,
      '23503',
      `INSERT INTO availability_slots (doctor_id, starts_at, ends_at)
       VALUES ($1, $2, $3)`,
      [randomUUID(), startsAt, endsAt],
    );
    await expectPostgresError(
      client,
      '23514',
      `INSERT INTO availability_slots (doctor_id, starts_at, ends_at)
       VALUES ($1, $2, $3)`,
      [doctorId, endsAt, startsAt],
    );
    await expectPostgresError(
      client,
      '23P01',
      `INSERT INTO availability_slots (doctor_id, starts_at, ends_at)
       VALUES ($1, '2035-01-01T09:15:00Z', '2035-01-01T09:45:00Z')`,
      [doctorId],
    );

    const firstConsultation = await client.query<IdRow>(
      `INSERT INTO consultations (
         patient_id, doctor_id, slot_id, scheduled_start_at, scheduled_end_at
       ) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [patientOneId, doctorId, slotId, startsAt, endsAt],
    );
    const firstConsultationId = firstConsultation.rows[0]?.id;
    assert.ok(firstConsultationId);
    await expectPostgresError(
      client,
      '23505',
      `INSERT INTO consultations (
         patient_id, doctor_id, slot_id, scheduled_start_at, scheduled_end_at
       ) VALUES ($1, $2, $3, $4, $5)`,
      [patientTwoId, doctorId, slotId, startsAt, endsAt],
    );

    await client.query(
      `UPDATE consultations
       SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2,
           cancellation_reason = 'Patient rescheduled'
       WHERE id = $1`,
      [firstConsultationId, patientOneId],
    );
    const replacement = await client.query<IdRow>(
      `INSERT INTO consultations (
         patient_id, doctor_id, slot_id, scheduled_start_at, scheduled_end_at
       ) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [patientTwoId, doctorId, slotId, startsAt, endsAt],
    );
    const replacementId = replacement.rows[0]?.id;
    assert.ok(replacementId);
    await expectPostgresError(
      client,
      '23505',
      `INSERT INTO consultations (
         patient_id, doctor_id, slot_id, scheduled_start_at, scheduled_end_at
       ) VALUES ($1, $2, $3, $4, $5)`,
      [patientOneId, doctorId, slotId, startsAt, endsAt],
    );

    await client.query(
      `INSERT INTO idempotency_records (
         actor_id, operation, idempotency_key, request_fingerprint, expires_at
       ) VALUES ($1, 'consultations.book', 'same-key', $2, now() + interval '1 day')`,
      [patientOneId, 'a'.repeat(64)],
    );
    await expectPostgresError(
      client,
      '23505',
      `INSERT INTO idempotency_records (
         actor_id, operation, idempotency_key, request_fingerprint, expires_at
       ) VALUES ($1, 'consultations.book', 'same-key', $2, now() + interval '1 day')`,
      [patientOneId, 'a'.repeat(64)],
    );
    const anonymousScope = Buffer.alloc(32, 7);
    await client.query(
      `INSERT INTO idempotency_records (
         anonymous_scope_hash, operation, idempotency_key, request_fingerprint, expires_at
       ) VALUES ($1, 'users.register', 'anonymous-key', $2, now() + interval '1 day')`,
      [anonymousScope, 'b'.repeat(64)],
    );
    await expectPostgresError(
      client,
      '23505',
      `INSERT INTO idempotency_records (
         anonymous_scope_hash, operation, idempotency_key, request_fingerprint, expires_at
       ) VALUES ($1, 'users.register', 'anonymous-key', $2, now() + interval '1 day')`,
      [anonymousScope, 'b'.repeat(64)],
    );

    const audit = await client.query<IdRow>(
      `INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, request_id)
       VALUES ($1, 'consultation.booked', 'consultation', $2, 'schema-test') RETURNING id`,
      [patientTwoId, replacementId],
    );
    const auditId = audit.rows[0]?.id;
    assert.ok(auditId);
    await expectPostgresError(client, 'P0001', 'UPDATE audit_logs SET action = $1 WHERE id = $2', [
      'tampered',
      auditId,
    ]);

    await client.query(
      `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
       VALUES ('consultation.booked.v1', 'consultation', $1, $2::jsonb)`,
      [replacementId, JSON.stringify({ consultationId: replacementId })],
    );
    await expectPostgresError(
      client,
      '23514',
      `INSERT INTO payments (consultation_id, amount, currency)
       VALUES ($1, -1, 'INR')`,
      [replacementId],
    );

    await client.query('ROLLBACK');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection may already be outside a transaction.
    }
    throw error;
  }
}

async function verifyConcurrentBookingConflict(databaseUrl: string): Promise<void> {
  const seed = new Client({ connectionString: databaseUrl, ssl: sslConfiguration() });
  await seed.connect();
  const passwordHash = '$argon2id$concurrency-test-placeholder';
  let doctorId: string | undefined;
  let firstPatientId: string | undefined;
  let secondPatientId: string | undefined;
  let slotId: string | undefined;
  const startsAt = '2035-02-01T10:00:00.000Z';
  const endsAt = '2035-02-01T10:30:00.000Z';
  try {
    const doctorUser = await seed.query<IdRow>(
      `INSERT INTO users (email, password_hash, role, status, email_verified_at)
       VALUES ($1, $2, 'doctor', 'active', now()) RETURNING id`,
      [`concurrency-doctor-${randomUUID()}@example.test`, passwordHash],
    );
    const firstPatient = await seed.query<IdRow>(
      `INSERT INTO users (email, password_hash, role, status, email_verified_at)
       VALUES ($1, $2, 'patient', 'active', now()) RETURNING id`,
      [`concurrency-patient-one-${randomUUID()}@example.test`, passwordHash],
    );
    const secondPatient = await seed.query<IdRow>(
      `INSERT INTO users (email, password_hash, role, status, email_verified_at)
       VALUES ($1, $2, 'patient', 'active', now()) RETURNING id`,
      [`concurrency-patient-two-${randomUUID()}@example.test`, passwordHash],
    );
    firstPatientId = firstPatient.rows[0]?.id;
    secondPatientId = secondPatient.rows[0]?.id;
    const doctor = await seed.query<IdRow>(
      `INSERT INTO doctors (
         user_id, license_number, license_jurisdiction, specialization
       ) VALUES ($1, $2, 'IN-KA', 'Ayurveda') RETURNING id`,
      [doctorUser.rows[0]?.id, `RACE-${randomUUID()}`.toUpperCase()],
    );
    doctorId = doctor.rows[0]?.id;
    const slot = await seed.query<IdRow>(
      `INSERT INTO availability_slots (doctor_id, starts_at, ends_at)
       VALUES ($1, $2, $3) RETURNING id`,
      [doctorId, startsAt, endsAt],
    );
    slotId = slot.rows[0]?.id;
    assert.ok(doctorId && firstPatientId && secondPatientId && slotId);
  } finally {
    await seed.end();
  }

  const first = new Client({ connectionString: databaseUrl, ssl: sslConfiguration() });
  const second = new Client({ connectionString: databaseUrl, ssl: sslConfiguration() });
  await Promise.all([first.connect(), second.connect()]);
  try {
    await first.query('BEGIN');
    await second.query('BEGIN');
    await first.query(
      `INSERT INTO consultations (
         patient_id, doctor_id, slot_id, scheduled_start_at, scheduled_end_at
       ) VALUES ($1, $2, $3, $4, $5)`,
      [firstPatientId, doctorId, slotId, startsAt, endsAt],
    );

    const secondAttempt = second
      .query(
        `INSERT INTO consultations (
           patient_id, doctor_id, slot_id, scheduled_start_at, scheduled_end_at
         ) VALUES ($1, $2, $3, $4, $5)`,
        [secondPatientId, doctorId, slotId, startsAt, endsAt],
      )
      .then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
    await first.query('COMMIT');
    const losingAttempt = await secondAttempt;
    assert.equal(postgresCode(losingAttempt.error), '23505');
    await second.query('ROLLBACK');

    const activeCount = await first.query<{ count: string } & QueryResultRow>(
      `SELECT count(*)::text AS count
       FROM consultations
       WHERE slot_id = $1 AND status <> 'cancelled'`,
      [slotId],
    );
    assert.equal(activeCount.rows[0]?.count, '1');
  } finally {
    try {
      await first.query('ROLLBACK');
    } catch {
      // The successful transaction is already committed.
    }
    try {
      await second.query('ROLLBACK');
    } catch {
      // The losing transaction is already rolled back.
    }
    await Promise.all([first.end(), second.end()]);
  }
}

async function verifyFailedMigrationNotRecorded(
  client: Client,
  databaseUrl: string,
): Promise<void> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'amrutam-migrations-'));
  try {
    const sourceDirectory = resolve('migrations');
    const filenames = (await readdir(sourceDirectory)).filter((name) => name.endsWith('.sql'));
    await Promise.all(
      filenames.map((filename) =>
        copyFile(resolve(sourceDirectory, filename), join(temporaryDirectory, basename(filename))),
      ),
    );
    await writeFile(
      join(temporaryDirectory, '999_intentional_failure.sql'),
      'CREATE TABLE migration_should_roll_back (id integer);\nSELECT missing_test_function();\n',
      'utf8',
    );
    const result = await runMigration(databaseUrl, temporaryDirectory);
    assert.notEqual(result.exitCode, 0, 'Intentional migration unexpectedly succeeded');
    const history = await client.query<{ count: string } & QueryResultRow>(
      `SELECT count(*)::text AS count
       FROM schema_migrations WHERE filename = '999_intentional_failure.sql'`,
    );
    assert.equal(history.rows[0]?.count, '0');
    const table = await client.query<{ relation: string | null } & QueryResultRow>(
      'SELECT to_regclass($1) AS relation',
      ['migration_should_roll_back'],
    );
    assert.equal(table.rows[0]?.relation, null);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function verifyConcurrentMigration(databaseUrl: string): Promise<void> {
  const [first, second] = await Promise.all([runMigration(databaseUrl), runMigration(databaseUrl)]);
  assert.equal(first.exitCode, 0, first.stderr);
  assert.equal(second.exitCode, 0, second.stderr);
  const client = new Client({
    connectionString: databaseUrl,
    ssl: sslConfiguration(),
  });
  await client.connect();
  try {
    const history = await client.query<{ count: string } & QueryResultRow>(
      'SELECT count(*)::text AS count FROM schema_migrations',
    );
    assert.equal(history.rows[0]?.count, String(EXPECTED_MIGRATION_COUNT));
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  if (process.env.SCHEMA_TEST_CONFIRM_DISPOSABLE !== 'yes') {
    throw new Error(
      'Set SCHEMA_TEST_CONFIRM_DISPOSABLE=yes only for a disposable development database',
    );
  }
  const databaseUrl = requiredEnvironment('SCHEMA_TEST_DATABASE_URL');
  const adminClient = new Client({
    connectionString: databaseUrl,
    ssl: sslConfiguration(),
  });
  const primarySchema = testSchemaName('schema_test');
  const concurrentSchema = testSchemaName('migration_race');
  const extensionSchema = testSchemaName('test_extensions');
  const ownedSchemas = new Set<string>();

  try {
    await adminClient.connect();
    const extensions = await prepareExtensionSchemas(adminClient, extensionSchema, ownedSchemas);
    await createOwnedSchema(adminClient, ownedSchemas, primarySchema);
    await createOwnedSchema(adminClient, ownedSchemas, concurrentSchema);

    const primaryUrl = withSearchPath(databaseUrl, [
      primarySchema,
      ...extensions.schemas,
      'public',
    ]);
    const concurrentUrl = withSearchPath(databaseUrl, [
      concurrentSchema,
      ...extensions.schemas,
      'public',
    ]);

    const initialMigration = await runMigration(primaryUrl);
    assert.equal(initialMigration.exitCode, 0, initialMigration.stderr);
    const primaryClient = new Client({
      connectionString: primaryUrl,
      ssl: sslConfiguration(),
    });
    await primaryClient.connect();
    try {
      await verifyHistoryAndReplay(primaryClient, primaryUrl);
      await verifySchemaObjectsAndConstraints(primaryClient);
      await verifyConcurrentBookingConflict(primaryUrl);
      await verifyFailedMigrationNotRecorded(primaryClient, primaryUrl);
    } finally {
      await primaryClient.end();
    }

    await verifyConcurrentMigration(concurrentUrl);
    log('schema_verification_complete', {
      migrations: EXPECTED_MIGRATION_COUNT,
      tables: EXPECTED_TABLES.length,
    });
  } finally {
    await cleanupOwnedSchemas(adminClient, ownedSchemas);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown schema verification failure';
  process.stderr.write(`${JSON.stringify({ event: 'schema_verification_failed', message })}\n`);
  process.exitCode = 1;
});
