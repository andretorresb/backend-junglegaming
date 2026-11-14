import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { Client } from 'pg';
import { createPgClient, createTestOrm, truncateAll } from '../helpers/database';
import { assertLedgerInvariant, command, countRows, fixedClock, seedWallet, useCase } from '../helpers/wagering';
import {
  IdempotencyConflictError,
  InternalOnlyKindError,
  WalletNotFoundError,
} from '../../../src/application/wagering/errors';
import { FailureCode } from '../../../src/domain/failure-code';
import { WagerTransactionStatus } from '../../../src/domain/wagering/wager-transaction';

describe('ProcessWagerTransaction — regras (BET, WIN, LOSS, replay e conflito)', () => {
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

  it('BET com saldo suficiente: PROCESSED, debita, 1 lançamento DEBIT, eventos Processed + BalanceChanged', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    const result = await useCase(em).execute(command({ walletId: w.walletId, playerId: w.playerId, amount: '25.00' }));

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(result.idempotentReplay).toBe(false);
    expect(await balanceOf(w.walletId)).toBe('75.00');
    expect(await countRows(client, "SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'", [w.walletId])).toBe(1);
    const events = await client.query<{ event_type: string }>('SELECT event_type FROM outbox_messages ORDER BY event_type');
    expect(events.rows.map((r) => r.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    await assertLedgerInvariant(client, w.walletId);
  });

  it('BET sem saldo: REJECTED com INSUFFICIENT_BALANCE, sem lançamento, saldo intacto, só evento Rejected', async () => {
    const w = await seedWallet(client, { balance: '10.00' });
    const result = await useCase(em).execute(command({ walletId: w.walletId, playerId: w.playerId, amount: '25.00' }));

    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.InsufficientBalance);
    expect(await balanceOf(w.walletId)).toBe('10.00');
    expect(await countRows(client, 'SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1', [w.walletId])).toBe(1);
    const events = await client.query<{ event_type: string }>('SELECT event_type FROM outbox_messages');
    expect(events.rows.map((r) => r.event_type)).toEqual(['WagerTransactionRejected']);
    await assertLedgerInvariant(client, w.walletId);
  });

  it('WIN: credita e gera lançamento CREDIT', async () => {
    const w = await seedWallet(client, { balance: '10.00' });
    const result = await useCase(em).execute(command({ walletId: w.walletId, playerId: w.playerId, kind: 'WIN', amount: '40.00' }));

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance.amount).toBe('50.00');
    expect(await countRows(client, "SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'CREDIT'", [w.walletId])).toBe(2);
    await assertLedgerInvariant(client, w.walletId);
  });

  it('LOSS: PROCESSED sem alterar saldo, sem lançamento, sem BalanceChanged', async () => {
    const w = await seedWallet(client, { balance: '50.00' });
    const result = await useCase(em).execute(command({ walletId: w.walletId, playerId: w.playerId, kind: 'LOSS', amount: '5.00' }));

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance.amount).toBe('50.00');
    expect(await balanceOf(w.walletId)).toBe('50.00');
    expect(await countRows(client, 'SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1', [w.walletId])).toBe(1);
    const events = await client.query<{ event_type: string }>('SELECT event_type FROM outbox_messages');
    expect(events.rows.map((r) => r.event_type)).toEqual(['WagerTransactionProcessed']);
  });

  it('replay idêntico devolve o resultado original e o saldo observado naquele momento', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    const bet = command({ walletId: w.walletId, playerId: w.playerId, amount: '25.00', externalTransactionId: 'bet-1' });
    const useCaseInstance = useCase(em);
    const first = await useCaseInstance.execute(bet);

    // saldo muda depois: WIN de 10
    await useCaseInstance.execute(command({ walletId: w.walletId, playerId: w.playerId, kind: 'WIN', amount: '10.00' }));
    expect(await balanceOf(w.walletId)).toBe('85.00');

    const replay = await useCaseInstance.execute(bet);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.status).toBe(WagerTransactionStatus.Processed);
    expect(replay.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(await countRows(client, "SELECT id FROM wager_transactions WHERE external_transaction_id = 'bet-1'")).toBe(1);
    await assertLedgerInvariant(client, w.walletId);
  });

  it('replay de transação rejeitada devolve a rejeição original sem novo lançamento', async () => {
    const w = await seedWallet(client, { balance: '0.00' });
    const bet = command({ walletId: w.walletId, playerId: w.playerId, amount: '5.00', externalTransactionId: 'bet-r' });
    const useCaseInstance = useCase(em);
    await useCaseInstance.execute(bet);
    const replay = await useCaseInstance.execute(bet);

    expect(replay.status).toBe(WagerTransactionStatus.Rejected);
    expect(replay.failureCode).toBe(FailureCode.InsufficientBalance);
    expect(replay.idempotentReplay).toBe(true);
  });

  it('mesma Idempotency-Key com payload diferente: conflito, nada persistido', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    const useCaseInstance = useCase(em);
    const original = command({ walletId: w.walletId, playerId: w.playerId, amount: '25.00', externalTransactionId: 'k-1' });
    await useCaseInstance.execute(original);

    await expect(
      useCaseInstance.execute({ ...original, money: { amount: '30.00', currency: 'BRL' }, correlationId: randomUUID() }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    expect(await balanceOf(w.walletId)).toBe('75.00');
    expect(await countRows(client, "SELECT id FROM wager_transactions WHERE external_transaction_id = 'k-1'")).toBe(1);
  });

  it('mesma transação do provedor com outra chave: conflito', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    const useCaseInstance = useCase(em);
    await useCaseInstance.execute(command({ walletId: w.walletId, playerId: w.playerId, amount: '1.00', externalTransactionId: 'same' }));

    await expect(
      useCaseInstance.execute({ ...command({ walletId: w.walletId, playerId: w.playerId, amount: '1.00', externalTransactionId: 'same' }), idempotencyKey: 'outra-chave' }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('OPENING é interno: recusado sem persistir', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    await expect(
      useCase(em).execute(command({ walletId: w.walletId, playerId: w.playerId, kind: 'OPENING', amount: '1.00' })),
    ).rejects.toBeInstanceOf(InternalOnlyKindError);
  });

  it('moeda diferente da wallet: rejeitado antes de persistir, com CURRENCY_MISMATCH', async () => {
    const w = await seedWallet(client, { balance: '100.00', currency: 'BRL' });
    await expect(
      useCase(em).execute(command({ walletId: w.walletId, playerId: w.playerId, amount: '1.00', currency: 'USD' })),
    ).rejects.toMatchObject({ failureCode: FailureCode.CurrencyMismatch });
    expect(await countRows(client, "SELECT id FROM wager_transactions WHERE wallet_id = $1 AND kind <> 'OPENING'", [w.walletId])).toBe(0);
  });

  it('playerId diferente do dono da wallet: rejeitado antes de persistir, com PLAYER_MISMATCH', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    await expect(
      useCase(em).execute(command({ walletId: w.walletId, playerId: randomUUID(), amount: '1.00' })),
    ).rejects.toMatchObject({ failureCode: FailureCode.PlayerMismatch });
    expect(await countRows(client, "SELECT id FROM wager_transactions WHERE wallet_id = $1 AND kind <> 'OPENING'", [w.walletId])).toBe(0);
  });

  it('wallet inexistente: WalletNotFoundError', async () => {
    await expect(
      useCase(em).execute(command({ walletId: randomUUID(), playerId: randomUUID(), amount: '1.00' })),
    ).rejects.toBeInstanceOf(WalletNotFoundError);
  });

  it('valor inválido (3 casas) é rejeitado pelo Money antes de qualquer escrita', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    await expect(
      useCase(em).execute(command({ walletId: w.walletId, playerId: w.playerId, amount: '1.005' })),
    ).rejects.toMatchObject({ failureCode: FailureCode.InvalidPayload });
    expect(await countRows(client, "SELECT id FROM wager_transactions WHERE wallet_id = $1 AND kind <> 'OPENING'", [w.walletId])).toBe(0);
  });

  it('o relógio é injetado: created_at vem do Clock, não de new Date()', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    const at = new Date('2001-02-03T04:05:06.000Z');
    await useCase(em, fixedClock(at)).execute(command({ walletId: w.walletId, playerId: w.playerId, amount: '1.00', externalTransactionId: 'clock' }));
    const row = await client.query<{ created_at: Date }>("SELECT created_at FROM wager_transactions WHERE external_transaction_id = 'clock'");
    expect(row.rows[0]?.created_at.toISOString()).toBe(at.toISOString());
  });
});
