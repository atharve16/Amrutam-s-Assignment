import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { JsonLogger } from '../logging/json-logger.service';

interface NestErrorBody {
  message?: string | string[];
  error?: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: JsonLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    const isHttpException = exception instanceof HttpException;
    const statusCode = isHttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const exceptionResponse = isHttpException ? exception.getResponse() : undefined;
    const normalized = this.normalizeExceptionResponse(exceptionResponse, statusCode);

    if (statusCode >= 500) {
      this.logger.error('Request failed', {
        event: 'http_request_failed',
        requestId: request.requestId,
        method: request.method,
        path: request.path,
        exception,
      });
    }

    response.status(statusCode).json({
      statusCode,
      message: normalized.message,
      error: normalized.error,
      ...(request.requestId ? { requestId: request.requestId } : {}),
    });
  }

  private normalizeExceptionResponse(
    exceptionResponse: string | object | undefined,
    statusCode: number,
  ): Required<NestErrorBody> {
    if (typeof exceptionResponse === 'string') {
      return { message: exceptionResponse, error: this.statusLabel(statusCode) };
    }
    if (exceptionResponse && typeof exceptionResponse === 'object') {
      const body = exceptionResponse as NestErrorBody;
      return {
        message: body.message ?? this.defaultMessage(statusCode),
        error: body.error ?? this.statusLabel(statusCode),
      };
    }
    return {
      message: this.defaultMessage(statusCode),
      error: this.statusLabel(statusCode),
    };
  }

  private defaultMessage(statusCode: number): string {
    return statusCode >= 500 ? 'An unexpected error occurred' : this.statusLabel(statusCode);
  }

  private statusLabel(statusCode: number): string {
    const label = HttpStatus[statusCode];
    return typeof label === 'string' ? label.replaceAll('_', ' ') : 'Error';
  }
}
