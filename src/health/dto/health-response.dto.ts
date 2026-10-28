import { ApiProperty } from '@nestjs/swagger';

export class HealthResponseDto {
  @ApiProperty({ example: 'ok' })
  status!: 'ok';

  @ApiProperty({ example: '2026-10-28T09:30:00.000Z' })
  timestamp!: string;
}

export class ReadinessResponseDto extends HealthResponseDto {
  @ApiProperty({ example: { database: 'up' } })
  dependencies!: { database: 'up' };
}
