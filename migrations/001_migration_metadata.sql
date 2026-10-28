-- This first recorded migration documents the bootstrap table owned by scripts/migrate.ts.
-- Future schema changes must be added as new, ordered files; applied files are immutable.
COMMENT ON TABLE schema_migrations IS
  'Immutable history of SQL migrations applied by the Amrutam migration runner';
