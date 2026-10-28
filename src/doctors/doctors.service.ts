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
import { CreateAvailabilityDto } from './dto/create-availability.dto';
import { AvailabilityQueryDto, DoctorSearchDto } from './dto/doctor-search.dto';

interface DoctorListRow extends QueryResultRow {
  total_count: string;
  id: string;
  full_name: string;
  specialization: string;
  bio: string | null;
  license_number: string;
  license_jurisdiction: string;
}

@Injectable()
export class DoctorsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async search(query: DoctorSearchDto): Promise<unknown> {
    this.validateRange(query.availableFrom, query.availableTo);
    const values: unknown[] = [];
    const conditions = [`doctor.verification_status = 'verified'`, `app_user.status = 'active'`];
    const add = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };
    if (query.q?.trim()) {
      const parameter = add(`%${query.q.trim()}%`);
      conditions.push(
        `(profile.full_name ILIKE ${parameter} OR doctor.specialization ILIKE ${parameter} OR doctor.license_number ILIKE ${parameter})`,
      );
    }
    if (query.specialization?.trim()) {
      conditions.push(`doctor.specialization ILIKE ${add(query.specialization.trim())}`);
    }
    if (query.availableFrom && query.availableTo) {
      const from = add(query.availableFrom);
      const to = add(query.availableTo);
      conditions.push(`EXISTS (
        SELECT 1 FROM availability_slots AS slot
        WHERE slot.doctor_id = doctor.id AND slot.status = 'open'
          AND slot.starts_at >= ${from}::timestamptz AND slot.ends_at <= ${to}::timestamptz
          AND NOT EXISTS (
            SELECT 1 FROM consultations AS consultation
            WHERE consultation.slot_id = slot.id AND consultation.status <> 'cancelled'
          )
      )`);
    }
    const limit = add(query.limit);
    const offset = add((query.page - 1) * query.limit);
    const result = await this.database.query<DoctorListRow>(
      `SELECT doctor.id, profile.full_name, doctor.specialization, doctor.bio,
              doctor.license_number, doctor.license_jurisdiction,
              count(*) OVER()::text AS total_count
       FROM doctors AS doctor
       JOIN users AS app_user ON app_user.id = doctor.user_id
       JOIN profiles AS profile ON profile.user_id = doctor.user_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY doctor.specialization, profile.full_name, doctor.id
       LIMIT ${limit} OFFSET ${offset}`,
      values,
    );
    const total = Number(result.rows[0]?.total_count ?? 0);
    return {
      data: result.rows.map((row) => ({
        id: row.id,
        full_name: row.full_name,
        specialization: row.specialization,
        bio: row.bio,
        license_number: row.license_number,
        license_jurisdiction: row.license_jurisdiction,
      })),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        pages: Math.ceil(total / query.limit),
      },
    };
  }

  async availability(doctorId: string, query: AvailabilityQueryDto): Promise<unknown[]> {
    this.validateRange(query.from, query.to);
    const doctor = await this.database.query(
      `SELECT 1 FROM doctors WHERE id = $1 AND verification_status = 'verified'`,
      [doctorId],
    );
    if (!doctor.rowCount) throw new NotFoundException('Doctor not found');
    const result = await this.database.query(
      `SELECT slot.id, slot.starts_at AS "startsAt", slot.ends_at AS "endsAt"
       FROM availability_slots AS slot
       WHERE slot.doctor_id = $1 AND slot.status = 'open'
         AND slot.starts_at >= $2::timestamptz AND slot.ends_at <= $3::timestamptz
         AND NOT EXISTS (
           SELECT 1 FROM consultations AS consultation
           WHERE consultation.slot_id = slot.id AND consultation.status <> 'cancelled'
         )
       ORDER BY slot.starts_at, slot.id
       LIMIT 500`,
      [doctorId, query.from, query.to],
    );
    return result.rows;
  }

  async createAvailability(
    userId: string,
    input: CreateAvailabilityDto,
    idempotencyKey: string,
    requestId?: string,
  ): Promise<Record<string, unknown>> {
    this.validateRange(input.startsAt, input.endsAt);
    if (new Date(input.startsAt).getTime() <= Date.now()) {
      throw new BadRequestException('Availability must start in the future');
    }
    try {
      return await this.database.withTransaction(async (client) => {
        const started = await this.idempotency.begin(
          client,
          userId,
          'availability.create',
          idempotencyKey,
          requestFingerprint({ startsAt: input.startsAt, endsAt: input.endsAt }),
        );
        if (started.replay) return started.replay.body;
        const result = await client.query(
          `INSERT INTO availability_slots (doctor_id, starts_at, ends_at)
           SELECT doctor.id, $2::timestamptz, $3::timestamptz
           FROM doctors AS doctor
           WHERE doctor.user_id = $1 AND doctor.verification_status = 'verified'
           RETURNING id, doctor_id AS "doctorId", starts_at AS "startsAt",
                     ends_at AS "endsAt", status`,
          [userId, input.startsAt, input.endsAt],
        );
        const slot = result.rows[0] as Record<string, unknown> | undefined;
        if (!slot) throw new NotFoundException('Verified doctor profile not found');
        await client.query(
          `INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, request_id)
           VALUES ($1, 'availability.created', 'availability_slot', $2, $3)`,
          [userId, slot.id, requestId ?? null],
        );
        await this.idempotency.complete(
          client,
          started.id,
          201,
          slot,
          'availability_slot',
          String(slot.id),
        );
        return slot;
      });
    } catch (error) {
      if (postgresErrorCode(error) === '23P01') {
        throw new ConflictException('Availability overlaps an existing active interval');
      }
      throw error;
    }
  }

  private validateRange(from: string | undefined, to: string | undefined): void {
    if ((from && !to) || (!from && to)) {
      throw new BadRequestException('Both range boundaries are required');
    }
    if (!from || !to) return;
    const start = new Date(from).getTime();
    const end = new Date(to).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new BadRequestException('Range end must be later than range start');
    }
  }
}
