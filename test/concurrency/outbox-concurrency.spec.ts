import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { Client } from 'pg';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { createPgClient, createTestOrm, truncateAll } from '../integration/helpers/database';
import { command, mutableClock, seedWallet, useCase } from '../integration/helpers/wagering';
import { drainQueue } from '../integration/helpers/sqs';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';
import { ensureQueues, EVENTS_QUEUE } from '../../src/infrastructure/messaging/queues';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { MikroOrmOutboxUnitOfWork } from '../../src/infrastructure/persistence/outbox.persistence';
import { MetricsRegistry } from '../../src/infrastructure/observability/metrics-registry';
import { OutboxPublisherWorker } from '../../src/application/outbox/outbox-publisher.worker';
import type { EventPublisher } from '../../src/application/ports/event-publisher';
import { loadEnv } from '../../src/config/env';

const START = new Date('2026-07-29T15:00:00.000Z');
const silent = { info: () => undefined, error: () => undefined };

describe('Concorrência — publishers sobre a mesma outbox', () => {
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

  function publisherWith(events: EventPublisher, clock: { now(): Date }) {
    return new OutboxPublisherWorker(new MikroOrmOutboxUnitOfWork(em), events, clock, new MetricsRegistry(), silent, {
      retryPolicy: { baseDelayMs: 1000, maxDelayMs: 8000 },
    });
  }

  async function fillOutbox(clock: ReturnType<typeof mutableClock>, bets: number): Promise<number> {
    const uc = useCase(em, clock);
    const wallets = await Promise.all(Array.from({ length: 4 }, () => seedWallet(client, { balance: '1000.00' })));
    for (let i = 0; i < bets; i++) {
      const w = wallets[i % wallets.length]!;
      await uc.execute(command({ walletId: w.walletId, playerId: w.playerId, amount: '1.00', externalTransactionId: `bet-c-${i}` }));
    }
    const r = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM outbox_messages WHERE published_at IS NULL');
    return Number(r.rows[0]?.n ?? 0);
  }

  it('dois publishers em paralelo: cada evento chega à fila exatamente uma vez', async () => {
    const clock = mutableClock(START);
    const total = await fillOutbox(clock, 100); // 100 BETs → 200 eventos (Processed + BalanceChanged)
    expect(total).toBe(200);

    const real = new SqsEventPublisher(sqs, EVENTS_QUEUE);
    const workers = [publisherWith(real, clock), publisherWith(real, clock)];
    let claimed = 1;
    for (let round = 0; round < 50 && claimed > 0; round++) {
      const results = await Promise.all(workers.map((w) => w.runCycle(10)));
      claimed = results.reduce((sum, r) => sum + r.claimed, 0);
    }

    const pending = await client.query('SELECT 1 FROM outbox_messages WHERE published_at IS NULL');
    expect(pending.rowCount).toBe(0);
    const received = await drainQueue(sqs, EVENTS_QUEUE);
    expect(received).toHaveLength(200);
    expect(new Set(received.map((m) => m.eventId)).size).toBe(200);
    // nenhuma tentativa falhou: nenhuma mensagem foi reenviada
    const attempts = await client.query('SELECT 1 FROM outbox_messages WHERE attempts > 0');
    expect(attempts.rowCount).toBe(0);
  }, 120_000);

  it('faixas paralelas no mesmo processo (4) e dois processos: cada evento chega uma vez', async () => {
    const clock = mutableClock(START);
    const total = await fillOutbox(clock, 100);
    const real = new SqsEventPublisher(sqs, EVENTS_QUEUE);
    const parallel = () =>
      new OutboxPublisherWorker(new MikroOrmOutboxUnitOfWork(em), real, clock, new MetricsRegistry(), silent, {
        retryPolicy: { baseDelayMs: 1000, maxDelayMs: 8000 },
        parallelism: 4,
      });
    const workers = [parallel(), parallel()];
    let claimed = 1;
    for (let round = 0; round < 50 && claimed > 0; round++) {
      const results = await Promise.all(workers.map((w) => w.runCycle(50)));
      claimed = results.reduce((sum, r) => sum + r.claimed, 0);
    }

    const received = await drainQueue(sqs, EVENTS_QUEUE);
    expect(received).toHaveLength(total);
    expect(new Set(received.map((m) => m.eventId)).size).toBe(total);
    const pending = await client.query('SELECT 1 FROM outbox_messages WHERE published_at IS NULL OR attempts > 0');
    expect(pending.rowCount).toBe(0);
  }, 120_000);

  it('publicação que falha depois de enviar: o mesmo eventId é reenviado, e só ele aparece duplicado', async () => {
    const clock = mutableClock(START);
    await fillOutbox(clock, 5); // 10 eventos
    const victim = (await client.query<{ id: string }>('SELECT id FROM outbox_messages ORDER BY occurred_at, id LIMIT 1')).rows[0]!.id;

    const real = new SqsEventPublisher(sqs, EVENTS_QUEUE);
    let failOnce = true;
    // envia e depois reporta erro, como um processo que morre entre a publicação e a marcação
    const flaky: EventPublisher = {
      publish: async (event) => {
        await real.publish(event);
        if (event.eventId === victim && failOnce) {
          failOnce = false;
          throw new Error('falha depois do envio');
        }
      },
    };

    await publisherWith(flaky, clock).runCycle(20);
    clock.advance(60_000);
    await publisherWith(real, clock).runCycle(20);

    const received = await drainQueue(sqs, EVENTS_QUEUE);
    const counts = new Map<string, number>();
    for (const m of received) counts.set(m.eventId!, (counts.get(m.eventId!) ?? 0) + 1);
    expect(counts.get(victim)).toBe(2);
    expect([...counts.entries()].filter(([id, n]) => id !== victim && n !== 1)).toEqual([]);
    expect(counts.size).toBe(10);
    const bodies = received.filter((m) => m.eventId === victim).map((m) => m.body);
    expect(bodies[0]).toBe(bodies[1]);
  }, 120_000);
});
