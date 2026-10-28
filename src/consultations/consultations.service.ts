import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { QueryResultRow } from 'pg';
import { AuthenticatedUser } from '../auth/auth.types';
import { postgresErrorCode } from '../common/database/postgres-error';
import { IdempotencyService, requestFingerprint } from '../common/idempotency/idempotency.service';
import { DatabaseService, TransactionClient } from '../database/database.service';
import { canTransitionConsultation } from './consultation-rules';
import { BookConsultationDto } from './dto/book-consultation.dto';
import { ConsultationQueryDto, ConsultationStatus } from './dto/consultation-query.dto';
import { TransitionConsultationDto } from './dto/transition-consultation.dto';

interface SlotRow extends QueryResultRow {
  id: string;
  doctor_id: string;
  starts_at: Date;
  ends_at: Date;
  status: string;
}

interface ConsultationAccessRow extends QueryResultRow {
  id: string;
  patient_id: string;
  doctor_id: string;
  doctor_user_id: string;
  status: ConsultationStatus;
}

@Injectable()
export class ConsultationsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async book(
    user: AuthenticatedUser,
    input: BookConsultationDto,
    idempotencyKey: string,
    requestId?: string,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.database.withTransaction(async (client) => {
        const fingerprint = requestFingerprint({ slotId: input.slotId });
        const idempotency = await this.idempotency.begin(
          client,
          user.id,
          'consultation.book',
          idempotencyKey,
          fingerprint,
        );
        if (idempotency.replay) return idempotency.replay.body;

        const slotResult = await client.query<SlotRow>(
          `SELECT slot.id, slot.doctor_id, slot.starts_at, slot.ends_at, slot.status
           FROM availability_slots AS slot
           JOIN doctors AS doctor ON doctor.id = slot.doctor_id
           JOIN users AS doctor_user ON doctor_user.id = doctor.user_id
           WHERE slot.id = $1 AND doctor.verification_status = 'verified'
             AND doctor_user.status = 'active'
           FOR UPDATE OF slot`,
          [input.slotId],
        );
        const slot = slotResult.rows[0];
        if (!slot) throw new NotFoundException('Available slot not found');
        if (slot.status !== 'open' || slot.starts_at.getTime() <= Date.now()) {
          throw new ConflictException('Slot is not available for booking');
        }

        const inserted = await client.query<{ id: string } & QueryResultRow>(
          `INSERT INTO consultations (
             patient_id, doctor_id, slot_id, scheduled_start_at, scheduled_end_at
           ) VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [user.id, slot.doctor_id, slot.id, slot.starts_at, slot.ends_at],
        );
        const consultationId = inserted.rows[0]?.id;
        if (!consultationId) throw new Error('Consultation insert returned no row');
        const body: Record<string, unknown> = {
          id: consultationId,
          patientId: user.id,
          doctorId: slot.doctor_id,
          slotId: slot.id,
          scheduledStartAt: slot.starts_at,
          scheduledEndAt: slot.ends_at,
          status: 'scheduled',
        };
        await this.audit(client, user.id, 'consultation.booked', consultationId, requestId);
        await client.query(
          `INSERT INTO outbox_events (
             event_type, aggregate_type, aggregate_id, deduplication_key, payload
           ) VALUES ('consultation.booked', 'consultation', $1, $2, $3::jsonb)`,
          [
            consultationId,
            `consultation.booked:${consultationId}`,
            JSON.stringify({ consultationId }),
          ],
        );
        await this.idempotency.complete(
          client,
          idempotency.id,
          201,
          body,
          'consultation',
          consultationId,
        );
        return body;
      });
    } catch (error) {
      if (postgresErrorCode(error) === '23505') {
        throw new ConflictException('Slot has already been booked');
      }
      throw error;
    }
  }

  async list(user: AuthenticatedUser, query: ConsultationQueryDto): Promise<unknown> {
    const values: unknown[] = [];
    const add = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };
    const conditions: string[] = [];
    if (user.role === 'patient') conditions.push(`consultation.patient_id = ${add(user.id)}`);
    if (user.role === 'doctor') conditions.push(`doctor.user_id = ${add(user.id)}`);
    if (query.status) conditions.push(`consultation.status = ${add(query.status)}`);
    const limit = add(query.limit);
    const offset = add((query.page - 1) * query.limit);
    const result = await this.database.query(
      `SELECT consultation.id, consultation.patient_id AS "patientId",
              consultation.doctor_id AS "doctorId", consultation.slot_id AS "slotId",
              consultation.scheduled_start_at AS "scheduledStartAt",
              consultation.scheduled_end_at AS "scheduledEndAt", consultation.status,
              doctor_profile.full_name AS "doctorName",
              count(*) OVER()::text AS "totalCount"
       FROM consultations AS consultation
       JOIN doctors AS doctor ON doctor.id = consultation.doctor_id
       JOIN profiles AS doctor_profile ON doctor_profile.user_id = doctor.user_id
       ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY consultation.scheduled_start_at DESC, consultation.id
       LIMIT ${limit} OFFSET ${offset}`,
      values,
    );
    const rows = result.rows as Array<Record<string, unknown> & { totalCount: string }>;
    const total = Number(rows[0]?.totalCount ?? 0);
    return {
      data: rows.map((row) => {
        const copy: Record<string, unknown> = { ...row };
        delete copy.totalCount;
        return copy;
      }),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        pages: Math.ceil(total / query.limit),
      },
    };
  }

  async detail(user: AuthenticatedUser, consultationId: string): Promise<unknown> {
    const result = await this.database.query(
      `SELECT consultation.id, consultation.patient_id AS "patientId",
              consultation.doctor_id AS "doctorId", consultation.slot_id AS "slotId",
              consultation.scheduled_start_at AS "scheduledStartAt",
              consultation.scheduled_end_at AS "scheduledEndAt", consultation.status,
              consultation.started_at AS "startedAt", consultation.completed_at AS "completedAt",
              consultation.cancelled_at AS "cancelledAt",
              consultation.cancellation_reason AS "cancellationReason",
              doctor.user_id AS "doctorUserId"
       FROM consultations AS consultation
       JOIN doctors AS doctor ON doctor.id = consultation.doctor_id
       WHERE consultation.id = $1`,
      [consultationId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundException('Consultation not found');
    this.assertAccess(user, String(row.patientId), String(row.doctorUserId));
    const response = { ...row };
    delete response.doctorUserId;
    return response;
  }

  async transition(
    user: AuthenticatedUser,
    consultationId: string,
    input: TransitionConsultationDto,
    idempotencyKey: string,
    requestId?: string,
  ): Promise<Record<string, unknown>> {
    return this.database.withTransaction(async (client) => {
      const fingerprint = requestFingerprint({
        consultationId,
        status: input.status,
        cancellationReason: input.cancellationReason ?? null,
      });
      const idempotency = await this.idempotency.begin(
        client,
        user.id,
        `consultation.transition:${consultationId}`,
        idempotencyKey,
        fingerprint,
      );
      if (idempotency.replay) return idempotency.replay.body;

      const currentResult = await client.query<ConsultationAccessRow>(
        `SELECT consultation.id, consultation.patient_id, consultation.doctor_id,
                consultation.status, doctor.user_id AS doctor_user_id
         FROM consultations AS consultation
         JOIN doctors AS doctor ON doctor.id = consultation.doctor_id
         WHERE consultation.id = $1
         FOR UPDATE OF consultation`,
        [consultationId],
      );
      const current = currentResult.rows[0];
      if (!current) throw new NotFoundException('Consultation not found');
      this.assertAccess(user, current.patient_id, current.doctor_user_id);
      if (!canTransitionConsultation(current.status, input.status, user.role)) {
        throw new ConflictException(
          `Cannot transition consultation from ${current.status} to ${input.status}`,
        );
      }
      if (input.status === 'cancelled' && !input.cancellationReason?.trim()) {
        throw new ConflictException('A cancellation reason is required');
      }

      const updated = await client.query(
        `UPDATE consultations
         SET status = $2,
             started_at = CASE
               WHEN $2 IN ('in_progress', 'completed') THEN COALESCE(started_at, now())
               ELSE started_at
             END,
             completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE NULL END,
             cancelled_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE NULL END,
             cancelled_by = CASE WHEN $2 = 'cancelled' THEN $3::uuid ELSE NULL END,
             cancellation_reason = CASE WHEN $2 = 'cancelled' THEN $4 ELSE NULL END
         WHERE id = $1
         RETURNING id, status, started_at AS "startedAt", completed_at AS "completedAt",
                   cancelled_at AS "cancelledAt", cancellation_reason AS "cancellationReason"`,
        [consultationId, input.status, user.id, input.cancellationReason ?? null],
      );
      const body = updated.rows[0] as Record<string, unknown>;
      await this.audit(client, user.id, `consultation.${input.status}`, consultationId, requestId);
      await client.query(
        `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, deduplication_key, payload)
         VALUES ($1, 'consultation', $2, $3, $4::jsonb)`,
        [
          `consultation.${input.status}`,
          consultationId,
          `consultation.${input.status}:${consultationId}`,
          JSON.stringify({ consultationId, status: input.status }),
        ],
      );
      await this.idempotency.complete(
        client,
        idempotency.id,
        200,
        body,
        'consultation',
        consultationId,
      );
      return body;
    });
  }

  private assertAccess(user: AuthenticatedUser, patientId: string, doctorUserId: string): void {
    if (user.role === 'admin') return;
    if (user.role === 'patient' && user.id === patientId) return;
    if (user.role === 'doctor' && user.id === doctorUserId) return;
    throw new ForbiddenException('You do not have access to this consultation');
  }

  private async audit(
    client: TransactionClient,
    actorId: string,
    action: string,
    consultationId: string,
    requestId?: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, request_id)
       VALUES ($1, $2, 'consultation', $3, $4)`,
      [actorId, action, consultationId, requestId ?? null],
    );
  }
}
