# Development workflow

## Local loop

1. Use a supported Node LTS version and run `npm ci`.
2. Copy `.env.example` to `.env` and supply private values.
3. Add schema changes as a new ordered SQL migration.
4. Run `npm run migration:run` against a dedicated development Supabase project.
5. Start the API with `npm run start:dev`.
6. Exercise routes through Swagger at `/api/docs` or a Postman collection when domain routes are introduced.
7. Before committing, run the same verification sequence as CI.

```bash
npm run format:check
npm run lint
npm run typecheck
npm run build
npm test
```

`npm test` uses Node's built-in runner. The HTTP smoke test launches the compiled API with a deliberately unreachable database, proving liveness remains 200, readiness becomes a sanitized 503, request IDs propagate, and Swagger is available. It does not require production secrets or a Supabase project.

For a configured development database, separately run migrations and `npm run smoke`. This is intentionally outside secret-free CI until an isolated CI database is provisioned.

Schema changes also require the real PostgreSQL verifier against a disposable database:

```bash
SCHEMA_TEST_CONFIRM_DISPOSABLE=yes npm run schema:verify
```

Set `SCHEMA_TEST_DATABASE_URL` and TLS options as described in `docs/database-setup.md`. Static migration-contract tests run in ordinary `npm test`; they do not replace this database execution.

## Adding an endpoint

Create an explicit DTO for every body, path parameter set, and query string. Document success and error responses with Swagger. Keep transport mapping in the controller, business decisions in the service, and readable parameterized SQL with the owning module. Use `DatabaseService.withTransaction` for multi-step atomic work. Do not pass user values into SQL text.

Add built-in tests for validation and business rules, and a repeatable HTTP check for route behavior. Tests must not depend on order, real patient data, or production credentials.

## Migration review

Review constraints, indexes, lock duration, reversibility, and expected table size. Apply a migration to a disposable development project before shared environments. Checksums make applied-file edits fail loudly. Production migration execution is an explicit release step, never automatic application startup behavior.

## CI and releases

GitHub Actions installs exactly from `package-lock.json`, checks formatting and lint, typechecks, builds, runs tests, and performs a high-severity dependency audit. A future deployment workflow should build an immutable image, scan it, apply migrations once, roll out the API, observe readiness, and support rollback. CI configuration alone is not evidence that a workflow has passed; confirm the first hosted run after pushing.

Update the requirement checklist and architecture documents in the same change when behavior or a major decision changes.
