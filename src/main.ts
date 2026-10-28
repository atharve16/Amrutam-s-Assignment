import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { JsonLogger } from './common/logging/json-logger.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true, bodyParser: false });
  const config = app.get(ConfigService);
  const logger = app.get(JsonLogger);
  const swaggerEnabled = config.getOrThrow<boolean>('app.swaggerEnabled');
  const bodyLimit = config.getOrThrow<string>('app.requestBodyLimit');

  app.useLogger(logger);
  app.enableShutdownHooks();
  app.setGlobalPrefix('api/v1');
  app.use(
    helmet(
      swaggerEnabled
        ? { contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }
        : { crossOriginEmbedderPolicy: false },
    ),
  );
  app.use(json({ limit: bodyLimit }));
  app.use(urlencoded({ extended: false, limit: bodyLimit }));
  app.enableCors({
    origin: config.getOrThrow<string[]>('app.origins'),
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
    credentials: true,
    maxAge: 600,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter(logger));

  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Amrutam Telemedicine API')
      .setDescription('REST API for Amrutam telemedicine workflows')
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swaggerConfig), {
      customSiteTitle: 'Amrutam API documentation',
    });
  }

  const port = config.getOrThrow<number>('app.port');
  await app.listen(port, '0.0.0.0');
  logger.log({
    event: 'application_started',
    port,
    environment: config.getOrThrow<string>('app.environment'),
    swaggerEnabled,
  });
}

bootstrap().catch((error: unknown) => {
  const errorName = error instanceof Error ? error.name : 'UnknownError';
  process.stderr.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), event: 'startup_failed', errorName })}\n`,
  );
  process.exitCode = 1;
});
