import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { HealthResponseDto, ReadinessResponseDto } from './dto/health-response.dto';

@Injectable()
export class HealthService {
  constructor(private readonly database: DatabaseService) {}

  liveness(): HealthResponseDto {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  async readiness(): Promise<ReadinessResponseDto> {
    if (!(await this.database.isReady())) {
      throw new ServiceUnavailableException('A required dependency is unavailable');
    }
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      dependencies: { database: 'up' },
    };
  }
}
