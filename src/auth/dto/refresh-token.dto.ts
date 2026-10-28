import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RefreshTokenDto {
  @ApiProperty({ writeOnly: true })
  @IsString()
  @MinLength(20)
  @MaxLength(500)
  refreshToken!: string;
}
