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
import { DatabaseService } from '../database/database.service';
import { CreatePrescriptionDto } from './dto/create-prescription.dto';

interface ConsultationRow extends QueryResultRow {
  id: string;
  patient_id: string;
  doctor_id: string;
  doctor_user_id: string;
  status: string;
}

@Injectable()
export class PrescriptionsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async create(
    user: AuthenticatedUser,
    consultationId: string,
    input: CreatePrescriptionDto,
    idempotencyKey: string,
    requestId?: string,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.database.withTransaction(async (client) => {
        const started = await this.idempotency.begin(
          client,
          user.id,
          `prescription.issue:${consultationId}`,
          idempotencyKey,
          requestFingerprint({
            consultationId,
            clinicalNotes: input.clinicalNotes ?? null,
            items: input.items,
          }),
        );
        if (started.replay) return started.replay.body;
        const consultationResult = await client.query<ConsultationRow>(
          `SELECT consultation.id, consultation.patient_id, consultation.doctor_id,
                  consultation.status, doctor.user_id AS doctor_user_id
           FROM consultations AS consultation
           JOIN doctors AS doctor ON doctor.id = consultation.doctor_id
           WHERE consultation.id = $1
           FOR UPDATE OF consultation`,
          [consultationId],
        );
        const consultation = consultationResult.rows[0];
        if (!consultation) throw new NotFoundException('Consultation not found');
        if (consultation.doctor_user_id !== user.id) {
          throw new ForbiddenException('Only the assigned doctor can issue a prescription');
        }
        if (consultation.status !== 'completed') {
          throw new ConflictException(
            'A prescription can be issued only after consultation completion',
          );
        }

        const prescriptionResult = await client.query<{ id: string } & QueryResultRow>(
          `INSERT INTO prescriptions (
             consultation_id, doctor_id, status, clinical_notes, issued_at
           ) VALUES ($1, $2, 'issued', $3, now())
           RETURNING id`,
          [consultationId, consultation.doctor_id, input.clinicalNotes ?? null],
        );
        const prescriptionId = prescriptionResult.rows[0]?.id;
        if (!prescriptionId) throw new Error('Prescription insert returned no row');
        for (const item of input.items) {
          await client.query(
            `INSERT INTO prescription_items (
               prescription_id, medication_name, dosage, frequency, duration, instructions
             ) VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              prescriptionId,
              item.medicationName.trim(),
              item.dosage.trim(),
              item.frequency.trim(),
              item.duration.trim(),
              item.instructions?.trim() || null,
            ],
          );
        }
        await client.query(
          `INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, request_id)
           VALUES ($1, 'prescription.issued', 'prescription', $2, $3)`,
          [user.id, prescriptionId, requestId ?? null],
        );
        const body: Record<string, unknown> = {
          id: prescriptionId,
          consultationId,
          status: 'issued',
          clinicalNotes: input.clinicalNotes ?? null,
          items: input.items,
        };
        await this.idempotency.complete(
          client,
          started.id,
          201,
          body,
          'prescription',
          prescriptionId,
        );
        return body;
      });
    } catch (error) {
      if (postgresErrorCode(error) === '23505') {
        throw new ConflictException('An issued prescription already exists for this consultation');
      }
      throw error;
    }
  }

  async list(user: AuthenticatedUser, consultationId: string): Promise<unknown[]> {
    const access = await this.database.query<ConsultationRow>(
      `SELECT consultation.id, consultation.patient_id, consultation.doctor_id,
              consultation.status, doctor.user_id AS doctor_user_id
       FROM consultations AS consultation
       JOIN doctors AS doctor ON doctor.id = consultation.doctor_id
       WHERE consultation.id = $1`,
      [consultationId],
    );
    const consultation = access.rows[0];
    if (!consultation) throw new NotFoundException('Consultation not found');
    const allowed =
      user.role === 'admin' ||
      (user.role === 'patient' && user.id === consultation.patient_id) ||
      (user.role === 'doctor' && user.id === consultation.doctor_user_id);
    if (!allowed) throw new ForbiddenException('You do not have access to these prescriptions');

    const prescriptions = await this.database.query(
      `SELECT id, consultation_id AS "consultationId", version, status,
              clinical_notes AS "clinicalNotes", issued_at AS "issuedAt"
       FROM prescriptions WHERE consultation_id = $1 ORDER BY version DESC`,
      [consultationId],
    );
    const output: unknown[] = [];
    for (const prescription of prescriptions.rows as Array<Record<string, unknown>>) {
      const items = await this.database.query(
        `SELECT id, medication_name AS "medicationName", dosage, frequency, duration, instructions
         FROM prescription_items WHERE prescription_id = $1 ORDER BY created_at, id`,
        [prescription.id],
      );
      output.push({ ...prescription, items: items.rows });
    }
    return output;
  }
}
