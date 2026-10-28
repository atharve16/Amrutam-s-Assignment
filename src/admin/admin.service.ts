import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { QueryResultRow } from 'pg';
import { postgresErrorCode } from '../common/database/postgres-error';
import { IdempotencyService, requestFingerprint } from '../common/idempotency/idempotency.service';
import { DatabaseService } from '../database/database.service';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';
import { CreateDoctorDto } from './dto/create-doctor.dto';

@Injectable()
export class AdminService {
  constructor(
    private readonly database: DatabaseService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async createVerifiedDoctor(
    adminId: string,
    input: CreateDoctorDto,
    idempotencyKey: string,
    requestId?: string,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.database.withTransaction(async (client) => {
        const started = await this.idempotency.begin(
          client,
          adminId,
          'doctor.verify',
          idempotencyKey,
          requestFingerprint({ ...input }),
        );
        if (started.replay) return started.replay.body;
        const promoted = await client.query(
          `UPDATE users SET role = 'doctor'
           WHERE id = $1 AND role = 'patient' AND status = 'active'
           RETURNING id`,
          [input.userId],
        );
        if (!promoted.rowCount) {
          throw new NotFoundException('Eligible active patient account not found');
        }
        const result = await client.query<{ id: string } & QueryResultRow>(
          `INSERT INTO doctors (
             user_id, license_number, license_jurisdiction, specialization, bio,
             verification_status, verified_by, verified_at
           ) VALUES ($1, $2, $3, $4, $5, 'verified', $6, now())
           RETURNING id`,
          [
            input.userId,
            input.licenseNumber,
            input.licenseJurisdiction,
            input.specialization.trim(),
            input.bio?.trim() || null,
            adminId,
          ],
        );
        const doctorId = result.rows[0]?.id;
        if (!doctorId) throw new Error('Doctor insert returned no row');
        await client.query(
          `INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, request_id)
           VALUES ($1, 'doctor.verified', 'doctor', $2, $3)`,
          [adminId, doctorId, requestId ?? null],
        );
        const body: Record<string, unknown> = {
          id: doctorId,
          userId: input.userId,
          verificationStatus: 'verified',
        };
        await this.idempotency.complete(client, started.id, 201, body, 'doctor', doctorId);
        return body;
      });
    } catch (error) {
      if (postgresErrorCode(error) === '23505') {
        throw new ConflictException('Doctor or professional license already exists');
      }
      throw error;
    }
  }

  async analytics(query: AnalyticsQueryDto): Promise<unknown> {
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from) {
      throw new BadRequestException('to must be later than from');
    }
    if (to.getTime() - from.getTime() > 366 * 86_400_000) {
      throw new BadRequestException('Analytics range cannot exceed 366 days');
    }
    const parameters = [from, to] as const;
    const [consultations, payments, utilization] = await Promise.all([
      this.database.query(
        `SELECT status, count(*)::integer AS count
         FROM consultations
         WHERE created_at >= $1 AND created_at < $2
         GROUP BY status ORDER BY status`,
        parameters,
      ),
      this.database.query(
        `SELECT status, count(*)::integer AS count,
                COALESCE(sum(amount), 0)::text AS "totalAmount",
                currency
         FROM payments
         WHERE created_at >= $1 AND created_at < $2
         GROUP BY status, currency ORDER BY status, currency`,
        parameters,
      ),
      this.database.query(
        `SELECT doctor.id AS "doctorId", profile.full_name AS "doctorName",
                count(slot.id)::integer AS "offeredSlots",
                count(consultation.id) FILTER (WHERE consultation.status <> 'cancelled')::integer
                  AS "bookedSlots"
         FROM doctors AS doctor
         JOIN profiles AS profile ON profile.user_id = doctor.user_id
         LEFT JOIN availability_slots AS slot
           ON slot.doctor_id = doctor.id AND slot.starts_at >= $1 AND slot.starts_at < $2
         LEFT JOIN consultations AS consultation
           ON consultation.slot_id = slot.id AND consultation.status <> 'cancelled'
         GROUP BY doctor.id, profile.full_name
         ORDER BY "bookedSlots" DESC, doctor.id
         LIMIT 100`,
        parameters,
      ),
    ]);
    const totalConsultations = consultations.rows.reduce(
      (sum, row) => sum + Number((row as { count: number }).count),
      0,
    );
    return {
      range: { from: from.toISOString(), to: to.toISOString() },
      totalConsultations,
      consultationsByStatus: consultations.rows,
      paymentsByStatus: payments.rows,
      doctorUtilization: utilization.rows,
    };
  }
}
