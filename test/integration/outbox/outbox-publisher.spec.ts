import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { Client } from 'pg';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { createPgClient, createTestOrm, truncateAll } from '../helpers/database';
import { command, mutableClock, seedWallet, useCase } from '../helpers/wagering';
import { drainQueue } from '../helpers/sqs';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs-client';
import { ensureQueues, EVENTS_QUEUE } from '../../../src/infrastructure/messaging/queues';
import { SqsEventPublisher } from '../../../src/infrastructure/messaging/sqs-event-publisher';
import { MikroOrmOutboxUnitOfWork } from '../../../src/infrastructure/persistence/outbox.persistence';
import { MetricsRegistry } from '../../../src/infrastructure/observability/metrics-registry';
import { OutboxPublisherWorker, OUTBOX_LAG_METRIC } from '../../../src/application/outbox/outbox-publisher.worker';
import type { EventPublisher, OutboundEvent } from '../../../src/application/ports/event-publisher';
import { loadEnv } from '../../../src/config/env';
import { MikroOrmWagerUnitOfWork } from '../../../src/infrastructure/persistence/wagering.persistence';
import { ProcessWagerTransaction } from '../../../src/application/wagering/process-wager-transaction.use-case';
import type { WagerRepositories, WagerUnitOfWork } from '../../../src/application/wagering/ports';

const START = new Date('2026-07-29T15:00:00.000Z');
const silent = { info: () => undefined, error: () => undefined };

describe('Outbox — escrita atômica e publicação no SQS', () => {
  let orm: MikroORM;
  let client: Client;
  let em: EntityManager;
  let sqs: SQSClient;

  beforeAll(async () => {
    orm = await createTestOrm();
    await orm.getMigrator().up();
    client = await createPgClient();
    em = orm.em;
    sqs = createSqsClient(loadEnv());
    await ensureQueues(sqs);
  });

  beforeEach(async () => {
    await truncateAll(client);
    await drainQueue(sqs, EVENTS_QUEUE);
  });

  afterAll(async () => {
    await client.end();
    await orm.close();
    sqs.destroy();
  });

  function publisher(events: EventPublisher, clock: { now(): Date }, metrics = new MetricsRegistry()) {
    return new OutboxPublisherWorker(new MikroOrmOutboxUnitOfWork(em), events, clock, metrics, silent, {
      retryPolicy: { baseDelayMs: 1000, maxDelayMs: 8000 },
    });
  }

  async function pendingCount(): Promise<number> {
    const r = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM outbox_messages WHERE published_at IS NULL');
    return Number(r.rows[0]?.n ?? 0);
  }

  it('o BET grava os dois eventos na outbox, na mesma transação da alteração', async () => {
    const clock = mutableClock(START);
    const w = await seedWallet(client, { balance: '100.00' });
    await useCase(em, clock).execute(command({ walletId: w.walletId, playerId: w.playerId, amount: '25.00', externalTransactionId: 'bet-ob' }));

    const rows = await client.query<{ event_type: string; payload: { data: { status?: string } } }>(
      "SELECT event_type, payload FROM outbox_messages WHERE aggregate_id IN (SELECT id FROM wager_transactions WHERE external_transaction_id = 'bet-ob') OR event_type = 'WalletBalanceChanged' ORDER BY event_type",
    );
    expect(rows.rows.map((r) => r.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  it('falha depois de gravar a outbox desfaz tudo: nenhum evento órfão', async () => {
    const clock = mutableClock(START);
    const w = await seedWallet(client, { balance: '100.00' });
    const real = new MikroOrmWagerUnitOfWork(em);
    const failingAfterOutbox: WagerUnitOfWork = {
      run: (work) =>
        real.run((repos: WagerRepositories) =>
          work(
            new Proxy(repos, {
              get(target, prop, receiver) {
                if (prop === 'saveWallet') {
                  return async () => {
                    throw new Error('falha simulada depois da outbox');
                  };
                }
                return Reflect.get(target, prop, receiver);
              },
            }) as WagerRepositories,
          ),
        ),
    };

    await expect(
      new ProcessWagerTransaction(failingAfterOutbox, clock, randomUUID).execute(
        command({ walletId: w.walletId, playerId: w.playerId, amount: '25.00', externalTransactionId: 'bet-rb' }),
      ),
    ).rejects.toThrow('falha simulada');

    expect(await pendingCount()).toBe(0);
    const tx = await client.query("SELECT 1 FROM wager_transactions WHERE external_transaction_id = 'bet-rb'");
    expect(tx.rowCount).toBe(0);
  });

  it('publica os pendentes no SQS, com o eventId como identificador, e marca como publicados', async () => {
    const clock = mutableClock(START);
    const w = await seedWallet(client, { balance: '100.00' });
    await useCase(em, clock).execute(command({ walletId: w.walletId, playerId: w.playerId, amount: '25.00', externalTransactionId: 'bet-pub' }));
    const expected = (await client.query<{ id: string }>('SELECT id FROM outbox_messages')).rows.map((r) => r.id).sort();

    const sent: OutboundEvent[] = [];
    const real = new SqsEventPublisher(sqs, EVENTS_QUEUE);
    const stats = await publisher({ publish: async (e) => { sent.push(e); await real.publish(e); } }, clock).runCycle(10);

    expect(stats.published).toBe(2);
    expect(await pendingCount()).toBe(0);
    const received = await drainQueue(sqs, EVENTS_QUEUE);
    expect(received.map((m) => m.eventId).sort()).toEqual(expected);
    const body = JSON.parse(received[0]!.body) as { eventId: string; version: number; data: unknown };
    expect(body.version).toBe(1);
    expect(body.data).toBeDefined();
  });

  it('falha de publicação: conta a tentativa, agenda com backoff e só reenvia quando vencida', async () => {
    const clock = mutableClock(START);
    const w = await seedWallet(client, { balance: '100.00' });
    await useCase(em, clock).execute(command({ walletId: w.walletId, playerId: w.playerId, amount: '25.00', externalTransactionId: 'bet-fail' }));

    const broken: EventPublisher = { publish: async () => { throw new Error('SQS indisponível'); } };
    const first = await publisher(broken, clock).runCycle(10);
    expect(first.failed).toBe(2);
    const attempts = await client.query<{ attempts: number; next: Date }>('SELECT attempts, next_attempt_at AS next FROM outbox_messages');
    expect(attempts.rows.every((r) => r.attempts === 1 && r.next.getTime() > START.getTime())).toBe(true);

    // ainda não vencida: nada é reivindicado
    const early = await publisher({ publish: async () => undefined }, clock).runCycle(10);
    expect(early.claimed).toBe(0);

    clock.advance(60_000);
    const recovered = await publisher(new SqsEventPublisher(sqs, EVENTS_QUEUE), clock).runCycle(10);
    expect(recovered.published).toBe(2);
    expect(await pendingCount()).toBe(0);
  });

  it('lote com sucesso parcial: só a mensagem que falhou volta para retry', async () => {
    const clock = mutableClock(START);
    const w = await seedWallet(client, { balance: '100.00' });
    await useCase(em, clock).execute(command({ walletId: w.walletId, playerId: w.playerId, amount: '25.00', externalTransactionId: 'bet-partial' }));
    const ids = (await client.query<{ id: string }>('SELECT id FROM outbox_messages ORDER BY occurred_at, id')).rows.map((r) => r.id);
    const failing = ids[0]!;

    const partial: EventPublisher = {
      publish: async () => { throw new Error('não deveria ser chamado: o lote existe'); },
      publishBatch: async (events) => events.map((e) => (e.eventId === failing ? { eventId: e.eventId, ok: false, error: 'rejeitado' } : { eventId: e.eventId, ok: true })),
    };
    const stats = await publisher(partial, clock).runCycle(10);

    expect(stats).toEqual({ claimed: 2, published: 1, failed: 1 });
    const rows = await client.query<{ id: string; attempts: number; published: boolean }>('SELECT id, attempts, published_at IS NOT NULL AS published FROM outbox_messages');
    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    expect(byId.get(failing)).toMatchObject({ attempts: 1, published: false });
    expect(byId.get(ids[1]!)).toMatchObject({ attempts: 0, published: true });
  });

  it('expõe o lag: idade, em segundos, da mensagem pendente mais antiga', async () => {
    const clock = mutableClock(START);
    const w = await seedWallet(client, { balance: '100.00' });
    await useCase(em, clock).execute(command({ walletId: w.walletId, playerId: w.playerId, amount: '25.00', externalTransactionId: 'bet-lag' }));

    const metrics = new MetricsRegistry();
    clock.advance(30_000);
    await publisher({ publish: async () => { throw new Error('parado'); } }, clock, metrics).runCycle(10);
    expect(metrics.value(OUTBOX_LAG_METRIC)).toBeCloseTo(30, 0);
  });

  it('evento com o mesmo id não é inventado: o id da fila é o id da outbox', async () => {
    const id = randomUUID();
    await client.query(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at) VALUES ($1, $2, 'WalletBalanceChanged', '{"eventId":"x"}', now())`,
      [id, randomUUID()],
    );
    const sent: string[] = [];
    await publisher({ publish: async (e) => { sent.push(e.eventId); } }, mutableClock(START)).runCycle(10);
    expect(sent).toEqual([id]);
  });
});
