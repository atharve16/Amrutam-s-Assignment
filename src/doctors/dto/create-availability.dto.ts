import { Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

const OFFSET_TIMESTAMP = /(?:Z|[+-]\d{2}:\d{2})$/;

export class CreateAvailabilityDto {
  @ApiProperty({ example: '2026-11-01T09:00:00+05:30' })
  @Matches(OFFSET_TIMESTAMP, { message: 'startsAt must include Z or an explicit UTC offset' })
  startsAt!: string;

  @ApiProperty({ example: '2026-11-01T09:30:00+05:30' })
  @Matches(OFFSET_TIMESTAMP, { message: 'endsAt must include Z or an explicit UTC offset' })
  endsAt!: string;
}
