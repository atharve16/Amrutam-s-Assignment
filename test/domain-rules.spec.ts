import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminController } from '../src/admin/admin.controller';
import { durationToSeconds } from '../src/auth/auth.service';
import { ROLES_KEY } from '../src/auth/decorators/roles.decorator';
import { RegisterDto } from '../src/auth/dto/register.dto';
import {
  requestFingerprint,
  requireIdempotencyKey,
} from '../src/common/idempotency/idempotency.service';
import { canTransitionConsultation } from '../src/consultations/consultation-rules';
import { BookConsultationDto } from '../src/consultations/dto/book-consultation.dto';
import { CreateAvailabilityDto } from '../src/doctors/dto/create-availability.dto';
import { CreatePaymentDto } from '../src/payments/dto/create-payment.dto';
import { CreatePrescriptionDto } from '../src/prescriptions/dto/create-prescription.dto';

const strictPipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  forbidUnknownValues: true,
});

void describe('MVP security and domain rules', () => {
  void it('rejects public role assignment and weak registration passwords', async () => {
    await assert.rejects(
      strictPipe.transform(
        {
          email: 'patient@example.com',
          password: 'weak',
          fullName: 'Patient',
          timezone: 'UTC',
          role: 'admin',
        },
        { type: 'body', metatype: RegisterDto },
      ),
    );
    const errors = await validate(
      plainToInstance(RegisterDto, {
        email: 'patient@example.com',
        password: 'alllowercase123!',
        fullName: 'Patient',
        timezone: 'UTC',
      }),
    );
    assert.ok(errors.some((error) => error.property === 'password'));
  });

  void it('validates booking UUIDs and UTC-aware availability timestamps', async () => {
    const bookingErrors = await validate(
      plainToInstance(BookConsultationDto, { slotId: 'not-a-uuid' }),
    );
    assert.ok(bookingErrors.some((error) => error.property === 'slotId'));
    const timeErrors = await validate(
      plainToInstance(CreateAvailabilityDto, {
        startsAt: '2026-11-01T09:00:00',
        endsAt: '2026-11-01T09:30:00',
      }),
    );
    assert.equal(timeErrors.length, 2);
  });

  void it('creates stable idempotency fingerprints and rejects missing keys', () => {
    assert.equal(
      requestFingerprint({ amount: '10.00', slotId: 'a' }),
      requestFingerprint({ slotId: 'a', amount: '10.00' }),
    );
    assert.equal(
      requestFingerprint({ items: [{ dosage: '1', medication: 'A' }] }),
      requestFingerprint({ items: [{ medication: 'A', dosage: '1' }] }),
    );
    assert.notEqual(requestFingerprint({ slotId: 'a' }), requestFingerprint({ slotId: 'b' }));
    assert.throws(() => requireIdempotencyKey(undefined), /required/);
  });

  void it('enforces patient, doctor, and terminal consultation transitions', () => {
    assert.equal(canTransitionConsultation('scheduled', 'cancelled', 'patient'), true);
    assert.equal(canTransitionConsultation('scheduled', 'in_progress', 'patient'), false);
    assert.equal(canTransitionConsultation('scheduled', 'in_progress', 'doctor'), true);
    assert.equal(canTransitionConsultation('in_progress', 'completed', 'doctor'), true);
    assert.equal(canTransitionConsultation('completed', 'cancelled', 'admin'), false);
  });

  void it('validates prescription items and prevents client-supplied payment status', async () => {
    const prescriptionErrors = await validate(
      plainToInstance(CreatePrescriptionDto, { clinicalNotes: 'Complete', items: [] }),
    );
    assert.ok(prescriptionErrors.some((error) => error.property === 'items'));
    await assert.rejects(
      strictPipe.transform(
        { amount: '499.00', currency: 'INR', status: 'succeeded' },
        { type: 'body', metatype: CreatePaymentDto },
      ),
    );
  });

  void it('marks the administration controller as admin-only', () => {
    assert.deepEqual(Reflect.getMetadata(ROLES_KEY, AdminController) as unknown, ['admin']);
  });

  void it('converts validated JWT durations to whole seconds', () => {
    assert.equal(durationToSeconds('15m'), 900);
    assert.equal(durationToSeconds('1h'), 3600);
  });
});
