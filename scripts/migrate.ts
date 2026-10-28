import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool, QueryResultRow } from 'pg';

const MIGRATION_FILE_PATTERN = /^\d{3,}_[a-z0-9_]+\.sql$/;
const NON_TRANSACTIONAL_MARKER = '-- migrate:non-transactional';
const MIGRATION_LOCK_ID = 1_096_541_284;

interface AppliedMigration extends QueryResultRow {
  filename: string;
  checksum: string;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Environment variable ${name} is required`);
  return value;
}

function log(event: string, details: Record<string, unknown> = {}): void {
  process.stdout.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...details })}\n`,
  );
}

async function migrate(): Promise<void> {
  const databaseUrl = requiredEnvironment('DATABASE_URL');
  const migrationsDirectoryOverride = process.env.MIGRATIONS_DIRECTORY?.trim();
  if (migrationsDirectoryOverride && process.env.NODE_ENV !== 'test') {
    throw new Error('MIGRATIONS_DIRECTORY may be overridden only when NODE_ENV=test');
  }
  const migrationsDirectory = migrationsDirectoryOverride
    ? resolve(migrationsDirectoryOverride)
    : resolve(process.cwd(), 'migrations');
  const filenames = (await readdir(migrationsDirectory))
    .filter((filename) => MIGRATION_FILE_PATTERN.test(filename))
    .sort((left, right) => left.localeCompare(right));

  if (filenames.length === 0) throw new Error('No migration files were found');

  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: 'amrutam-migrations',
    max: 1,
    connectionTimeoutMillis: Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS ?? 5000),
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: true },
  });
  const client = await pool.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(),
        duration_ms integer NOT NULL CHECK (duration_ms >= 0)
      )
    `);

    const appliedResult = await client.query<AppliedMigration>(
      'SELECT filename, checksum FROM schema_migrations ORDER BY filename',
    );
    const applied = new Map(appliedResult.rows.map((row) => [row.filename, row.checksum]));
    const unknownApplied = [...applied.keys()].filter((filename) => !filenames.includes(filename));
    if (unknownApplied.length > 0) {
      throw new Error(
        `Applied migration file is missing from the repository: ${unknownApplied[0]}`,
      );
    }

    for (const filename of filenames) {
      const sql = await readFile(resolve(migrationsDirectory, filename), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const recordedChecksum = applied.get(filename);
      if (recordedChecksum) {
        if (recordedChecksum !== checksum) {
          throw new Error(`Applied migration was modified: ${filename}`);
        }
        continue;
      }
      if (sql.includes(NON_TRANSACTIONAL_MARKER)) {
        throw new Error(
          `Non-transactional migration requires the documented manual procedure: ${filename}`,
        );
      }

      const startedAt = Date.now();
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename, checksum, duration_ms) VALUES ($1, $2, $3)',
          [filename, checksum, Date.now() - startedAt],
        );
        await client.query('COMMIT');
        log('migration_applied', { filename, durationMs: Date.now() - startedAt });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    log('migrations_complete', { appliedCount: filenames.length });
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    } finally {
      client.release();
      await pool.end();
    }
  }
}

migrate().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown migration failure';
  process.stderr.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), event: 'migration_failed', message })}\n`,
  );
  process.exitCode = 1;
});
