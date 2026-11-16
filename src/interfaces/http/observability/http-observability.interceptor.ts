import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import type { Logger, Metrics } from '../../../application/ports/observability';
import { LOGGER, METRICS } from '../wagering/wagering.tokens';

const CORRELATION_HEADER = 'x-correlation-id';
const VALID_CORRELATION = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Para toda requisição HTTP: garante o `x-correlation-id` (recebido ou gerado), mede a latência
 * por rota e registra uma linha de log ao final. O corpo nunca entra no log.
 */
@Injectable()
export class HttpObservabilityInterceptor implements NestInterceptor {
  constructor(
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const incoming = req.headers[CORRELATION_HEADER];
    const correlationId = typeof incoming === 'string' && VALID_CORRELATION.test(incoming) ? incoming : randomUUID();
    req.headers[CORRELATION_HEADER] = correlationId;
    res.setHeader(CORRELATION_HEADER, correlationId);

    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const durationSeconds = Number(process.hrtime.bigint() - started) / 1e9;
      const route = req.route?.path ?? 'unmatched';
      this.metrics.observe('processing_latency_seconds', durationSeconds, { source: 'http', route });
      this.logger.info('http_request', {
        correlationId,
        method: req.method,
        route,
        status: res.statusCode,
        durationMs: Math.round(durationSeconds * 1000),
      });
    });

    return next.handle();
  }
}
