import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class BookConsultationDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  slotId!: string;
}
