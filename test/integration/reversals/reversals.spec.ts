import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { Client } from 'pg';
import { createPgClient, createTestOrm, truncateAll } from '../helpers/database';
import { assertLedgerInvariant, command, countRows, seedWallet, useCase } from '../helpers/wagering';
import { FailureCode } from '../../../src/domain/failure-code';
import { WagerTransactionStatus } from '../../../src/domain/wagering/wager-transaction';
import type { ProcessWagerTransactionCommand } from '../../../src/application/wagering/process-wager-transaction.use-case';

/**
 * Matriz de REFUND e ROLLBACK (seção 7 do enunciado), contra PostgreSQL real.
 */
describe('REFUND e ROLLBACK — matriz de regras', () => {
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

  async function ledgerCount(walletId: string): Promise<number> {
    return countRows(client, 'SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1', [walletId]);
  }

  /** Executa uma operação do tipo indicado e devolve o resultado. */
  function op(
    w: { walletId: string; playerId: string },
    kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK',
    amount: string,
    extra: Partial<ProcessWagerTransactionCommand> & { externalTransactionId?: string; referenceExternalTransactionId?: string } = {},
  ) {
    const base = command({ walletId: w.walletId, playerId: w.playerId, kind, amount, externalTransactionId: extra.externalTransactionId });
    return useCase(em).execute({ ...base, ...extra, kind: kind as never });
  }

  async function bet(w: { walletId: string; playerId: string }, externalTransactionId: string, amount = '25.00') {
    return op(w, 'BET', amount, { externalTransactionId });
  }

  it('REFUND de BET processada: credita o valor, lançamento CREDIT, saldo restaurado', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    await bet(w, 'bet-1');
    const refund = await op(w, 'REFUND', '25.00', { referenceExternalTransactionId: 'bet-1' });

    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(refund.balance.amount).toBe('100.00');
    expect(await balanceOf(w.walletId)).toBe('100.00');
    expect(await countRows(client, "SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'CREDIT'", [w.walletId])).toBe(2);
    await assertLedgerInvariant(client, w.walletId);
  });

  it('REFUND de BET já reembolsada (outra chave) → REFERENCE_ALREADY_REVERSED, sem novo crédito', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    await bet(w, 'bet-1');
    await op(w, 'REFUND', '25.00', { referenceExternalTransactionId: 'bet-1', externalTransactionId: 'refund-1' });
    const second = await op(w, 'REFUND', '25.00', { referenceExternalTransactionId: 'bet-1', externalTransactionId: 'refund-2' });

    expect(second.status).toBe(WagerTransactionStatus.Rejected);
    expect(second.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(await balanceOf(w.walletId)).toBe('100.00');
    await assertLedgerInvariant(client, w.walletId);
  });

  it('REFUND e ROLLBACK da mesma BET: o segundo é rejeitado (não pode creditar duas vezes)', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    await bet(w, 'bet-1');
    await op(w, 'REFUND', '25.00', { referenceExternalTransactionId: 'bet-1', externalTransactionId: 'refund-1' });
    const rollback = await op(w, 'ROLLBACK', '25.00', { referenceExternalTransactionId: 'bet-1', externalTransactionId: 'rb-1' });

    expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(await balanceOf(w.walletId)).toBe('100.00');
    await assertLedgerInvariant(client, w.walletId);
  });

  it('REFUND com valor diferente → AMOUNT_MISMATCH_ON_REVERSAL', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    await bet(w, 'bet-1');
    const res = await op(w, 'REFUND', '20.00', { referenceExternalTransactionId: 'bet-1' });
    expect(res.failureCode).toBe(FailureCode.AmountMismatchOnReversal);
    expect(await balanceOf(w.walletId)).toBe('75.00');
  });

  it('REFUND de WIN → REFERENCE_TYPE_NOT_ALLOWED', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    await op(w, 'WIN', '10.00', { externalTransactionId: 'win-1' });
    const res = await op(w, 'REFUND', '10.00', { referenceExternalTransactionId: 'win-1' });
    expect(res.failureCode).toBe(FailureCode.ReferenceTypeNotAllowed);
  });

  it('REFUND com roundId diferente da BET → REFERENCE_CONTEXT_MISMATCH', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    await bet(w, 'bet-1');
    const res = await op(w, 'REFUND', '25.00', { referenceExternalTransactionId: 'bet-1', roundId: 'round-outra' });
    expect(res.failureCode).toBe(FailureCode.ReferenceContextMismatch);
    expect(await balanceOf(w.walletId)).toBe('75.00');
  });

  it('REFUND de BET rejeitada → REFERENCE_NOT_PROCESSED', async () => {
    const w = await seedWallet(client, { balance: '10.00' });
    await bet(w, 'bet-rej', '25.00');
    const res = await op(w, 'REFUND', '25.00', { referenceExternalTransactionId: 'bet-rej' });
    expect(res.failureCode).toBe(FailureCode.ReferenceNotProcessed);
  });

  it('REFUND com referência inexistente → REFERENCE_NOT_FOUND (a Etapa 5 troca por PENDING_REFERENCE)', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    const res = await op(w, 'REFUND', '25.00', { referenceExternalTransactionId: 'nunca-existiu' });
    expect(res.status).toBe(WagerTransactionStatus.Rejected);
    expect(res.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  it('REFUND de BET de outro jogador → REFERENCE_CONTEXT_MISMATCH', async () => {
    const dono = await seedWallet(client, { balance: '100.00' });
    const outro = await seedWallet(client, { balance: '100.00' });
    await bet(dono, 'bet-dono');
    const res = await op(outro, 'REFUND', '25.00', { referenceExternalTransactionId: 'bet-dono' });
    expect(res.failureCode).toBe(FailureCode.ReferenceContextMismatch);
  });

  it('ROLLBACK de BET → credita (desfaz o débito)', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    await bet(w, 'bet-1');
    const res = await op(w, 'ROLLBACK', '25.00', { referenceExternalTransactionId: 'bet-1' });
    expect(res.status).toBe(WagerTransactionStatus.Processed);
    expect(await balanceOf(w.walletId)).toBe('100.00');
    await assertLedgerInvariant(client, w.walletId);
  });

  it('ROLLBACK de WIN com saldo suficiente → debita (desfaz o crédito)', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    await op(w, 'WIN', '40.00', { externalTransactionId: 'win-1' });
    const res = await op(w, 'ROLLBACK', '40.00', { referenceExternalTransactionId: 'win-1' });
    expect(res.status).toBe(WagerTransactionStatus.Processed);
    expect(await balanceOf(w.walletId)).toBe('100.00');
    await assertLedgerInvariant(client, w.walletId);
  });

  it('ROLLBACK de WIN após o saldo ser gasto → NEGATIVE_BALANCE_ON_REVERSAL, sem lançamento, saldo intacto', async () => {
    const w = await seedWallet(client, { balance: '0.00' });
    await op(w, 'WIN', '40.00', { externalTransactionId: 'win-1' });
    await bet(w, 'bet-gasta', '40.00');
    expect(await balanceOf(w.walletId)).toBe('0.00');
    const entriesBefore = await ledgerCount(w.walletId);

    const res = await op(w, 'ROLLBACK', '40.00', { referenceExternalTransactionId: 'win-1' });

    expect(res.status).toBe(WagerTransactionStatus.Rejected);
    expect(res.failureCode).toBe(FailureCode.NegativeBalanceOnReversal);
    expect(await balanceOf(w.walletId)).toBe('0.00');
    expect(await ledgerCount(w.walletId)).toBe(entriesBefore);
    await assertLedgerInvariant(client, w.walletId);
  });

  it('ROLLBACK de REFUND → debita o valor reembolsado', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    await bet(w, 'bet-1');
    await op(w, 'REFUND', '25.00', { referenceExternalTransactionId: 'bet-1', externalTransactionId: 'refund-1' });
    const res = await op(w, 'ROLLBACK', '25.00', { referenceExternalTransactionId: 'refund-1' });

    expect(res.status).toBe(WagerTransactionStatus.Processed);
    expect(await balanceOf(w.walletId)).toBe('75.00');
    await assertLedgerInvariant(client, w.walletId);
  });

  it('ROLLBACK de LOSS → REFERENCE_TYPE_NOT_ALLOWED', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    await op(w, 'LOSS', '5.00', { externalTransactionId: 'loss-1' });
    const res = await op(w, 'ROLLBACK', '5.00', { referenceExternalTransactionId: 'loss-1' });
    expect(res.failureCode).toBe(FailureCode.ReferenceTypeNotAllowed);
  });

  it('dois ROLLBACKs da mesma BET → o segundo é REFERENCE_ALREADY_REVERSED', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    await bet(w, 'bet-1');
    await op(w, 'ROLLBACK', '25.00', { referenceExternalTransactionId: 'bet-1', externalTransactionId: 'rb-1' });
    const second = await op(w, 'ROLLBACK', '25.00', { referenceExternalTransactionId: 'bet-1', externalTransactionId: 'rb-2' });
    expect(second.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(await balanceOf(w.walletId)).toBe('100.00');
  });

  it('replay de REFUND devolve o resultado original sem novo crédito', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    await bet(w, 'bet-1');
    const refund = { referenceExternalTransactionId: 'bet-1', externalTransactionId: 'refund-r' };
    const first = await op(w, 'REFUND', '25.00', refund);
    const replay = await op(w, 'REFUND', '25.00', refund);

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(await balanceOf(w.walletId)).toBe('100.00');
    await assertLedgerInvariant(client, w.walletId);
  });

  it('o índice único parcial de reversões processadas existe no schema', async () => {
    const r = await client.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'wt_single_processed_reversal_uq'",
    );
    expect(r.rows[0]?.indexdef).toMatch(/CREATE UNIQUE INDEX.*reference_transaction_id.*WHERE/);
  });
});
