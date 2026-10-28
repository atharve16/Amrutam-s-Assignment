import { Transform, TransformFnParams } from 'class-transformer';
import { IsString, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

function upperTrimmed(parameters: TransformFnParams): unknown {
  const value: unknown = parameters.value;
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
}

export class CreatePaymentDto {
  @ApiProperty({ example: '499.00', description: 'Exact decimal string' })
  @IsString()
  @Matches(/^(?:0|[1-9]\d{0,9})\.\d{2}$/)
  amount!: string;

  @ApiProperty({ example: 'INR' })
  @Transform(upperTrimmed)
  @Matches(/^[A-Z]{3}$/)
  currency!: string;
}
