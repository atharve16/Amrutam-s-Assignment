import { strict as assert } from 'node:assert';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { JwtService } from '@nestjs/jwt';
import { Client, Pool, QueryResultRow } from 'pg';
import {
  cleanupOwnedSchemas,
  createOwnedSchema,
  quoteIdentifier,
} from '../scripts/schema-verifier-cleanup';
import { UserRole } from '../src/auth/auth.types';

const TEST_JWT_SECRET = 'postgres-integration-test-secret-32-characters';
const PASSWORD_HASH_PLACEHOLDER = '$argon2id$integration-test-placeholder';

interface IdRow extends QueryResultRow {
  id: string;
}

interface ExtensionRow extends QueryResultRow {
  extname: string;
  schema_name: string;
}

interface TestUser {
  id: string;
  token: string;
}

interface BookingFixture {
  patients: TestUser[];
  slotIds: string[];
}

interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface AtomicCounts extends QueryResultRow {
  consultations: number;
  idempotency_records: number;
  audit_logs: number;
  outbox_events: number;
}

let adminClient: Client | undefined;
let database: Pool | undefined;
let application: ChildProcess | undefined;
let baseUrl = '';
let startupOutput = '';
let cleanupComplete = false;
const ownedSchemas = new Set<string>();
const jwt = new JwtService({
  secret: TEST_JWT_SECRET,
  signOptions: { algorithm: 'HS256', expiresIn: '15m' },
});

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Environment variable ${name} is required`);
  return value;
}

function sslConfiguration(): false | { rejectUnauthorized: true } {
  return process.env.SCHEMA_TEST_DATABASE_SSL === 'false' ? false : { rejectUnauthorized: true };
}

function testSchemaName(label: string): string {
  return `amrutam_${label}_${randomBytes(16).toString('hex')}`;
}

function withSearchPath(databaseUrl: string, schemas: string[]): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schemas.join(',')}`);
  return url.toString();
}

async function prepareExtensionSchemas(client: Client, temporarySchema: string): Promise<string[]> {
  const result = await client.query<ExtensionRow>(`
    SELECT extension.extname, namespace.nspname AS schema_name
    FROM pg_extension AS extension
    JOIN pg_namespace AS namespace ON namespace.oid = extension.extnamespace
    WHERE extension.extname IN ('pgcrypto', 'btree_gist')
  `);
  const existing = new Map(result.rows.map((row) => [row.extname, row.schema_name]));
  const missing = ['pgcrypto', 'btree_gist'].filter((name) => !existing.has(name));
  if (missing.length > 0) {
    await createOwnedSchema(client, ownedSchemas, temporarySchema);
    for (const extension of missing) {
      await client.query(
        `CREATE EXTENSION ${quoteIdentifier(extension)} WITH SCHEMA ${quoteIdentifier(temporarySchema)}`,
      );
      existing.set(extension, temporarySchema);
    }
  }
  return [...new Set(existing.values())];
}

async function runMigrations(databaseUrl: string): Promise<ProcessResult> {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(process.execPath, [resolve('dist/scripts/migrate.js')], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: databaseUrl,
        DATABASE_SSL: process.env.SCHEMA_TEST_DATABASE_SSL ?? 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      rejectProcess(new Error('Integration-test migrations exceeded 90 seconds'));
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

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        rejectPort(new Error('Could not allocate an integration-test port'));
        return;
      }
      server.close((error) => (error ? rejectPort(error) : resolvePort(address.port)));
    });
  });
}

async function waitForApplication(): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (application?.exitCode !== null) {
      throw new Error(`Application exited during startup: ${startupOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/v1/health`);
      if (response.ok) return;
    } catch {
      // The application is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Application did not start before the timeout: ${startupOutput}`);
}

async function stopApplication(): Promise<void> {
  if (!application || application.exitCode !== null) return;
  const exited = once(application, 'exit');
  application.kill();
  await Promise.race([exited, new Promise<void>((resolveWait) => setTimeout(resolveWait, 10_000))]);
}

async function teardown(): Promise<void> {
  if (cleanupComplete) return;
  cleanupComplete = true;
  const failures: unknown[] = [];
  try {
    await stopApplication();
  } catch (error) {
    failures.push(error);
  }
  try {
    await database?.end();
  } catch (error) {
    failures.push(error);
  }
  if (adminClient) {
    try {
      await cleanupOwnedSchemas(adminClient, ownedSchemas);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'PostgreSQL integration-test cleanup failed');
  }
}

async function createTestUser(role: UserRole): Promise<TestUser> {
  assert.ok(database);
  const suffix = randomUUID();
  const userResult = await database.query<IdRow>(
    `INSERT INTO users (email, password_hash, role, status, email_verified_at)
     VALUES ($1, $2, $3, 'active', now()) RETURNING id`,
    [`integration-${role}-${suffix}@example.test`, PASSWORD_HASH_PLACEHOLDER, role],
  );
  const userId = userResult.rows[0]?.id;
  assert.ok(userId);
  await database.query(
    `INSERT INTO profiles (user_id, full_name, timezone) VALUES ($1, $2, 'UTC')`,
    [userId, `Integration ${role}`],
  );
  const sessionResult = await database.query<IdRow>(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '1 day') RETURNING id`,
    [userId, randomBytes(32)],
  );
  const sessionId = sessionResult.rows[0]?.id;
  assert.ok(sessionId);
  const token = await jwt.signAsync({ sub: userId, role, sid: sessionId, typ: 'access' });
  return { id: userId, token };
}

let fixtureSequence = 0;

async function createBookingFixture(patientCount: number, slotCount = 1): Promise<BookingFixture> {
  assert.ok(database);
  fixtureSequence += 1;
  const doctorUser = await createTestUser('doctor');
  const doctorResult = await database.query<IdRow>(
    `INSERT INTO doctors (
       user_id, license_number, license_jurisdiction, specialization,
       verification_status, verified_at
     ) VALUES ($1, $2, 'IN-KA', 'Ayurveda', 'verified', now())
     RETURNING id`,
    [doctorUser.id, `IT-${randomUUID()}`.toUpperCase()],
  );
  const doctorId = doctorResult.rows[0]?.id;
  assert.ok(doctorId);
  const slotIds: string[] = [];
  const fixtureStart = Date.now() + 365 * 24 * 60 * 60 * 1000 + fixtureSequence * 86_400_000;
  for (let index = 0; index < slotCount; index += 1) {
    const startsAt = new Date(fixtureStart + index * 3_600_000);
    const endsAt = new Date(startsAt.getTime() + 30 * 60 * 1000);
    const slot = await database.query<IdRow>(
      `INSERT INTO availability_slots (doctor_id, starts_at, ends_at)
       VALUES ($1, $2, $3) RETURNING id`,
      [doctorId, startsAt, endsAt],
    );
    const slotId = slot.rows[0]?.id;
    assert.ok(slotId);
    slotIds.push(slotId);
  }
  const patients = await Promise.all(
    Array.from({ length: patientCount }, () => createTestUser('patient')),
  );
  return { patients, slotIds };
}

async function apiRequest(
  user: TestUser,
  method: 'POST' | 'PATCH',
  path: string,
  idempotencyKey: string,
  body: Record<string, unknown>,
  requestId = `integration-${randomUUID()}`,
): Promise<ApiResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${user.token}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      'x-request-id': requestId,
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function book(user: TestUser, slotId: string, key: string): Promise<ApiResponse> {
  return apiRequest(user, 'POST', '/api/v1/consultations', key, { slotId });
}

async function atomicCounts(): Promise<AtomicCounts> {
  assert.ok(database);
  const result = await database.query<AtomicCounts>(`
    SELECT
      (SELECT count(*)::integer FROM consultations) AS consultations,
      (SELECT count(*)::integer FROM idempotency_records) AS idempotency_records,
      (SELECT count(*)::integer FROM audit_logs) AS audit_logs,
      (SELECT count(*)::integer FROM outbox_events) AS outbox_events
  `);
  const counts = result.rows[0];
  assert.ok(counts);
  return counts;
}

void describe('PostgreSQL booking integration', { concurrency: false }, () => {
  void before(
    async () => {
      if (process.env.SCHEMA_TEST_CONFIRM_DISPOSABLE !== 'yes') {
        throw new Error(
          'Set SCHEMA_TEST_CONFIRM_DISPOSABLE=yes only for a disposable development database',
        );
      }
      const databaseUrl = requiredEnvironment('SCHEMA_TEST_DATABASE_URL');
      adminClient = new Client({
        connectionString: databaseUrl,
        ssl: sslConfiguration(),
      });
      try {
        await adminClient.connect();
        const extensionSchema = testSchemaName('integration_extensions');
        const extensions = await prepareExtensionSchemas(adminClient, extensionSchema);
        const testSchema = testSchemaName('booking_integration');
        await createOwnedSchema(adminClient, ownedSchemas, testSchema);
        const isolatedUrl = withSearchPath(databaseUrl, [testSchema, ...extensions, 'public']);
        const migration = await runMigrations(isolatedUrl);
        assert.equal(migration.exitCode, 0, migration.stderr);
        database = new Pool({
          connectionString: isolatedUrl,
          application_name: 'amrutam-booking-integration-tests',
          max: 10,
          connectionTimeoutMillis: 5000,
          idleTimeoutMillis: 30_000,
          ssl: sslConfiguration(),
        });
        await database.query('SELECT 1');

        const port = await availablePort();
        baseUrl = `http://127.0.0.1:${port}`;
        application = spawn(process.execPath, [resolve('dist/src/main.js')], {
          env: {
            ...process.env,
            NODE_ENV: 'test',
            PORT: String(port),
            DATABASE_URL: isolatedUrl,
            DATABASE_SSL: process.env.SCHEMA_TEST_DATABASE_SSL ?? 'true',
            DATABASE_POOL_MAX: '10',
            JWT_ACCESS_SECRET: TEST_JWT_SECRET,
            JWT_ACCESS_TTL: '15m',
            APP_ORIGIN: 'http://localhost:3001',
            LOG_LEVEL: 'fatal',
            SWAGGER_ENABLED: 'false',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        application.stdout?.on('data', (chunk: Buffer) => {
          startupOutput += chunk.toString();
        });
        application.stderr?.on('data', (chunk: Buffer) => {
          startupOutput += chunk.toString();
        });
        await waitForApplication();
      } catch (error) {
        await teardown();
        throw error;
      }
    },
    { timeout: 120_000 },
  );

  void after(async () => teardown(), { timeout: 30_000 });

  void it('allows exactly one of two genuinely concurrent bookings for one slot', async () => {
    assert.ok(database);
    const fixture = await createBookingFixture(2);
    const slotId = fixture.slotIds[0];
    const firstPatient = fixture.patients[0];
    const secondPatient = fixture.patients[1];
    assert.ok(slotId && firstPatient && secondPatient);

    const attempts = await Promise.all([
      book(firstPatient, slotId, `concurrent-${randomUUID()}`),
      book(secondPatient, slotId, `concurrent-${randomUUID()}`),
    ]);
    assert.deepEqual(
      attempts.map((attempt) => attempt.status).sort((left, right) => left - right),
      [201, 409],
    );
    const conflict = attempts.find((attempt) => attempt.status === 409);
    assert.equal(conflict?.body.message, 'Slot has already been booked');

    const state = await database.query<
      { active_count: number; total_count: number } & QueryResultRow
    >(
      `SELECT count(*) FILTER (WHERE status <> 'cancelled')::integer AS active_count,
              count(*)::integer AS total_count
       FROM consultations WHERE slot_id = $1`,
      [slotId],
    );
    assert.equal(state.rows[0]?.active_count, 1);
    assert.equal(state.rows[0]?.total_count, 1);
  });

  void it('replays an identical idempotent booking without duplicate side effects', async () => {
    assert.ok(database);
    const fixture = await createBookingFixture(1);
    const patient = fixture.patients[0];
    const slotId = fixture.slotIds[0];
    assert.ok(patient && slotId);
    const key = `replay-${randomUUID()}`;

    const first = await book(patient, slotId, key);
    const replay = await book(patient, slotId, key);
    assert.equal(first.status, 201);
    assert.equal(replay.status, 201);
    assert.deepEqual(replay.body, first.body);

    const state = await database.query<
      {
        consultations: number;
        idempotency_records: number;
        audits: number;
        outbox: number;
      } & QueryResultRow
    >(
      `SELECT
         (SELECT count(*)::integer FROM consultations WHERE slot_id = $1) AS consultations,
         (SELECT count(*)::integer FROM idempotency_records
          WHERE actor_id = $2 AND operation = 'consultation.book'
            AND idempotency_key = $3 AND status = 'completed' AND response_status = 201)
           AS idempotency_records,
         (SELECT count(*)::integer FROM audit_logs
          WHERE actor_id = $2 AND action = 'consultation.booked' AND resource_id = $4) AS audits,
         (SELECT count(*)::integer FROM outbox_events
          WHERE event_type = 'consultation.booked' AND aggregate_id = $4) AS outbox`,
      [slotId, patient.id, key, first.body.id],
    );
    assert.deepEqual(state.rows[0], {
      consultations: 1,
      idempotency_records: 1,
      audits: 1,
      outbox: 1,
    });
  });

  void it('returns the documented conflict when a key is reused with a different payload', async () => {
    assert.ok(database);
    const fixture = await createBookingFixture(1, 2);
    const patient = fixture.patients[0];
    const firstSlotId = fixture.slotIds[0];
    const secondSlotId = fixture.slotIds[1];
    assert.ok(patient && firstSlotId && secondSlotId);
    const key = `payload-conflict-${randomUUID()}`;

    const first = await book(patient, firstSlotId, key);
    const conflict = await book(patient, secondSlotId, key);
    assert.equal(first.status, 201);
    assert.equal(conflict.status, 409);
    assert.equal(
      conflict.body.message,
      'Idempotency-Key was already used with a different request',
    );
    assert.equal(conflict.body.error, 'Conflict');

    const state = await database.query<
      { first_slot: number; second_slot: number; idempotency_records: number } & QueryResultRow
    >(
      `SELECT
         (SELECT count(*)::integer FROM consultations WHERE slot_id = $1) AS first_slot,
         (SELECT count(*)::integer FROM consultations WHERE slot_id = $2) AS second_slot,
         (SELECT count(*)::integer FROM idempotency_records
          WHERE actor_id = $3 AND operation = 'consultation.book' AND idempotency_key = $4)
           AS idempotency_records`,
      [firstSlotId, secondSlotId, patient.id, key],
    );
    assert.deepEqual(state.rows[0], {
      first_slot: 1,
      second_slot: 0,
      idempotency_records: 1,
    });
  });

  void it('cancels and rebooks while preserving consultation and event history', async () => {
    assert.ok(database);
    const fixture = await createBookingFixture(2);
    const firstPatient = fixture.patients[0];
    const secondPatient = fixture.patients[1];
    const slotId = fixture.slotIds[0];
    assert.ok(firstPatient && secondPatient && slotId);

    const original = await book(firstPatient, slotId, `original-${randomUUID()}`);
    assert.equal(original.status, 201);
    const originalId = String(original.body.id);
    const cancellation = await apiRequest(
      firstPatient,
      'PATCH',
      `/api/v1/consultations/${originalId}/status`,
      `cancel-${randomUUID()}`,
      { status: 'cancelled', cancellationReason: 'Patient requested rescheduling' },
    );
    assert.equal(cancellation.status, 200);
    assert.equal(cancellation.body.status, 'cancelled');

    const replacement = await book(secondPatient, slotId, `replacement-${randomUUID()}`);
    assert.equal(replacement.status, 201);
    assert.notEqual(replacement.body.id, originalId);

    const consultations = await database.query<
      {
        id: string;
        patient_id: string;
        status: string;
        cancelled_at: Date | null;
        cancellation_reason: string | null;
      } & QueryResultRow
    >(
      `SELECT id, patient_id, status, cancelled_at, cancellation_reason
       FROM consultations WHERE slot_id = $1 ORDER BY created_at, id`,
      [slotId],
    );
    assert.equal(consultations.rows.length, 2);
    const originalRow = consultations.rows.find((row) => row.id === originalId);
    const replacementRow = consultations.rows.find((row) => row.id === replacement.body.id);
    assert.equal(originalRow?.status, 'cancelled');
    assert.ok(originalRow?.cancelled_at);
    assert.equal(originalRow?.cancellation_reason, 'Patient requested rescheduling');
    assert.equal(replacementRow?.status, 'scheduled');
    assert.equal(replacementRow?.patient_id, secondPatient.id);

    const history = await database.query<{ count: number } & QueryResultRow>(
      `SELECT count(*)::integer AS count
       FROM audit_logs
       WHERE resource_id IN ($1, $2)
         AND action IN ('consultation.booked', 'consultation.cancelled')`,
      [originalId, replacement.body.id],
    );
    assert.equal(history.rows[0]?.count, 3);
  });

  void it('rolls back booking, idempotency, audit, and outbox writes after a late failure', async () => {
    assert.ok(database);
    const fixture = await createBookingFixture(1);
    const patient = fixture.patients[0];
    const slotId = fixture.slotIds[0];
    assert.ok(patient && slotId);
    const beforeCounts = await atomicCounts();
    const key = `rollback-${randomUUID()}`;
    const requestId = `rollback-${randomUUID()}`;

    await database.query(`
      CREATE FUNCTION integration_reject_booking_outbox()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.event_type = 'consultation.booked' THEN
          RAISE EXCEPTION 'integration induced outbox failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await database.query(`
      CREATE TRIGGER integration_reject_booking_outbox
      BEFORE INSERT ON outbox_events
      FOR EACH ROW EXECUTE FUNCTION integration_reject_booking_outbox()
    `);
    let failed: ApiResponse;
    try {
      failed = await apiRequest(
        patient,
        'POST',
        '/api/v1/consultations',
        key,
        { slotId },
        requestId,
      );
    } finally {
      await database.query('DROP TRIGGER integration_reject_booking_outbox ON outbox_events');
      await database.query('DROP FUNCTION integration_reject_booking_outbox()');
    }
    assert.equal(failed.status, 500);
    assert.equal(failed.body.message, 'An unexpected error occurred');
    assert.deepEqual(await atomicCounts(), beforeCounts);

    const partialRows = await database.query<
      { consultations: number; idempotency_records: number; audit_logs: number } & QueryResultRow
    >(
      `SELECT
         (SELECT count(*)::integer FROM consultations WHERE slot_id = $1) AS consultations,
         (SELECT count(*)::integer FROM idempotency_records
          WHERE actor_id = $2 AND operation = 'consultation.book' AND idempotency_key = $3)
           AS idempotency_records,
         (SELECT count(*)::integer FROM audit_logs
          WHERE actor_id = $2 AND request_id = $4) AS audit_logs`,
      [slotId, patient.id, key, requestId],
    );
    assert.deepEqual(partialRows.rows[0], {
      consultations: 0,
      idempotency_records: 0,
      audit_logs: 0,
    });
  });
});
