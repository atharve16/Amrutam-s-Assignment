import { Body, Controller, Get, Headers, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { requireIdempotencyKey } from '../common/idempotency/idempotency.service';
import { AdminService } from './admin.service';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';
import { CreateDoctorDto } from './dto/create-doctor.dto';

@ApiTags('Administration')
@ApiBearerAuth()
@Roles('admin')
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Post('doctors')
  @ApiOperation({ summary: 'Promote an active account and create a verified doctor profile' })
  createDoctor(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateDoctorDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.admin.createVerifiedDoctor(
      user.id,
      input,
      requireIdempotencyKey(key),
      request.requestId,
    );
  }

  @Get('analytics')
  @ApiOperation({ summary: 'Return aggregate operational analytics for a bounded date range' })
  analytics(@Query() query: AnalyticsQueryDto): Promise<unknown> {
    return this.admin.analytics(query);
  }
}
