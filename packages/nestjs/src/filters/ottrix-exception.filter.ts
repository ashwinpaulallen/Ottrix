import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { mapOttrixError } from 'ottrix/http';

/** Maps any thrown error to a sanitized Ottrix HTTP response. */
@Catch()
export class OttrixExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      response.status(status).json(typeof payload === 'string' ? { error: payload } : payload);
      return;
    }

    const { status, body, headers } = mapOttrixError(exception);
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        response.setHeader(key, value);
      }
    }

    response.status(status).json(body);
  }
}
