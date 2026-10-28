import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { requireIdempotencyKey } from '../common/idempotency/idempotency.service';
import { CreatePrescriptionDto } from './dto/create-prescription.dto';
import { PrescriptionsService } from './prescriptions.service';

@ApiTags('Prescriptions')
@ApiBearerAuth()
@Controller('consultations/:consultationId/prescriptions')
export class PrescriptionsController {
  constructor(private readonly prescriptions: PrescriptionsService) {}

  @Post()
  @Roles('doctor')
  @ApiOperation({ summary: 'Issue a prescription for a completed assigned consultation' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('consultationId', ParseUUIDPipe) consultationId: string,
    @Body() input: CreatePrescriptionDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.prescriptions.create(
      user,
      consultationId,
      input,
      requireIdempotencyKey(key),
      request.requestId,
    );
  }

  @Get()
  @ApiOperation({ summary: 'List prescriptions when authorized for the consultation' })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('consultationId', ParseUUIDPipe) consultationId: string,
  ): Promise<unknown[]> {
    return this.prescriptions.list(user, consultationId);
  }
}
