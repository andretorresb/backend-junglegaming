import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import {
  ApplicationError,
  IdempotencyConflictError,
  InternalOnlyKindError,
  KindNotSupportedYetError,
  RejectedBeforePersistenceError,
  TransientInfrastructureError,
  UniqueViolationError,
  WalletNotFoundError,
} from '../../../application/wagering/errors';
import { DomainError } from '../../../domain/errors';
import { FailureCode } from '../../../domain/failure-code';

/**
 * Mapeamento único de erros para HTTP (seção 9 do enunciado).
 *   400 payload inválido · 404 não encontrado · 409 conflito · 422 rejeição de negócio
 *   501 ainda não suportado · 503 falha transitória (com Retry-After)
 */
@Catch()
export class ApplicationErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpErrors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(normalizeHttpBody(exception));
      return;
    }

    if (exception instanceof RejectedBeforePersistenceError) {
      response.status(422).json({
        status: 'REJECTED',
        failureCode: exception.failureCode,
        message: exception.message,
      });
      return;
    }

    if (exception instanceof ApplicationError) {
      const status = applicationStatus(exception);
      if (status === 503) response.setHeader('Retry-After', '1');
      response.status(status).json({
        code: exception.code,
        failureCode: exception.failureCode,
        message: exception.message,
      });
      return;
    }

    if (exception instanceof DomainError && exception.failureCode === FailureCode.InvalidPayload) {
      response.status(400).json({ code: 'INVALID_PAYLOAD', message: exception.message });
      return;
    }

    this.logger.error(exception instanceof Error ? exception.message : String(exception));
    response.status(500).json({ code: 'INTERNAL_ERROR' });
  }
}

function applicationStatus(error: ApplicationError): number {
  if (error instanceof WalletNotFoundError) return 404;
  if (error instanceof IdempotencyConflictError || error instanceof UniqueViolationError) return 409;
  if (error instanceof InternalOnlyKindError) return 400;
  if (error instanceof KindNotSupportedYetError) return 501;
  if (error instanceof TransientInfrastructureError) return 503;
  return 500;
}

function normalizeHttpBody(exception: HttpException): Record<string, unknown> {
  const body = exception.getResponse();
  if (typeof body === 'string') return { code: 'INVALID_PAYLOAD', message: body };
  const record = body as Record<string, unknown>;
  const message = record['message'];
  return {
    code: exception.getStatus() === 400 ? 'INVALID_PAYLOAD' : record['error'] ?? 'HTTP_ERROR',
    message: Array.isArray(message) ? message : (message ?? exception.message),
  };
}
