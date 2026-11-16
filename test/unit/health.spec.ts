import { describe, expect, it } from 'bun:test';
import { HealthController } from '../../src/interfaces/http/health/health.controller';
import { ReadinessChecker } from '../../src/interfaces/http/health/readiness';
import { loadEnv } from '../../src/config/env';

describe('HealthController', () => {
  it('live responde ok sem depender de IO', () => {
    const readiness = new ReadinessChecker([{ name: 'x', check: () => Promise.reject(new Error('não deveria ser chamado')) }]);
    expect(new HealthController(readiness).live()).toEqual({ status: 'ok' });
  });
});

describe('ReadinessChecker', () => {
  it('ok quando todas as dependências respondem', async () => {
    const report = await new ReadinessChecker([{ name: 'a', check: async () => 1 }]).run();
    expect(report).toEqual({ ok: true, checks: { a: 'up' } });
  });

  it('falha quando uma dependência lança, com o detalhe por nome', async () => {
    const report = await new ReadinessChecker([
      { name: 'a', check: async () => 1 },
      { name: 'b', check: async () => { throw new Error('conexão recusada'); } },
    ]).run();
    expect(report.ok).toBe(false);
    expect(report.checks).toEqual({ a: 'up', b: 'down' });
    expect(report.errors).toEqual({ b: 'conexão recusada' });
  });

  it('falha por timeout, sem esperar a dependência', async () => {
    const started = Date.now();
    const report = await new ReadinessChecker([{ name: 'lenta', check: () => new Promise(() => undefined) }], 50).run();
    expect(report.checks['lenta']).toBe('down');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('loadEnv', () => {
  it('usa valores padrão de desenvolvimento', () => {
    const env = loadEnv({});
    expect(env.port).toBe(3000);
    expect(env.database.port).toBe(5433);
  });

  it('rejeita porta inválida', () => {
    expect(() => loadEnv({ PORT: 'abc' })).toThrow('PORT');
  });
});
