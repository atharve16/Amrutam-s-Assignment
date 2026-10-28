import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { QueryResultRow } from 'pg';
import { AuthenticatedUser } from '../auth/auth.types';
import { IdempotencyService, requestFingerprint } from '../common/idempotency/idempotency.service';
import { DatabaseService } from '../database/database.service';
import { CreatePaymentDto } from './dto/create-payment.dto';

interface ConsultationPaymentAccess extends QueryResultRow {
  patient_id: string;
  doctor_user_id: string;
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async create(
    user: AuthenticatedUser,
    consultationId: string,
    input: CreatePaymentDto,
    idempotencyKey: string,
    requestId?: string,
  ): Promise<Record<string, unknown>> {
    if (Number(input.amount) <= 0)
      throw new BadRequestException('Payment amount must be greater than zero');
    return this.database.withTransaction(async (client) => {
      const fingerprint = requestFingerprint({
        consultationId,
        amount: input.amount,
        currency: input.currency,
      });
      const idempotency = await this.idempotency.begin(
        client,
        user.id,
        `payment.create:${consultationId}`,
        idempotencyKey,
        fingerprint,
      );
      if (idempotency.replay) return idempotency.replay.body;

      const consultation = await client.query<ConsultationPaymentAccess>(
        `SELECT consultation.patient_id, doctor.user_id AS doctor_user_id
         FROM consultations AS consultation
         JOIN doctors AS doctor ON doctor.id = consultation.doctor_id
         WHERE consultation.id = $1
         FOR SHARE OF consultation`,
        [consultationId],
      );
      const access = consultation.rows[0];
      if (!access) throw new NotFoundException('Consultation not found');
      if (access.patient_id !== user.id) {
        throw new ForbiddenException('Only the consultation patient can create a payment attempt');
      }
      const inserted = await client.query<{ id: string; created_at: Date } & QueryResultRow>(
        `INSERT INTO payments (consultation_id, amount, currency, status)
         VALUES ($1, $2::numeric, $3, 'created')
         RETURNING id, created_at`,
        [consultationId, input.amount, input.currency],
      );
      const payment = inserted.rows[0];
      if (!payment) throw new Error('Payment insert returned no row');
      const body: Record<string, unknown> = {
        id: payment.id,
        consultationId,
        amount: input.amount,
        currency: input.currency,
        status: 'created',
        mode: 'record_only',
        createdAt: payment.created_at,
      };
      await client.query(
        `INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, request_id)
         VALUES ($1, 'payment.attempt_created', 'payment', $2, $3)`,
        [user.id, payment.id, requestId ?? null],
      );
      await this.idempotency.complete(client, idempotency.id, 201, body, 'payment', payment.id);
      return body;
    });
  }

  async list(user: AuthenticatedUser, consultationId: string): Promise<unknown[]> {
    const accessResult = await this.database.query<ConsultationPaymentAccess>(
      `SELECT consultation.patient_id, doctor.user_id AS doctor_user_id
       FROM consultations AS consultation
       JOIN doctors AS doctor ON doctor.id = consultation.doctor_id
       WHERE consultation.id = $1`,
      [consultationId],
    );
    const access = accessResult.rows[0];
    if (!access) throw new NotFoundException('Consultation not found');
    const allowed =
      user.role === 'admin' ||
      (user.role === 'patient' && user.id === access.patient_id) ||
      (user.role === 'doctor' && user.id === access.doctor_user_id);
    if (!allowed) throw new ForbiddenException('You do not have access to these payment records');
    const result = await this.database.query(
      `SELECT id, consultation_id AS "consultationId", amount::text, currency, status,
              provider, provider_reference AS "providerReference", created_at AS "createdAt"
       FROM payments WHERE consultation_id = $1 ORDER BY created_at DESC, id`,
      [consultationId],
    );
    return result.rows;
  }
}
