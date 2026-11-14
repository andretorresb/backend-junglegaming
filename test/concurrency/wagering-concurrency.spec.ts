import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { Client } from 'pg';
import { createPgClient, createTestOrm, truncateAll } from '../integration/helpers/database';
import { assertLedgerInvariant, command, countRows, seedWallet, useCase } from '../integration/helpers/wagering';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction';
import { FailureCode } from '../../src/domain/failure-code';
import { TransientInfrastructureError } from '../../src/application/wagering/errors';
import { WALLET_LOCK_TIMEOUT_MS } from '../../src/infrastructure/persistence/wagering.persistence';

/**
 * Concorrência com paralelismo real: várias conexões, todas no mesmo PostgreSQL.
 * Nenhum mock de banco. Cada chamada usa sua própria transação e conexão.
 */
describe('Concorrência — ProcessWagerTransaction com PostgreSQL real', () => {
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

  it('1. mesma aposta 50× em paralelo → um único débito', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    const bet = command({ walletId: w.walletId, playerId: w.playerId, amount: '25.00', externalTransactionId: 'same-bet' });
    const uc = useCase(em);

    const results = await Promise.all(Array.from({ length: 50 }, () => uc.execute(bet)));

    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.filter((r) => r.idempotentReplay)).toHaveLength(49);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.every((r) => r.status === WagerTransactionStatus.Processed)).toBe(true);
    expect(await balanceOf(w.walletId)).toBe('75.00');
    expect(await countRows(client, "SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'", [w.walletId])).toBe(1);
    await assertLedgerInvariant(client, w.walletId);
  });

  it('2. cenário obrigatório: saldo 100.00, duas apostas de 80.00 simultâneas → 1 PROCESSED, 1 REJECTED, saldo 20.00', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    const uc = useCase(em);

    const [a, b] = await Promise.all([
      uc.execute(command({ walletId: w.walletId, playerId: w.playerId, amount: '80.00' })),
      uc.execute(command({ walletId: w.walletId, playerId: w.playerId, amount: '80.00' })),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected].sort());
    const rejected = a.status === WagerTransactionStatus.Rejected ? a : b;
    expect(rejected.failureCode).toBe(FailureCode.InsufficientBalance);
    expect(await balanceOf(w.walletId)).toBe('20.00');
    expect(await countRows(client, "SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'", [w.walletId])).toBe(1);
    await assertLedgerInvariant(client, w.walletId);
  });

  it('3. mesma chave em wallets diferentes, em paralelo → uma processa, a outra recebe conflito', async () => {
    const w1 = await seedWallet(client, { balance: '100.00' });
    const w2 = await seedWallet(client, { balance: '100.00' });
    const key = `provider-a:shared-${randomUUID()}`;
    const uc = useCase(em);

    const settled = await Promise.allSettled([
      uc.execute({ ...command({ walletId: w1.walletId, playerId: w1.playerId, amount: '10.00', externalTransactionId: 'shared' }), idempotencyKey: key }),
      uc.execute({ ...command({ walletId: w2.walletId, playerId: w2.playerId, amount: '10.00', externalTransactionId: 'shared' }), idempotencyKey: key }),
    ]);

    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s) => s.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await countRows(client, 'SELECT id FROM wager_transactions WHERE idempotency_key = $1', [key])).toBe(1);
    const total = Number(await balanceOf(w1.walletId)) + Number(await balanceOf(w2.walletId));
    expect(total).toBe(190);
    await assertLedgerInvariant(client, w1.walletId);
    await assertLedgerInvariant(client, w2.walletId);
  });

  it('4. wallets distintas em paralelo (3 × 20 apostas) → cada saldo correto, invariante por wallet', async () => {
    const wallets = [
      await seedWallet(client, { balance: '100.00' }),
      await seedWallet(client, { balance: '200.00' }),
      await seedWallet(client, { balance: '300.00' }),
    ];
    const uc = useCase(em);
    const calls = wallets.flatMap((w) =>
      Array.from({ length: 20 }, () => uc.execute(command({ walletId: w.walletId, playerId: w.playerId, amount: '5.00' }))),
    );

    const results = await Promise.all(calls);

    expect(results.every((r) => r.status === WagerTransactionStatus.Processed)).toBe(true);
    expect(await balanceOf(wallets[0]!.walletId)).toBe('0.00');
    expect(await balanceOf(wallets[1]!.walletId)).toBe('100.00');
    expect(await balanceOf(wallets[2]!.walletId)).toBe('200.00');
    for (const w of wallets) await assertLedgerInvariant(client, w.walletId);
  });

  it('5. 30 apostas de 5.00 em paralelo sobre saldo 100.00 → exatamente 20 processadas, 10 rejeitadas, saldo 0.00', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    const uc = useCase(em);
    const calls = Array.from({ length: 30 }, () =>
      uc.execute(command({ walletId: w.walletId, playerId: w.playerId, amount: '5.00' })),
    );

    const results = await Promise.all(calls);

    expect(results.filter((r) => r.status === WagerTransactionStatus.Processed)).toHaveLength(20);
    expect(results.filter((r) => r.status === WagerTransactionStatus.Rejected)).toHaveLength(10);
    expect(await balanceOf(w.walletId)).toBe('0.00');
    expect(await countRows(client, "SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'", [w.walletId])).toBe(20);
    await assertLedgerInvariant(client, w.walletId);
  });

  it('6. wallet travada por outra transação além do lock_timeout → falha transitória (503), nada gravado', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    const holder = await createPgClient();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [w.walletId]);

      const started = Date.now();
      await expect(
        useCase(em).execute(command({ walletId: w.walletId, playerId: w.playerId, amount: '5.00' })),
      ).rejects.toBeInstanceOf(TransientInfrastructureError);
      expect(Date.now() - started).toBeGreaterThanOrEqual(WALLET_LOCK_TIMEOUT_MS - 200);

      await holder.query('ROLLBACK');
    } finally {
      await holder.end();
    }

    expect(await balanceOf(w.walletId)).toBe('100.00');
    expect(await countRows(client, "SELECT id FROM wager_transactions WHERE wallet_id = $1 AND kind <> 'OPENING'", [w.walletId])).toBe(0);
    await assertLedgerInvariant(client, w.walletId);
  }, 20_000);
});
