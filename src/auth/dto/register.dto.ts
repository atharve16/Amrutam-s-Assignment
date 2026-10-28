import { Transform, TransformFnParams } from 'class-transformer';
import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

function normalizedEmail(parameters: TransformFnParams): unknown {
  const value: unknown = parameters.value;
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

function trimmedString(parameters: TransformFnParams): unknown {
  const value: unknown = parameters.value;
  return typeof value === 'string' ? value.trim() : value;
}

export class RegisterDto {
  @ApiProperty({ example: 'patient@example.com' })
  @Transform(normalizedEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ minLength: 12, writeOnly: true })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  @Matches(/[a-z]/, { message: 'password must contain a lowercase letter' })
  @Matches(/[A-Z]/, { message: 'password must contain an uppercase letter' })
  @Matches(/[0-9]/, { message: 'password must contain a number' })
  @Matches(/[^A-Za-z0-9]/, { message: 'password must contain a special character' })
  password!: string;

  @ApiProperty({ example: 'Aarav Sharma' })
  @Transform(trimmedString)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fullName!: string;

  @ApiProperty({ example: 'Asia/Kolkata', default: 'UTC' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  timezone = 'UTC';
}
