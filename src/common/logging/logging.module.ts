import { Global, Module } from '@nestjs/common';
import { JsonLogger } from './json-logger.service';

@Global()
@Module({
  providers: [JsonLogger],
  exports: [JsonLogger],
})
export class LoggingModule {}
