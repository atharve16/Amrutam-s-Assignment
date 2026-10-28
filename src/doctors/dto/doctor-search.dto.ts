import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

const OFFSET_TIMESTAMP = /(?:Z|[+-]\d{2}:\d{2})$/;

export class DoctorSearchDto {
  @ApiPropertyOptional({ description: 'Matches doctor name, specialization, or license number' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  specialization?: string;

  @ApiPropertyOptional({ example: '2026-11-01T09:00:00+05:30' })
  @IsOptional()
  @Matches(OFFSET_TIMESTAMP, { message: 'availableFrom must include Z or an explicit UTC offset' })
  availableFrom?: string;

  @ApiPropertyOptional({ example: '2026-11-02T09:00:00+05:30' })
  @IsOptional()
  @Matches(OFFSET_TIMESTAMP, { message: 'availableTo must include Z or an explicit UTC offset' })
  availableTo?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}

export class AvailabilityQueryDto {
  @Matches(OFFSET_TIMESTAMP, { message: 'from must include Z or an explicit UTC offset' })
  from!: string;

  @Matches(OFFSET_TIMESTAMP, { message: 'to must include Z or an explicit UTC offset' })
  to!: string;
}
