import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { QueryResultRow } from 'pg';
import { TransactionClient } from '../../database/database.service';

interface IdempotencyRow extends QueryResultRow {
  id: string;
  request_fingerprint: string;
  status: 'processing' | 'completed' | 'failed';
  response_status: number | null;
  response_body: Record<string, unknown> | null;
  resource_id: string | null;
}

export interface IdempotencyStart {
  id: string;
  replay?: {
    statusCode: number;
    body: Record<string, unknown>;
  };
}

export function requestFingerprint(payload: Record<string, unknown>): string {
  const canonical = JSON.stringify(canonicalize(payload));
  return createHash('sha256').update(canonical).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

export function requireIdempotencyKey(value: string | undefined): string {
  const key = value?.trim();
  if (!key) throw new BadRequestException('Idempotency-Key header is required');
  if (key.length > 200)
    throw new BadRequestException('Idempotency-Key must not exceed 200 characters');
  return key;
}

@Injectable()
export class IdempotencyService {
  async begin(
    client: TransactionClient,
    actorId: string,
    operation: string,
    key: string,
    fingerprint: string,
  ): Promise<IdempotencyStart> {
    const inserted = await client.query<{ id: string } & QueryResultRow>(
      `INSERT INTO idempotency_records (
         actor_id, operation, idempotency_key, request_fingerprint, expires_at
       ) VALUES ($1, $2, $3, $4, now() + interval '24 hours')
       ON CONFLICT (actor_id, operation, idempotency_key) WHERE actor_id IS NOT NULL
       DO NOTHING
       RETURNING id`,
      [actorId, operation, key, fingerprint],
    );
    const insertedId = inserted.rows[0]?.id;
    if (insertedId) return { id: insertedId };

    const existing = await client.query<IdempotencyRow>(
      `SELECT id, request_fingerprint, status, response_status, response_body, resource_id
       FROM idempotency_records
       WHERE actor_id = $1 AND operation = $2 AND idempotency_key = $3
       FOR UPDATE`,
      [actorId, operation, key],
    );
    const record = existing.rows[0];
    if (!record) throw new ConflictException('Idempotency request could not be resolved');
    if (record.request_fingerprint !== fingerprint) {
      throw new ConflictException('Idempotency-Key was already used with a different request');
    }
    if (record.status === 'processing' || !record.response_status || !record.response_body) {
      throw new ConflictException('An identical request is still being processed');
    }
    return {
      id: record.id,
      replay: { statusCode: record.response_status, body: record.response_body },
    };
  }

  async complete(
    client: TransactionClient,
    id: string,
    statusCode: number,
    body: Record<string, unknown>,
    resourceType: string,
    resourceId: string,
  ): Promise<void> {
    await client.query(
      `UPDATE idempotency_records
       SET status = 'completed', response_status = $2, response_body = $3::jsonb,
           resource_type = $4, resource_id = $5
       WHERE id = $1 AND status = 'processing'`,
      [id, statusCode, JSON.stringify(body), resourceType, resourceId],
    );
  }
}
