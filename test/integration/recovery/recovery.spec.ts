import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { Client } from 'pg';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { GetQueueAttributesCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { createPgClient, createTestOrm, truncateAll } from '../helpers/database';
import { assertLedgerInvariant, countRows, seedWallet } from '../helpers/wagering';
import { drainQueue } from '../helpers/sqs';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs-client';
import { ensureQueues, queueUrl, WAGER_DLQ, WAGER_QUEUE, EVENTS_QUEUE } from '../../../src/infrastructure/messaging/queues';
import { loadEnv } from '../../../src/config/env';
import { startAppProcess, randomPort, waitFor, type AppProcess } from '../../support/app-process';

const CONSUMER_ENV = {
  WAGER_CONSUMER_ENABLED: '1',
  SQS_VISIBILITY_SECONDS: '2',
  SQS_WAIT_SECONDS: '0',
};

describe('Recuperação — processo morto e reinício', () => {
  let orm: MikroORM;
  let client: Client;
  let sqs: SQSClient;

  beforeAll(async () => {
    orm = await createTestOrm();
    await orm.getMigrator().up();
    client = await createPgClient();
    sqs = createSqsClient(loadEnv());
    await ensureQueues(sqs);
  });

  beforeEach(async () => {
    await truncateAll(client);
    await drainQueue(sqs, WAGER_QUEUE);
    await drainQueue(sqs, WAGER_DLQ);
    await drainQueue(sqs, EVENTS_QUEUE);
  });

  afterAll(async () => {
    await client.end();
    await orm.close();
    sqs.destroy();
  });

  async function queueInFlightAndVisible(): Promise<number> {
    const url = await queueUrl(sqs, WAGER_QUEUE);
    const r = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }),
    );
    return Number(r.Attributes?.['ApproximateNumberOfMessages'] ?? 0) + Number(r.Attributes?.['ApproximateNumberOfMessagesNotVisible'] ?? 0);
  }

  it('processo morre depois do commit e antes do ack: o reprocessamento não duplica o efeito', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    const ext = `crash-${randomUUID()}`;
    const url = await queueUrl(sqs, WAGER_QUEUE);
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: url,
        MessageGroupId: w.walletId,
        MessageDeduplicationId: randomUUID(),
        MessageBody: JSON.stringify({
          messageId: `msg-${ext}`,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: {
            providerId: 'provider-a',
            externalTransactionId: ext,
            idempotencyKey: `provider-a:${ext}`,
            playerId: w.playerId,
            walletId: w.walletId,
            roundId: 'round-987',
            gameId: 'fortune-chimp',
            kind: 'BET',
            money: { amount: '25.00', currency: 'BRL' },
          },
        }),
      }),
    );

    // 1) processo que morre exatamente entre o commit e o ack (falha injetada, código 137)
    const port1 = randomPort();
    const victim = await startAppProcess(port1, { ...CONSUMER_ENV, FAULT_CRASH_AFTER_COMMIT: '1' }, { awaitLive: false });
    const exitCode = await withTimeout(victim.exited, 30_000, () => victim.output());
    expect(exitCode).toBe(137);

    // o commit aconteceu; a mensagem ficou em voo
    expect(await countRows(client, "SELECT id FROM wager_transactions WHERE external_transaction_id = $1", [ext])).toBe(1);
    expect(await queueInFlightAndVisible()).toBe(1);

    // 2) outro processo recebe a redelivery (após a visibilidade) e confirma sem novo efeito
    const survivor = await startAppProcess(randomPort(), CONSUMER_ENV);
    await waitFor(async () => (await queueInFlightAndVisible()) === 0, 30_000, survivor.output);
    await survivor.terminate();

    expect(await countRows(client, "SELECT id FROM wager_transactions WHERE external_transaction_id = $1", [ext])).toBe(1);
    expect(await countRows(client, "SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'", [w.walletId])).toBe(1);
    const balance = await client.query<{ balance: string }>('SELECT balance::text AS balance FROM wallets WHERE id = $1', [w.walletId]);
    expect(balance.rows[0]?.balance).toBe('75.00');
    await assertLedgerInvariant(client, w.walletId);
  }, 120_000);

  it('reinício com pendências: o shutdown é limpo e, depois do reinício, a consistência final é verificada', async () => {
    const w = await seedWallet(client, { balance: '500.00' });
    const processing = { PENDING_REFERENCE_POLL_MS: '300', OUTBOX_POLL_MS: '300', OUTBOX_BATCH_SIZE: '20' };

    // 1) primeira vida do serviço: apostas, reversões que chegam antes das apostas (pendentes)
    const first = await startAppProcess(randomPort(), processing);
    const post = (proc: AppProcess, body: Record<string, unknown>, key: string) =>
      fetch(`${proc.base}/wagering/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify(body),
      }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));
    const bet = (ext: string, amount: string) => ({
      providerId: 'provider-a',
      externalTransactionId: ext,
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    });
    for (let i = 0; i < 10; i++) await post(first, bet(`pre-${i}`, '10.00'), `pre-key-${i}`);
    for (let i = 0; i < 5; i++) {
      const r = await post(first, { ...bet(`rb-${i}`, '10.00'), kind: 'ROLLBACK', referenceExternalTransactionId: `late-bet-${i}` }, `rb-key-${i}`);
      expect(r.status).toBe(202);
    }
    expect(await countRows(client, "SELECT id FROM wager_transactions WHERE status = 'PENDING_REFERENCE'")).toBe(5);

    // 2) shutdown gracioso (SIGTERM). O Nest executa onModuleDestroy e depois re-emite o sinal,
    //    então a saída é 128 + 15 = 143. Qualquer outra saída (ex.: SIGKILL, 137) indicaria shutdown forçado.
    expect(gracefulExit(await first.terminate())).toBe(true);

    // 3) reinício: as apostas tardias chegam, e o worker e o publisher resolvem tudo sozinhos
    const second = await startAppProcess(randomPort(), processing);
    for (let i = 0; i < 5; i++) await post(second, bet(`late-bet-${i}`, '10.00'), `late-key-${i}`);
    await waitFor(async () => (await countRows(client, "SELECT id FROM wager_transactions WHERE status = 'PENDING_REFERENCE'")) === 0, 30_000, second.output);
    await waitFor(async () => (await countRows(client, 'SELECT id FROM outbox_messages WHERE published_at IS NULL')) === 0, 30_000, second.output);

    // 4) consistência final: 500 − 15 apostas de 10 (−150) + 5 ROLLBACKs de 10 (+50) = 400
    expect(await countRows(client, "SELECT id FROM wager_transactions WHERE status = 'PROCESSED' AND kind = 'ROLLBACK'")).toBe(5);
    const rec = await fetch(`${second.base}/wallets/${w.walletId}/reconciliation`, { method: 'POST' }).then((r) => r.json() as Promise<{ consistent: boolean; storedBalance: { amount: string } }>);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe('400.00');
    await assertLedgerInvariant(client, w.walletId);
    expect(gracefulExit(await second.terminate())).toBe(true);
  }, 180_000);
});

/** Saída limpa: 0, ou 143 quando o Nest re-emite o SIGTERM depois dos shutdown hooks. */
function gracefulExit(code: number): boolean {
  return code === 0 || code === 143;
}

/** Aguarda uma promessa com prazo. Em caso de estouro, o erro traz a saída do processo. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, output: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`prazo de ${timeoutMs}ms estourado. Saída:\n${output().slice(-1500)}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
