import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/public.decorator';
import { READINESS } from '../wagering/wagering.tokens';
import type { ReadinessChecker } from './readiness';

/**
 * Health checks, sem autenticação (seção 9 do enunciado).
 * - `live`: processo vivo, sem IO.
 * - `ready`: PostgreSQL e SQS alcançáveis. 503 com o detalhe quando algo falha.
 */
@Controller('health')
export class HealthController {
  constructor(@Inject(READINESS) private readonly readiness: ReadinessChecker) {}

  @Public()
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const report = await this.readiness.run();
    if (!report.ok) {
      res.status(503);
      return { status: 'down', ...report };
    }
    return { status: 'ok', ...report };
  }
}
