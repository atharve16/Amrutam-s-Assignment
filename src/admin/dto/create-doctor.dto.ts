import { Transform, TransformFnParams } from 'class-transformer';
import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

function upperTrimmed(parameters: TransformFnParams): unknown {
  const value: unknown = parameters.value;
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
}

export class CreateDoctorDto {
  @ApiProperty({ format: 'uuid', description: 'Existing active patient account to promote' })
  @IsUUID()
  userId!: string;

  @Transform(upperTrimmed)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  licenseNumber!: string;

  @Transform(upperTrimmed)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  licenseJurisdiction!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(200)
  specialization!: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string;
}
