import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const migrationDirectory = resolve('migrations');
const filenames = readdirSync(migrationDirectory)
  .filter((filename) => filename.endsWith('.sql'))
  .sort((left, right) => left.localeCompare(right));
const sql = filenames
  .map((filename) => readFileSync(resolve(migrationDirectory, filename), 'utf8'))
  .join('\n');

const expectedTables = [
  'users',
  'profiles',
  'doctors',
  'availability_slots',
  'consultations',
  'prescriptions',
  'prescription_items',
  'payments',
  'sessions',
  'mfa_factors',
  'idempotency_records',
  'audit_logs',
  'outbox_events',
];

void describe('Milestone 2 migration contract', () => {
  void it('keeps ordered, descriptive, transactional migration files', () => {
    assert.deepEqual(filenames, [
      '001_migration_metadata.sql',
      '002_identity_doctors_and_availability.sql',
      '003_consultations_prescriptions_and_payments.sql',
      '004_security_audit_and_outbox.sql',
    ]);
    for (const filename of filenames) {
      assert.match(filename, /^\d{3,}_[a-z0-9_]+\.sql$/);
      assert.doesNotMatch(
        readFileSync(resolve(migrationDirectory, filename), 'utf8'),
        /-- migrate:non-transactional/,
      );
    }
  });

  void it('creates every documented domain and supporting table', () => {
    for (const table of expectedTables) {
      assert.match(sql, new RegExp(`CREATE TABLE ${table} \\(`));
    }
  });

  void it('contains the database-enforced booking invariants', () => {
    assert.match(sql, /EXCLUDE USING gist/);
    assert.match(sql, /tstzrange\(starts_at, ends_at, '\[\)'\) WITH &&/);
    assert.match(sql, /uq_consultations_one_non_cancelled_per_slot/);
    assert.match(sql, /WHERE status <> 'cancelled'/);
    assert.match(sql, /fk_consultations_slot_snapshot/);
  });

  void it('contains idempotency, audit, session, and outbox safeguards', () => {
    assert.match(sql, /uq_idempotency_authenticated_scope/);
    assert.match(sql, /uq_idempotency_anonymous_scope/);
    assert.match(sql, /uq_sessions_one_active_per_family/);
    assert.match(sql, /trg_audit_logs_append_only/);
    assert.match(sql, /idx_outbox_events_pending_claim/);
    assert.match(sql, /idx_outbox_events_processing_recovery/);
  });

  void it('keeps the ER diagram synchronized with physical tables', () => {
    const diagram = readFileSync(resolve('docs/diagrams/er-diagram.md'), 'utf8');
    for (const table of expectedTables) {
      assert.match(diagram.toLowerCase(), new RegExp(table.toUpperCase().toLowerCase()));
    }
  });
});
