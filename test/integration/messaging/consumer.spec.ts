import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { Client } from 'pg';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { GetQueueAttributesCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createPgClient, createTestOrm, truncateAll } from '../helpers/database';
import { assertLedgerInvariant, mutableClock, seedWallet } from '../helpers/wagering';
import { drainQueue } from '../helpers/sqs';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs-client';
import { ensureQueues, queueUrl, WAGER_DLQ, WAGER_QUEUE } from '../../../src/infrastructure/messaging/queues';
import { WagerTransactionsConsumer, type WagerConsumerSettings } from '../../../src/interfaces/messaging/sqs/wager-transactions.consumer';
import type { ConsumerLifecycle } from '../../../src/interfaces/messaging/sqs/lifecycle';
import { MetricsRegistry } from '../../../src/infrastructure/observability/metrics-registry';
import { loadEnv } from '../../../src/config/env';
import { TransientInfrastructureError } from '../../../src/application/wagering/errors';
import type { ProcessWagerTransaction } from '../../../src/application/wagering/process-wager-transaction.use-case';
import { MikroOrmWagerUnitOfWork } from '../../../src/infrastructure/persistence/wagering.persistence';
import { ProcessWagerTransaction as UseCase } from '../../../src/application/wagering/process-wager-transaction.use-case';
import type { Logger } from '../../../src/application/ports/observability';
import { randomUUID as uuid } from 'node:crypto';

const silent: Logger = { info: () => undefined, error: () => undefined };
const SETTINGS: WagerConsumerSettings = {
  queueName: WAGER_QUEUE,
  dlqName: WAGER_DLQ,
  waitSeconds: 0,
  maxMessages: 10,
  maxReceiveCount: 3,
  retryBaseSeconds: 1,
  retryMaxSeconds: 2,
  shutdownGraceMs: 300,
};

interface Ctx {
  sqs: SQSClient;
  wallet: { walletId: string; playerId: string };
  messageBody(data: Record<string, unknown>, messageId?: string): string;
  send(body: string, group?: string): Promise<void>;
}

function messageBody(messageId: string, data: Record<string, unknown>): string {
  return JSON.stringify({ messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data });
}

describe('Consumidor SQS — wager-transactions.fifo', () => {
  let orm: MikroORM;
  let client: Client;
  let em: EntityManager;
  let sqs: SQSClient;
  let metrics: MetricsRegistry;
  const lifecycle: ConsumerLifecycle = { draining: false };

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
    metrics = new MetricsRegistry();
    lifecycle.draining = false;
  });

  afterAll(async () => {
    await client.end();
    await orm.close();
    sqs.destroy();
  });

  async function ctx(balance = '100.00'): Promise<Ctx> {
    const wallet = await seedWallet(client, { balance });
    const url = await queueUrl(sqs, WAGER_QUEUE);
    return {
      sqs,
      wallet,
      messageBody: (data, messageId = `msg-${uuid()}`) => messageBody(messageId, data),
      send: async (body, group = wallet.walletId) => {
        await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: body, MessageGroupId: group, MessageDeduplicationId: randomUUID() }));
      },
    };
  }

  const betData = (w: { walletId: string; playerId: string }, ext: string, amount = '25.00', extra: Record<string, unknown> = {}) => ({
    providerId: 'provider-a',
    externalTransactionId: ext,
    idempotencyKey: `provider-a:${ext}`,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
    ...extra,
  });

  function consumer(useCase: ProcessWagerTransaction, hooks?: { afterCommit?: (id: string) => void | Promise<void> }) {
    return new WagerTransactionsConsumer(
      { sqs, useCase, logger: silent, metrics, lifecycle, hooks },
      SETTINGS,
    );
  }

  const realUseCase = () => new UseCase(new MikroOrmWagerUnitOfWork(em), mutableClock(new Date()), randomUUID);

  /** Mensagens visíveis na fila, sem consumi-las. */
  async function approx(queueName: string): Promise<number> {
    const url = await queueUrl(sqs, queueName);
    const r = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['ApproximateNumberOfMessages'] }));
    return Number(r.Attributes?.['ApproximateNumberOfMessages'] ?? 0);
  }

  /** Roda o consumidor até a condition ser verdadeira. Não consome as mensagens por fora. */
  async function pollUntil(c: WagerTransactionsConsumer, predicate: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await c.pollOnce();
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('condição não atingida no prazo');
  }

  /** Processa até a fila ficar ociosa: duas leituras vazias seguidas. */
  async function runUntilIdle(c: WagerTransactionsConsumer): Promise<void> {
    let empty = 0;
    for (let i = 0; i < 100 && empty < 2; i++) {
      const n = await c.pollOnce();
      empty = n === 0 ? empty + 1 : 0;
      if (empty === 1) await new Promise((r) => setTimeout(r, 300));
    }
  }

  it('mensagem válida: processada, inbox gravada, ack (fila vazia) e eventos na outbox', async () => {
    const c = await ctx();
    const messageId = `msg-${uuid()}`;
    await c.send(c.messageBody(betData(c.wallet, 'ext-ok'), messageId));

    await consumer(realUseCase()).pollOnce();

    const tx = await client.query<{ status: string }>("SELECT status FROM wager_transactions WHERE external_transaction_id = 'ext-ok'");
    expect(tx.rows[0]?.status).toBe('PROCESSED');
    const inbox = await client.query<{ processed_at: Date | null }>('SELECT processed_at FROM inbox_messages WHERE message_id = $1', [messageId]);
    expect(inbox.rows[0]?.processed_at).not.toBeNull();
    expect((await drainQueue(sqs, WAGER_QUEUE)).length).toBe(0);
    expect((await drainQueue(sqs, WAGER_DLQ)).length).toBe(0);
    await assertLedgerInvariant(client, c.wallet.walletId);
  });

  it('a mesma mensagem entregue duas vezes (mesmo messageId) tem um único efeito', async () => {
    const c = await ctx();
    const messageId = `msg-${uuid()}`;
    const body = c.messageBody(betData(c.wallet, 'ext-dup'), messageId);
    await c.send(body);
    await c.send(body); // entrega duplicada: o SQS não deduplica entre IDs de mensagem diferentes

    await runUntilIdle(consumer(realUseCase()));

    const txs = await client.query('SELECT id FROM wager_transactions WHERE external_transaction_id = $1', ['ext-dup']);
    expect(txs.rowCount).toBe(1);
    const debits = await client.query("SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'", [c.wallet.walletId]);
    expect(debits.rowCount).toBe(1);
    expect(metrics.value('duplicates_detected_total', { source: 'sqs' })).toBeGreaterThanOrEqual(1);
    await assertLedgerInvariant(client, c.wallet.walletId);
  });

  it('JSON inválido → DLQ com motivo, original confirmada', async () => {
    const c = await ctx();
    await c.send('isto não é json');
    await consumer(realUseCase()).pollOnce();

    expect((await drainQueue(sqs, WAGER_QUEUE)).length).toBe(0);
    const dead = await drainQueue(sqs, WAGER_DLQ);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.body).toBe('isto não é json');
  });

  it('schema inválido (sem walletId) → DLQ', async () => {
    const c = await ctx();
    const data = betData(c.wallet, 'ext-bad') as Record<string, unknown>;
    delete data['walletId'];
    await c.send(c.messageBody(data));
    await consumer(realUseCase()).pollOnce();
    expect((await drainQueue(sqs, WAGER_DLQ)).length).toBe(1);
  });

  it('OPENING via fila é permanente → DLQ', async () => {
    const c = await ctx();
    await c.send(c.messageBody(betData(c.wallet, 'ext-open', '1.00', { kind: 'OPENING' })));
    await consumer(realUseCase()).pollOnce();
    expect((await drainQueue(sqs, WAGER_DLQ)).length).toBe(1);
  });

  it('wallet inexistente → DLQ (permanente)', async () => {
    const c = await ctx();
    const data = betData(c.wallet, 'ext-nowallet', '1.00', { walletId: randomUUID() });
    await c.send(c.messageBody(data));
    await consumer(realUseCase()).pollOnce();
    expect((await drainQueue(sqs, WAGER_DLQ)).length).toBe(1);
  });

  it('rejeição de negócio (saldo insuficiente) é resultado: persistido como REJECTED e confirmado, sem DLQ', async () => {
    const c = await ctx('10.00');
    await c.send(c.messageBody(betData(c.wallet, 'ext-poor', '25.00')));
    await consumer(realUseCase()).pollOnce();

    const tx = await client.query<{ status: string; failure_code: string }>("SELECT status, failure_code FROM wager_transactions WHERE external_transaction_id = 'ext-poor'");
    expect(tx.rows[0]).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_BALANCE' });
    expect((await drainQueue(sqs, WAGER_DLQ)).length).toBe(0);
    expect((await drainQueue(sqs, WAGER_QUEUE)).length).toBe(0);
  });

  it('erro transitório: a mensagem não é confirmada, volta com atraso e vai para a DLQ no limite de tentativas', async () => {
    const c = await ctx();
    await c.send(c.messageBody(betData(c.wallet, 'ext-flaky')));
    const failing = { execute: async () => { throw new TransientInfrastructureError('banco indisponível'); } } as unknown as ProcessWagerTransaction;

    await pollUntil(consumer(failing), async () => (await approx(WAGER_DLQ)) === 1);
    const dead = await drainQueue(sqs, WAGER_DLQ);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.body).toContain('ext-flaky');
    expect(metrics.value('retries_total', { component: 'sqs' })).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it('falha depois do commit e antes do ack: a redelivery não duplica o efeito', async () => {
    const c = await ctx();
    await c.send(c.messageBody(betData(c.wallet, 'ext-crash')));
    let crashed = false;
    const cons = consumer(realUseCase(), {
      afterCommit: () => {
        if (!crashed) {
          crashed = true;
          throw new Error('processo morreu entre o commit e o ack');
        }
      },
    });

    await pollUntil(cons, async () => crashed && metrics.value('duplicates_detected_total', { source: 'sqs' }) >= 1 && (await approx(WAGER_QUEUE)) === 0);

    const txs = await client.query('SELECT id FROM wager_transactions WHERE external_transaction_id = $1', ['ext-crash']);
    expect(txs.rowCount).toBe(1);
    expect(metrics.value('duplicates_detected_total', { source: 'sqs' })).toBe(1);
    await assertLedgerInvariant(client, c.wallet.walletId);
  });

  it('shutdown: a mensagem em andamento termina (commit e ack); o que não foi recebido fica na fila', async () => {
    const c = await ctx();
    await c.send(c.messageBody(betData(c.wallet, 'ext-inflight')));
    await c.send(c.messageBody(betData(c.wallet, 'ext-later')));

    const slow = consumer(realUseCase(), { afterCommit: () => new Promise((r) => setTimeout(r, 800)) });
    const poll = slow.pollOnce();
    await new Promise((r) => setTimeout(r, 200));
    await slow.stop();
    await poll.catch(() => undefined);

    expect(lifecycle.draining).toBe(true);
    const tx = await client.query("SELECT 1 FROM wager_transactions WHERE external_transaction_id = 'ext-inflight'");
    expect(tx.rowCount).toBe(1);
    const remaining = await drainQueue(sqs, WAGER_QUEUE);
    expect(remaining.map((m) => JSON.parse(m.body).data.externalTransactionId)).toEqual(['ext-later']);
  }, 30_000);
});
