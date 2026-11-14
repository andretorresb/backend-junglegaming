import { Controller, Get } from '@nestjs/common';

/**
 * Health checks. Ficam fora de qualquer autenticação (seção 9 do enunciado).
 * - `live`: processo vivo, sem IO.
 * - `ready`: será implementado na Etapa 6 (Postgres e SQS).
 */
@Controller('health')
export class HealthController {
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
