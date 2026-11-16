import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Client } from 'pg';
import { createPgClient, createTestOrm, truncateAll } from '../helpers/database';
import { assertLedgerInvariant, command, countRows, mutableClock, seedWallet } from '../helpers/wagering';
import { ProcessWagerTransaction } from '../../../src/application/wagering/process-wager-transaction.use-case';
import type { WagerRepositories, WagerUnitOfWork } from '../../../src/application/wagering/ports';
import { MikroOrmWagerUnitOfWork } from '../../../src/infrastructure/persistence/wagering.persistence';

/**
 * Atomicidade entre wallet, ledger, inbox e outbox (seção 11 e 13 do enunciado).
 * Para cada ponto do commit, uma falha forçada aborta a transação inteira: nada fica pela metade.
 */
describe('Atomicidade — falha em cada ponto do commit desfaz tudo', () => {
  let orm: MikroORM;
  let client: Client;

  beforeAll(async () => {
    orm = await createTestOrm();
    await orm.getMigrator().up();
    client = await createPgClient();
  });

  beforeEach(async () => {
    await truncateAll(client);
  });

  afterAll(async () => {
    await client.end();
    await orm.close();
  });

  /** Repositórios reais, exceto a operação indicada, que falha depois de a anterior ter gravado. */
  function failingAt(operation: keyof WagerRepositories): WagerUnitOfWork {
    const real = new MikroOrmWagerUnitOfWork(orm.em);
    return {
      run: (work) =>
        real.run((repos) =>
          work(
            new Proxy(repos, {
              get(target, prop, receiver) {
                if (prop === operation) {
                  return async () => {
                    throw new Error(`falha forçada em ${String(operation)}`);
                  };
                }
                return Reflect.get(target, prop, receiver);
              },
            }) as WagerRepositories,
          ),
        ),
    };
  }

  // Ordem real do commit de um BET com inbox: lock → inbox → transação → débito da wallet → ledger → outbox.
  const steps: Array<keyof WagerRepositories> = [
    'insertInbox',
    'insertTransaction',
    'saveWallet',
    'insertLedgerEntry',
    'enqueueOutbox',
  ];

  for (const step of steps) {
    it(`falha em ${step}: nenhuma linha de transação, ledger, inbox ou outbox; saldo intacto`, async () => {
      const w = await seedWallet(client, { balance: '100.00' });
      const ledgerBefore = await countRows(client, 'SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1', [w.walletId]);
      const messageId = `msg-${randomUUID()}`;
      const uc = new ProcessWagerTransaction(failingAt(step), mutableClock(new Date('2026-07-29T15:00:00Z')), randomUUID);

      await expect(
        uc.execute(command({ walletId: w.walletId, playerId: w.playerId, amount: '25.00', externalTransactionId: `atom-${step}` }), {
          consumerName: 'wager-transactions',
          messageId,
        }),
      ).rejects.toThrow(`falha forçada em ${step}`);

      expect(await countRows(client, "SELECT id FROM wager_transactions WHERE external_transaction_id = $1", [`atom-${step}`])).toBe(0);
      // o lançamento OPENING da fixture já existia; a falha não pode acrescentar nenhum
      expect(await countRows(client, "SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1", [w.walletId])).toBe(ledgerBefore);
      expect(await countRows(client, 'SELECT message_id FROM inbox_messages WHERE message_id = $1', [messageId])).toBe(0);
      expect(await countRows(client, "SELECT id FROM outbox_messages WHERE aggregate_id = $1::uuid OR payload::text LIKE $2", [w.walletId, `%atom-${step}%`])).toBe(0);
      const balance = await client.query<{ balance: string; version: number }>('SELECT balance::text AS balance, version FROM wallets WHERE id = $1', [w.walletId]);
      expect(balance.rows[0]).toEqual({ balance: '100.00', version: 1 });
      await assertLedgerInvariant(client, w.walletId);
    });
  }

  it('sem falha: todas as linhas existem juntas (controle do experimento)', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    const messageId = `msg-${randomUUID()}`;
    const uc = new ProcessWagerTransaction(new MikroOrmWagerUnitOfWork(orm.em), mutableClock(new Date('2026-07-29T15:00:00Z')), randomUUID);
    await uc.execute(command({ walletId: w.walletId, playerId: w.playerId, amount: '25.00', externalTransactionId: 'atom-ok' }), {
      consumerName: 'wager-transactions',
      messageId,
    });
    expect(await countRows(client, "SELECT id FROM wager_transactions WHERE external_transaction_id = 'atom-ok'")).toBe(1);
    expect(await countRows(client, "SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'", [w.walletId])).toBe(1);
    expect(await countRows(client, 'SELECT message_id FROM inbox_messages WHERE message_id = $1 AND processed_at IS NOT NULL', [messageId])).toBe(1);
    expect(await countRows(client, "SELECT id FROM outbox_messages WHERE payload::text LIKE '%atom-ok%'")).toBe(1);
    await assertLedgerInvariant(client, w.walletId);
  });
});
