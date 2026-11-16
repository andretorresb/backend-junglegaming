import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { Client } from 'pg';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { GetQueueAttributesCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createPgClient, createTestOrm, truncateAll } from '../integration/helpers/database';
import { assertLedgerInvariant, mutableClock, seedWallet } from '../integration/helpers/wagering';
import { drainQueue } from '../integration/helpers/sqs';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';
import { ensureQueues, queueUrl, WAGER_DLQ, WAGER_QUEUE } from '../../src/infrastructure/messaging/queues';
import { WagerTransactionsConsumer } from '../../src/interfaces/messaging/sqs/wager-transactions.consumer';
import { ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction.use-case';
import { MikroOrmWagerUnitOfWork } from '../../src/infrastructure/persistence/wagering.persistence';
import { MetricsRegistry } from '../../src/infrastructure/observability/metrics-registry';
import { loadEnv } from '../../src/config/env';

const silent = { info: () => undefined, error: () => undefined };

describe('Concorrência — consumidor SQS com várias instâncias', () => {
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
    await drainQueue(sqs, WAGER_QUEUE);
    await drainQueue(sqs, WAGER_DLQ);
  });

  afterAll(async () => {
    await client.end();
    await orm.close();
    sqs.destroy();
  });

  async function queueState(): Promise<{ visible: number; inFlight: number }> {
    const url = await queueUrl(sqs, WAGER_QUEUE);
    const r = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }),
    );
    return {
      visible: Number(r.Attributes?.['ApproximateNumberOfMessages'] ?? 0),
      inFlight: Number(r.Attributes?.['ApproximateNumberOfMessagesNotVisible'] ?? 0),
    };
  }

  async function send(body: string, group: string): Promise<void> {
    const url = await queueUrl(sqs, WAGER_QUEUE);
    await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: body, MessageGroupId: group, MessageDeduplicationId: randomUUID() }));
  }

  const body = (messageId: string, data: Record<string, unknown>) =>
    JSON.stringify({ messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data });

  function makeConsumer(metrics: MetricsRegistry) {
    return new WagerTransactionsConsumer(
      {
        sqs,
        useCase: new ProcessWagerTransaction(new MikroOrmWagerUnitOfWork(em), mutableClock(new Date()), randomUUID),
        logger: silent,
        metrics,
        lifecycle: { draining: false },
      },
      {
        queueName: WAGER_QUEUE,
        dlqName: WAGER_DLQ,
        waitSeconds: 0,
        maxMessages: 10,
        maxReceiveCount: 5,
        retryBaseSeconds: 1,
        retryMaxSeconds: 2,
        shutdownGraceMs: 500,
      },
    );
  }

  it('três consumidores, seis wallets, 60 mensagens e entregas duplicadas → cada efeito uma vez', async () => {
    const wallets = await Promise.all(Array.from({ length: 6 }, () => seedWallet(client, { balance: '100.00' })));
    const perWallet = 10;
    for (const w of wallets) {
      for (let i = 0; i < perWallet; i++) {
        const ext = `bet-${w.walletId}-${i}`;
        const data = {
          providerId: 'provider-a',
          externalTransactionId: ext,
          idempotencyKey: `provider-a:${ext}`,
          playerId: w.playerId,
          walletId: w.walletId,
          roundId: 'round-987',
          gameId: 'fortune-chimp',
          kind: 'BET',
          money: { amount: '5.00', currency: 'BRL' },
        };
        const messageId = `msg-${ext}`;
        await send(body(messageId, data), w.walletId);
        if (i % 3 === 0) await send(body(messageId, data), w.walletId); // entrega duplicada
      }
    }

    const metrics = [new MetricsRegistry(), new MetricsRegistry(), new MetricsRegistry()];
    const consumers = metrics.map(makeConsumer);
    const deadline = Date.now() + 90_000;
    let drained = false;
    while (Date.now() < deadline && !drained) {
      await Promise.all(consumers.map((c) => c.pollOnce()));
      const state = await queueState();
      const processed = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM wager_transactions WHERE kind = 'BET'");
      drained = state.visible === 0 && state.inFlight === 0 && Number(processed.rows[0]?.n) === wallets.length * perWallet;
      if (!drained) await new Promise((r) => setTimeout(r, 200));
    }
    expect(drained).toBe(true);

    const txs = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM wager_transactions WHERE kind = 'BET'");
    expect(Number(txs.rows[0]?.n)).toBe(wallets.length * perWallet);
    for (const w of wallets) {
      const r = await client.query<{ balance: string }>('SELECT balance::text AS balance FROM wallets WHERE id = $1', [w.walletId]);
      expect(r.rows[0]?.balance).toBe('50.00');
      await assertLedgerInvariant(client, w.walletId);
    }
    const duplicates = metrics.reduce((sum, m) => sum + m.value('duplicates_detected_total', { source: 'sqs' }), 0);
    expect(duplicates).toBeGreaterThan(0);
    expect((await drainQueue(sqs, WAGER_DLQ)).length).toBe(0);
  }, 120_000);
});
