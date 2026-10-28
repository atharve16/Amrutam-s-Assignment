import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CONSULTATION_STATUSES, ConsultationStatus } from './consultation-query.dto';

export class TransitionConsultationDto {
  @ApiProperty({ enum: CONSULTATION_STATUSES })
  @IsIn(CONSULTATION_STATUSES)
  status!: ConsultationStatus;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  cancellationReason?: string;
}
