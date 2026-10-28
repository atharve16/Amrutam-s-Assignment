import { Pool } from 'pg';
import * as argon2 from 'argon2';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Environment variable ${name} is required`);
  return value;
}

async function bootstrapAdmin(): Promise<void> {
  const email = required('ADMIN_BOOTSTRAP_EMAIL').toLowerCase();
  const password = required('ADMIN_BOOTSTRAP_PASSWORD');
  const fullName = required('ADMIN_BOOTSTRAP_FULL_NAME');
  if (password.length < 16)
    throw new Error('ADMIN_BOOTSTRAP_PASSWORD must be at least 16 characters');
  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
  const pool = new Pool({
    connectionString: required('DATABASE_URL'),
    max: 1,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: true },
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [1_096_541_285]);
    const existing = await client.query(`SELECT 1 FROM users WHERE role = 'admin' LIMIT 1`);
    if (existing.rowCount) throw new Error('An administrator already exists; bootstrap refused');
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, status)
       VALUES ($1, $2, 'admin', 'active') RETURNING id`,
      [email, passwordHash],
    );
    const adminId = inserted.rows[0]?.id;
    if (!adminId) throw new Error('Admin insert returned no row');
    await client.query(`INSERT INTO profiles (user_id, full_name) VALUES ($1, $2)`, [
      adminId,
      fullName,
    ]);
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, resource_type, resource_id)
       VALUES ($1, 'admin.bootstrapped', 'user', $1)`,
      [adminId],
    );
    await client.query('COMMIT');
    process.stdout.write(`${JSON.stringify({ event: 'admin_bootstrap_complete', adminId })}\n`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

bootstrapAdmin().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown admin bootstrap failure';
  process.stderr.write(`${JSON.stringify({ event: 'admin_bootstrap_failed', message })}\n`);
  process.exitCode = 1;
});
