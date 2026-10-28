import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { LoggingModule } from './common/logging/logging.module';
import { RequestCorrelationMiddleware } from './common/middleware/request-correlation.middleware';
import { RequestLoggingMiddleware } from './common/middleware/request-logging.middleware';
import configuration from './config/configuration';
import { validateEnvironment } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { DoctorsModule } from './doctors/doctors.module';
import { ConsultationsModule } from './consultations/consultations.module';
import { PaymentsModule } from './payments/payments.module';
import { PrescriptionsModule } from './prescriptions/prescriptions.module';
import { AdminModule } from './admin/admin.module';
import { ObservabilityModule } from './observability/observability.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
      validate: validateEnvironment,
    }),
    LoggingModule,
    DatabaseModule,
    ObservabilityModule,
    IdempotencyModule,
    AuthModule,
    DoctorsModule,
    ConsultationsModule,
    PrescriptionsModule,
    PaymentsModule,
    AdminModule,
    HealthModule,
  ],
  providers: [RequestCorrelationMiddleware, RequestLoggingMiddleware],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestCorrelationMiddleware, RequestLoggingMiddleware).forRoutes('*path');
  }
}
