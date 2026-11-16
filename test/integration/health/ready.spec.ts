import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../../src/app.module';

/** Sobe a aplicação completa (com AuthGuard) apontando para a infraestrutura local. */
async function boot(env: Record<string, string>): Promise<{ app: INestApplication; base: string; restore: () => void }> {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    previous[k] = process.env[k];
    process.env[k] = v;
  }
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  return {
    app,
    base,
    restore: () => {
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

describe('Health — ready depende de PostgreSQL e SQS', () => {
  describe('com dependências no ar', () => {
    let ctx: Awaited<ReturnType<typeof boot>>;

    beforeAll(async () => {
      ctx = await boot({ PENDING_REFERENCE_POLL_MS: '0' });
    });

    afterAll(async () => {
      await ctx.app.close();
      ctx.restore();
    });

    it('live e ready respondem 200 sem autenticação', async () => {
      expect((await fetch(`${ctx.base}/health/live`)).status).toBe(200);
      const ready = await fetch(`${ctx.base}/health/ready`);
      const body = (await ready.json()) as { status: string; checks: Record<string, string> };
      expect(ready.status).toBe(200);
      expect(body.checks).toEqual({ postgres: 'up', sqs: 'up', draining: 'up' });
    });

    it('rotas de negócio exigem passar pelo guard (que hoje é no-op) e respondem normalmente', async () => {
      const res = await fetch(`${ctx.base}/wallets/00000000-0000-0000-0000-000000000000`);
      expect(res.status).toBe(404);
    });
  });

  describe('com SQS inalcançável', () => {
    let ctx: Awaited<ReturnType<typeof boot>>;

    beforeAll(async () => {
      ctx = await boot({ PENDING_REFERENCE_POLL_MS: '0', AWS_ENDPOINT_URL: 'http://127.0.0.1:9' });
    });

    afterAll(async () => {
      await ctx.app.close();
      ctx.restore();
    });

    it('ready responde 503 com o detalhe por dependência; live continua 200', async () => {
      const ready = await fetch(`${ctx.base}/health/ready`);
      const body = (await ready.json()) as { status: string; checks: Record<string, string>; errors?: unknown };
      expect(ready.status).toBe(503);
      expect(body.status).toBe('down');
      expect(body.checks['postgres']).toBe('up');
      expect(body.checks['sqs']).toBe('down');
      // o motivo não vai para a resposta pública
      expect(body.errors).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('127.0.0.1:9');
      expect((await fetch(`${ctx.base}/health/live`)).status).toBe(200);
    }, 30_000);
  });
});
