import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { requireIdempotencyKey } from '../common/idempotency/idempotency.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentsService } from './payments.service';

@ApiTags('Payments')
@ApiBearerAuth()
@Controller('consultations/:consultationId/payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  @Roles('patient')
  @ApiOperation({ summary: 'Create an idempotent payment record (no real gateway processing)' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('consultationId', ParseUUIDPipe) consultationId: string,
    @Body() input: CreatePaymentDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.payments.create(
      user,
      consultationId,
      input,
      requireIdempotencyKey(key),
      request.requestId,
    );
  }

  @Get()
  @ApiOperation({ summary: 'List authorized payment records for a consultation' })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('consultationId', ParseUUIDPipe) consultationId: string,
  ): Promise<unknown[]> {
    return this.payments.list(user, consultationId);
  }
}
