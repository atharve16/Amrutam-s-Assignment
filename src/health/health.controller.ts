import { Controller, Get } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../common/errors/error-response.dto';
import { Public } from '../auth/decorators/public.decorator';
import { HealthResponseDto, ReadinessResponseDto } from './dto/health-response.dto';
import { HealthService } from './health.service';

@Public()
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'Check whether the API process is alive' })
  @ApiOkResponse({ type: HealthResponseDto })
  liveness(): HealthResponseDto {
    return this.healthService.liveness();
  }

  @Get('ready')
  @ApiOperation({ summary: 'Check whether the API and required dependencies are ready' })
  @ApiOkResponse({ type: ReadinessResponseDto })
  @ApiServiceUnavailableResponse({
    type: ErrorResponseDto,
    description: 'A required dependency is unavailable',
  })
  readiness(): Promise<ReadinessResponseDto> {
    return this.healthService.readiness();
  }
}
