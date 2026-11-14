import { describe, expect, it } from 'bun:test';
import { HealthController } from '../../src/interfaces/http/health/health.controller';
import { loadEnv } from '../../src/config/env';

describe('HealthController', () => {
  it('live responde ok sem depender de IO', () => {
    expect(new HealthController().live()).toEqual({ status: 'ok' });
  });
});

describe('loadEnv', () => {
  it('usa valores padrão de desenvolvimento', () => {
    const env = loadEnv({});
    expect(env.port).toBe(3000);
    expect(env.database.port).toBe(5432);
  });

  it('rejeita porta inválida', () => {
    expect(() => loadEnv({ PORT: 'abc' })).toThrow('PORT');
  });
});
