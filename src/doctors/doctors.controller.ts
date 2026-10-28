import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { requireIdempotencyKey } from '../common/idempotency/idempotency.service';
import { CreateAvailabilityDto } from './dto/create-availability.dto';
import { AvailabilityQueryDto, DoctorSearchDto } from './dto/doctor-search.dto';
import { DoctorsService } from './doctors.service';

@ApiTags('Doctors')
@Controller('doctors')
export class DoctorsController {
  constructor(private readonly doctors: DoctorsService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Search verified doctors' })
  search(@Query() query: DoctorSearchDto): Promise<unknown> {
    return this.doctors.search(query);
  }

  @Public()
  @Get(':doctorId/availability')
  @ApiOperation({ summary: 'List unbooked open availability for a verified doctor' })
  availability(
    @Param('doctorId', ParseUUIDPipe) doctorId: string,
    @Query() query: AvailabilityQueryDto,
  ): Promise<unknown[]> {
    return this.doctors.availability(doctorId, query);
  }

  @Post('me/availability')
  @Roles('doctor')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create availability for the authenticated verified doctor' })
  createAvailability(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateAvailabilityDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.doctors.createAvailability(
      user.id,
      input,
      requireIdempotencyKey(key),
      request.requestId,
    );
  }
}
