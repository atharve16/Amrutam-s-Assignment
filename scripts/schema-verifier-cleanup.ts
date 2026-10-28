export interface SchemaLifecycleClient {
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
}

export function quoteIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) {
    throw new Error('Generated SQL identifier was not safe');
  }
  return `"${identifier}"`;
}

export async function createOwnedSchema(
  client: SchemaLifecycleClient,
  ownedSchemas: Set<string>,
  schema: string,
): Promise<void> {
  await client.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  // Ownership is recorded only after PostgreSQL confirms that this invocation created the schema.
  ownedSchemas.add(schema);
}

export async function cleanupOwnedSchemas(
  client: SchemaLifecycleClient,
  ownedSchemas: ReadonlySet<string>,
): Promise<void> {
  const failures: unknown[] = [];

  // Reverse creation order keeps extension schemas alive until dependent test schemas are removed.
  for (const schema of [...ownedSchemas].reverse()) {
    try {
      await client.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    } catch (error) {
      failures.push(new Error(`Failed to clean up owned schema ${schema}`, { cause: error }));
    }
  }

  try {
    await client.end();
  } catch (error) {
    failures.push(
      new Error('Failed to close the schema verifier administrative client', { cause: error }),
    );
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, 'Schema verifier cleanup failed');
  }
}
