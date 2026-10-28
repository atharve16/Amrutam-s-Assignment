import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { requireIdempotencyKey } from '../common/idempotency/idempotency.service';
import { ConsultationsService } from './consultations.service';
import { BookConsultationDto } from './dto/book-consultation.dto';
import { ConsultationQueryDto } from './dto/consultation-query.dto';
import { TransitionConsultationDto } from './dto/transition-consultation.dto';

@ApiTags('Consultations')
@ApiBearerAuth()
@Controller('consultations')
export class ConsultationsController {
  constructor(private readonly consultations: ConsultationsService) {}

  @Post()
  @Roles('patient')
  @ApiOperation({ summary: 'Book an available slot idempotently' })
  book(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: BookConsultationDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.consultations.book(user, input, requireIdempotencyKey(key), request.requestId);
  }

  @Get()
  @ApiOperation({ summary: 'List consultations visible to the authenticated role' })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ConsultationQueryDto,
  ): Promise<unknown> {
    return this.consultations.list(user, query);
  }

  @Get(':consultationId')
  @ApiOperation({ summary: 'Get an authorized consultation detail' })
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('consultationId', ParseUUIDPipe) consultationId: string,
  ): Promise<unknown> {
    return this.consultations.detail(user, consultationId);
  }

  @Patch(':consultationId/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Apply an authorized consultation lifecycle transition' })
  transition(
    @CurrentUser() user: AuthenticatedUser,
    @Param('consultationId', ParseUUIDPipe) consultationId: string,
    @Body() input: TransitionConsultationDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.consultations.transition(
      user,
      consultationId,
      input,
      requireIdempotencyKey(key),
      request.requestId,
    );
  }
}
