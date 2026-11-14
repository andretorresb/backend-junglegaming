import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { Client } from 'pg';
import { createPgClient, createTestOrm, truncateAll } from '../integration/helpers/database';
import { assertLedgerInvariant, command, countRows, seedWallet, useCase } from '../integration/helpers/wagering';
import { FailureCode } from '../../src/domain/failure-code';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction';

describe('Concorrência — REFUND e ROLLBACK sobre a mesma transação', () => {
  let orm: MikroORM;
  let client: Client;
  let em: EntityManager;

  beforeAll(async () => {
    orm = await createTestOrm();
    await orm.getMigrator().up();
    client = await createPgClient();
    em = orm.em;
  });

  beforeEach(async () => {
    await truncateAll(client);
  });

  afterAll(async () => {
    await client.end();
    await orm.close();
  });

  async function balanceOf(walletId: string): Promise<string> {
    const r = await client.query<{ balance: string }>('SELECT balance::text AS balance FROM wallets WHERE id = $1', [walletId]);
    return r.rows[0]?.balance ?? '';
  }

  async function placeBet(w: { walletId: string; playerId: string }, ext: string, amount: string) {
    return useCase(em).execute(command({ walletId: w.walletId, playerId: w.playerId, amount, externalTransactionId: ext }));
  }

  function reversal(
    w: { walletId: string; playerId: string },
    kind: 'REFUND' | 'ROLLBACK',
    ext: string,
    amount: string,
    referenceExternalTransactionId: string,
  ) {
    return useCase(em).execute({
      ...command({ walletId: w.walletId, playerId: w.playerId, kind, amount, externalTransactionId: ext }),
      kind: kind as never,
      referenceExternalTransactionId,
    });
  }

  it('REFUND e ROLLBACK simultâneos da mesma BET → exatamente um processa; saldo creditado uma única vez', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    await placeBet(w, 'bet-1', '25.00');

    const [refund, rollback] = await Promise.all([
      reversal(w, 'REFUND', 'refund-1', '25.00', 'bet-1'),
      reversal(w, 'ROLLBACK', 'rb-1', '25.00', 'bet-1'),
    ]);

    const statuses = [refund.status, rollback.status].sort();
    expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected].sort());
    const loser = refund.status === WagerTransactionStatus.Rejected ? refund : rollback;
    expect(loser.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(await balanceOf(w.walletId)).toBe('100.00');
    await assertLedgerInvariant(client, w.walletId);
  });

  it('20 REFUNDs paralelos da mesma BET (chaves diferentes) → um único crédito', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    await placeBet(w, 'bet-2', '25.00');

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => reversal(w, 'REFUND', `refund-p-${i}`, '25.00', 'bet-2')),
    );

    expect(results.filter((r) => r.status === WagerTransactionStatus.Processed)).toHaveLength(1);
    expect(results.filter((r) => r.failureCode === FailureCode.ReferenceAlreadyReversed)).toHaveLength(19);
    expect(await balanceOf(w.walletId)).toBe('100.00');
    expect(await countRows(client, "SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'CREDIT'", [w.walletId])).toBe(2);
    await assertLedgerInvariant(client, w.walletId);
  });

  it('ROLLBACK de WIN concorrente com apostas que gastam o saldo → nunca fica negativo', async () => {
    const w = await seedWallet(client, { balance: '0.00' });
    await useCase(em).execute(command({ walletId: w.walletId, playerId: w.playerId, kind: 'WIN', amount: '50.00', externalTransactionId: 'win-x' }));

    const bets = Array.from({ length: 4 }, (_, i) => placeBet(w, `bet-g-${i}`, '20.00'));
    const rollback = reversal(w, 'ROLLBACK', 'rb-x', '50.00', 'win-x');
    await Promise.all([...bets, rollback]);

    expect(Number(await balanceOf(w.walletId))).toBeGreaterThanOrEqual(0);
    await assertLedgerInvariant(client, w.walletId);
  });
});
