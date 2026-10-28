import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PrescriptionItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  medicationName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  dosage!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  frequency!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  duration!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  instructions?: string;
}

export class CreatePrescriptionDto {
  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  clinicalNotes?: string;

  @ApiProperty({ type: [PrescriptionItemDto], minItems: 1, maxItems: 50 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PrescriptionItemDto)
  items!: PrescriptionItemDto[];
}
