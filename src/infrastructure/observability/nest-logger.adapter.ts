import type { LoggerService } from '@nestjs/common';
import type { Logger } from '../../application/ports/observability';

/**
 * Faz os logs do próprio Nest (bootstrap, módulos, erros de framework) saírem no mesmo formato JSON
 * dos eventos da aplicação.
 */
export class JsonNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, context?: string): void {
    this.logger.info('app', { message: stringify(message), context: context ?? null });
  }

  warn(message: unknown, context?: string): void {
    this.logger.info('app_warn', { message: stringify(message), context: context ?? null });
  }

  error(message: unknown, stack?: string, context?: string): void {
    this.logger.error('app_error', { message: stringify(message), context: context ?? null, stack: stack ?? null });
  }

  debug(): void {
    // debug fica fora dos logs de produção
  }

  verbose(): void {
    // verbose fica fora dos logs de produção
  }
}

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
