# Supabase PostgreSQL setup

## Choose and obtain the connection string

In the Supabase dashboard, open the project and click **Connect**. For a long-running container or VM with IPv6, use the direct connection. For an IPv4-only persistent environment, choose the shared **Session pooler**. Copy the complete value and replace the password placeholder; percent-encode reserved password characters. Do not reconstruct the pooler hostname or username.

Put the value only in the server's `DATABASE_URL`. Never expose it to a browser, mobile client, image layer, log, or source control. This backend does not require a Supabase service-role key.

The application uses session-scoped PostgreSQL advisory locks for migrations. Run migrations through a direct or session-mode connection. Transaction-mode poolers do not preserve session state and are therefore unsuitable for this runner.

Supabase connection guidance: <https://supabase.com/docs/guides/database/connecting-to-postgres>

## TLS

Production uses `DATABASE_SSL=true` (the default), which makes `pg` require TLS and verify the server certificate against Node's trusted certificate authorities. Enable Supabase's **Enforce SSL on incoming connections** option. If the project certificate chain is not in the runtime trust store, download the server root certificate from the dashboard's Database/SSL settings and supply it to Node through `NODE_EXTRA_CA_CERTS=/run/secrets/supabase-ca.crt`; mount that file as a deployment secret rather than copying it into the image.

Use `DATABASE_SSL=false` only for an explicitly trusted local PostgreSQL instance. It should not be used with Supabase or in production.

Supabase SSL guidance: <https://supabase.com/docs/guides/platform/ssl-enforcement>

## Pool sizing

`DATABASE_POOL_MAX` defaults to 10 and is bounded from 1 to 50. This value is per API replica. Ensure:

```text
API replica count × DATABASE_POOL_MAX + migration/admin headroom < available database connections
```

Start smaller when deploying multiple replicas. Supabase's pool and compute limits vary by project. Monitor wait time and active connections before raising the application pool. The connection and idle timeouts are configurable with `DATABASE_CONNECTION_TIMEOUT_MS` and `DATABASE_IDLE_TIMEOUT_MS`.

## Migrations

After setting `.env`:

```bash
npm run migration:run
```

The runner:

1. obtains an advisory lock on one connection;
2. creates the history table if necessary;
3. verifies that applied files still exist and their SHA-256 checksums match;
4. applies each pending migration and history row atomically;
5. unlocks and closes the pool.

Files must match `NNN_description.sql` and sort in execution order. Never edit or remove an applied file. Add a new migration to change or reverse prior work. Back up and test restores before destructive schema changes.

Non-transactional statements are not automated in this milestone. If one becomes necessary, mark it for review, take a backup, make its SQL idempotent/resumable, run it as a separately approved release operation, verify the result, and then add an appropriate recorded migration. The current runner rejects the `-- migrate:non-transactional` marker so such work cannot be silently treated as atomic.

## Connectivity verification

With the API running, `GET /api/v1/health/ready` should return 200 and `dependencies.database = "up"`. A 503 is deliberately generic; inspect redacted server logs and Supabase network/database metrics for diagnosis. Never paste the connection string into an issue or log.

## Disposable schema verification and integration tests

Milestone 2 includes a verifier that runs the real migration runner twice, starts concurrent migration runners, exercises PostgreSQL constraints, checks expected foreign keys/indexes, proves cancellation/rebooking behavior, and injects a failing migration to ensure it is rolled back and not recorded.

The booking integration suite starts the compiled NestJS application against another uniquely named schema, sends authenticated HTTP requests, and verifies consultation, idempotency, audit, and outbox state directly through PostgreSQL. It covers concurrent booking, idempotent replay and conflict, cancellation/rebooking history, and rollback after an induced late outbox failure. The suite removes only schemas it successfully created, including after failed setup.

Use only a disposable local database or dedicated Supabase development project. The script creates uniquely named schemas and removes them, but it may temporarily install `pgcrypto`/`btree_gist` when absent. Never point it at production.

```dotenv
SCHEMA_TEST_DATABASE_URL=postgresql://...
SCHEMA_TEST_DATABASE_SSL=true
SCHEMA_TEST_CONFIRM_DISPOSABLE=yes
```

```bash
npm run schema:verify
npm run test:integration
```

The explicit confirmation is a guard against accidental use. Both commands use `SCHEMA_TEST_DATABASE_URL`; the normal application still uses only `DATABASE_URL`, and no second application pool or database provider was added. `SCHEMA_TEST_DATABASE_SSL=true` keeps certificate verification enabled. Set it to `false` only for an explicitly trusted local PostgreSQL server, never to work around a remote certificate error.
