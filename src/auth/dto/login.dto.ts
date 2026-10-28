import { Transform, TransformFnParams } from 'class-transformer';
import { IsEmail, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

function normalizedEmail(parameters: TransformFnParams): unknown {
  const value: unknown = parameters.value;
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

export class LoginDto {
  @ApiProperty({ example: 'patient@example.com' })
  @Transform(normalizedEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ writeOnly: true })
  @IsString()
  @MaxLength(128)
  password!: string;
}
