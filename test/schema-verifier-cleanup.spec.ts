import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  cleanupOwnedSchemas,
  createOwnedSchema,
  SchemaLifecycleClient,
} from '../scripts/schema-verifier-cleanup';

class FakeSchemaClient implements SchemaLifecycleClient {
  readonly queries: string[] = [];
  endCalls = 0;
  createFailure?: string;
  dropFailures = new Set<string>();

  query(text: string): Promise<unknown> {
    this.queries.push(text);
    if (this.createFailure && text === `CREATE SCHEMA "${this.createFailure}"`) {
      return Promise.reject(new Error('create failed'));
    }
    for (const schema of this.dropFailures) {
      if (text === `DROP SCHEMA "${schema}" CASCADE`) {
        return Promise.reject(new Error(`drop failed for ${schema}`));
      }
    }
    return Promise.resolve(undefined);
  }

  end(): Promise<void> {
    this.endCalls += 1;
    return Promise.resolve();
  }
}

void describe('schema verifier cleanup ownership', () => {
  void it('never drops a schema whose creation failed', async () => {
    const client = new FakeSchemaClient();
    const ownedSchemas = new Set<string>();
    client.createFailure = 'already_exists';

    await assert.rejects(createOwnedSchema(client, ownedSchemas, 'already_exists'));
    await cleanupOwnedSchemas(client, ownedSchemas);

    assert.deepEqual([...ownedSchemas], []);
    assert.deepEqual(client.queries, ['CREATE SCHEMA "already_exists"']);
    assert.equal(client.endCalls, 1);
  });

  void it('drops only schemas successfully created by this invocation', async () => {
    const client = new FakeSchemaClient();
    const ownedSchemas = new Set<string>();

    await createOwnedSchema(client, ownedSchemas, 'created_here');
    client.createFailure = 'pre_existing';
    await assert.rejects(createOwnedSchema(client, ownedSchemas, 'pre_existing'));
    await cleanupOwnedSchemas(client, ownedSchemas);

    const dropQueries = client.queries.filter((query) => query.startsWith('DROP SCHEMA'));
    assert.deepEqual(dropQueries, ['DROP SCHEMA "created_here" CASCADE']);
    assert.equal(client.endCalls, 1);
  });

  void it('attempts every owned schema and closes the client when a drop fails', async () => {
    const client = new FakeSchemaClient();
    const ownedSchemas = new Set<string>();

    await createOwnedSchema(client, ownedSchemas, 'extension_schema');
    await createOwnedSchema(client, ownedSchemas, 'primary_schema');
    client.dropFailures.add('primary_schema');

    await assert.rejects(
      cleanupOwnedSchemas(client, ownedSchemas),
      (error: unknown) => error instanceof AggregateError && error.errors.length === 1,
    );

    const dropQueries = client.queries.filter((query) => query.startsWith('DROP SCHEMA'));
    assert.deepEqual(dropQueries, [
      'DROP SCHEMA "primary_schema" CASCADE',
      'DROP SCHEMA "extension_schema" CASCADE',
    ]);
    assert.equal(client.endCalls, 1);
  });
});
