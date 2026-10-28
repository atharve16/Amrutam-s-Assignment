import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export const CONSULTATION_STATUSES = [
  'scheduled',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
] as const;
export type ConsultationStatus = (typeof CONSULTATION_STATUSES)[number];

export class ConsultationQueryDto {
  @IsOptional()
  @IsIn(CONSULTATION_STATUSES)
  status?: ConsultationStatus;

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
