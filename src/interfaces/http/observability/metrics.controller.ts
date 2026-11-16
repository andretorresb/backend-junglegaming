import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/public.decorator';
import { METRICS } from '../wagering/wagering.tokens';
import type { MetricsRegistry } from '../../../infrastructure/observability/metrics-registry';

/** Exposição das métricas no formato do Prometheus. Sem autenticação, como os health checks. */
@Controller()
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: MetricsRegistry) {}

  @Public()
  @Get('metrics')
  expose(@Res() res: Response): void {
    res.type('text/plain; version=0.0.4; charset=utf-8').send(this.metrics.render());
  }
}
