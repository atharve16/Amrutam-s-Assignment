import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { JsonLogger } from '../common/logging/json-logger.service';
import type { DatabaseConfig } from '../config/configuration.types';

export interface TransactionClient {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly pool: Pool;
  private isClosed = false;

  constructor(
    configService: ConfigService,
    private readonly logger: JsonLogger,
  ) {
    const config = configService.getOrThrow<DatabaseConfig>('database');
    this.pool = new Pool({
      connectionString: config.url,
      application_name: 'amrutam-api',
      max: config.poolMax,
      connectionTimeoutMillis: config.connectionTimeoutMs,
      idleTimeoutMillis: config.idleTimeoutMs,
      ssl: config.ssl ? { rejectUnauthorized: true } : false,
    });
    this.pool.on('error', (error) => {
      this.logger.error('Unexpected idle PostgreSQL client error', {
        event: 'database_pool_error',
        error,
      });
    });
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    return this.pool.query<Row>(text, [...values]);
  }

  async withTransaction<T>(work: (client: TransactionClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(this.transactionClient(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        this.logger.error('PostgreSQL transaction rollback failed', {
          event: 'database_rollback_failed',
          rollbackError,
        });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async isReady(): Promise<boolean> {
    try {
      await this.query('SELECT 1');
      return true;
    } catch (error) {
      this.logger.warn('PostgreSQL readiness check failed', {
        event: 'database_readiness_failed',
        error,
      });
      return false;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    await this.pool.end();
    this.logger.log({ event: 'database_pool_closed' });
  }

  private transactionClient(client: PoolClient): TransactionClient {
    return {
      query: async <Row extends QueryResultRow = QueryResultRow>(
        text: string,
        values: readonly unknown[] = [],
      ): Promise<QueryResult<Row>> => client.query<Row>(text, [...values]),
    };
  }
}
