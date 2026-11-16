import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { Client } from 'pg';
import config from '../../../mikro-orm.config';
import { WagerModule } from '../../../src/interfaces/http/wagering/wagering.module';
import { METRICS } from '../../../src/interfaces/http/wagering/wagering.tokens';
import { MetricsRegistry } from '../../../src/infrastructure/observability/metrics-registry';
import { createPgClient, TEST_DB_NAME, truncateAll } from '../helpers/database';
import { seedWallet } from '../helpers/wagering';

describe('Observabilidade — /metrics, logs e correlação', () => {
  let app: INestApplication;
  let client: Client;
  let base: string;
  let metrics: MetricsRegistry;

  beforeAll(async () => {
    process.env['PENDING_REFERENCE_POLL_MS'] = '0';
    const moduleRef = await Test.createTestingModule({
      imports: [MikroOrmModule.forRoot({ ...config, dbName: TEST_DB_NAME }), WagerModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
    await app.get(MikroORM).getMigrator().up();
    client = await createPgClient();
    metrics = app.get<MetricsRegistry>(METRICS);
  });

  beforeEach(async () => {
    await truncateAll(client);
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  async function post(body: unknown, headers: Record<string, string>) {
    return fetch(`${base}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  /** Captura as linhas que o logger JSON escreve em stdout durante `fn`. */
  async function captureLogs(fn: () => Promise<void>): Promise<Array<Record<string, unknown>>> {
    const original = process.stdout.write.bind(process.stdout);
    const lines: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await fn();
    } finally {
      process.stdout.write = original;
    }
    return lines
      .flatMap((l) => l.split('\n'))
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it('/metrics expõe as métricas obrigatórias, mesmo sem atividade', async () => {
    const res = await fetch(`${base}/metrics`);
    const text = await res.text();
    expect(res.status).toBe(200);
    for (const name of [
      'wagering_transactions_total',
      'duplicates_detected_total',
      'retries_total',
      'dlq_messages_total',
      'lock_conflicts_total',
      'outbox_lag_seconds',
    ]) {
      expect(text).toContain(name);
    }
  });

  it('transações, replay e latência aparecem nas métricas após atividade real', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    const body = {
      providerId: 'provider-a',
      externalTransactionId: 'obs-1',
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: 'r',
      gameId: 'g',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };
    await post(body, { 'idempotency-key': 'obs-key' });
    await post(body, { 'idempotency-key': 'obs-key' }); // replay
    await post({ ...body, externalTransactionId: 'obs-2', money: { amount: '999.00', currency: 'BRL' } }, { 'idempotency-key': 'obs-rej' });

    expect(metrics.value('wagering_transactions_total', { kind: 'BET', status: 'PROCESSED' })).toBe(1);
    expect(metrics.value('wagering_transactions_total', { kind: 'BET', status: 'REJECTED' })).toBe(1);
    expect(metrics.value('duplicates_detected_total', { source: 'http' })).toBe(1);

    const text = await (await fetch(`${base}/metrics`)).text();
    expect(text).toContain('processing_latency_seconds_bucket{le="+Inf",route="/wagering/transactions",source="http"}');
    expect(text).toContain('wagering_transactions_total{kind="BET",status="PROCESSED"} 1');
  });

  it('esgotamento de lock conta em lock_conflicts_total', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    const holder = await createPgClient();
    const before = metrics.value('lock_conflicts_total');
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [w.walletId]);
      const res = await post(
        { providerId: 'provider-a', externalTransactionId: 'lock-1', playerId: w.playerId, walletId: w.walletId, roundId: 'r', gameId: 'g', kind: 'BET', money: { amount: '1.00', currency: 'BRL' } },
        { 'idempotency-key': 'lock-key' },
      );
      expect(res.status).toBe(503);
      await holder.query('ROLLBACK');
    } finally {
      await holder.end();
    }
    expect(metrics.value('lock_conflicts_total')).toBe(before + 1);
  }, 20_000);

  it('x-correlation-id recebido é devolvido e aparece nos logs; inválido é substituído', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    const body = {
      providerId: 'provider-a',
      externalTransactionId: 'corr-1',
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: 'r',
      gameId: 'g',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };

    let res: Response | undefined;
    const logs = await captureLogs(async () => {
      res = await post(body, { 'idempotency-key': 'corr-key', 'x-correlation-id': 'req-abc-123' });
    });
    expect(res?.headers.get('x-correlation-id')).toBe('req-abc-123');

    const decided = logs.find((l) => l['event'] === 'transaction_decided');
    expect(decided).toMatchObject({ correlationId: 'req-abc-123', providerId: 'provider-a', walletId: w.walletId, status: 'PROCESSED' });
    expect(typeof decided?.['transactionId']).toBe('string');
    expect(decided).not.toHaveProperty('amount');
    const request = logs.find((l) => l['event'] === 'http_request');
    expect(request).toMatchObject({ correlationId: 'req-abc-123', method: 'POST', status: 200, route: '/wagering/transactions' });

    const invalid = await post({ ...body, externalTransactionId: 'corr-2' }, { 'idempotency-key': 'corr-key-2', 'x-correlation-id': 'espaço inválido' });
    const generated = invalid.headers.get('x-correlation-id') ?? '';
    expect(generated).not.toBe('espaço inválido');
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('nenhuma linha de log contém o valor da operação nem o payload', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    const logs = await captureLogs(async () => {
      await post(
        { providerId: 'provider-a', externalTransactionId: 'nolog-1', playerId: w.playerId, walletId: w.walletId, roundId: 'r-secreto', gameId: 'g', kind: 'BET', money: { amount: '77.77', currency: 'BRL' } },
        { 'idempotency-key': 'nolog-key' },
      );
    });
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain('77.77');
    expect(serialized).not.toContain('nolog-1');
    expect(serialized).not.toContain('r-secreto');
    expect(logs.length).toBeGreaterThan(0);
    void randomUUID;
  });
});
