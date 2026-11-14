import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Client } from 'pg';
import { Money } from '../../../src/domain/money/money';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { WalletLedgerEntry } from '../../../src/domain/wallet/wallet-ledger-entry';
import { LedgerDirection } from '../../../src/domain/ledger/ledger-direction';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../../src/domain/wagering/wager-transaction';
import { FailureCode } from '../../../src/domain/failure-code';
import {
  ledgerEntryFromRecord,
  ledgerEntryToRecord,
  wagerTransactionFromRecord,
  wagerTransactionToRecord,
  walletFromRecord,
  walletToRecord,
} from '../../../src/infrastructure/persistence/mappers';
import {
  WalletLedgerEntryRecord,
  WagerTransactionRecord,
  WalletRecord,
} from '../../../src/infrastructure/persistence/entities/records';
import { createPgClient, createTestOrm, truncateAll } from '../helpers/database';

/**
 * Round-trip domínio ↔ banco ↔ domínio, usando o ORM de verdade (sem mocks).
 * Prova que o Money não perde precisão ao passar pelo numeric(19,2).
 */

const now = new Date('2026-07-29T15:00:00.000Z');

describe('Mapeamento — round-trip com PostgreSQL real', () => {
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

  it('wallet: saldo com valor grande e centavos sobrevive ao round-trip exato', async () => {
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: randomUUID(),
      initialBalance: Money.from({ amount: '1234567890123.45', currency: 'BRL' }),
      at: now,
    });

    const em = orm.em.fork();
    await em.insert(WalletRecord, walletToRecord(wallet));
    em.clear();

    const stored = await em.findOneOrFail(WalletRecord, wallet.id);
    const restored = walletFromRecord(stored);

    expect(restored.balance.toJSON()).toEqual({ amount: '1234567890123.45', currency: 'BRL' });
    expect(restored.version).toBe(1);
    expect(restored.balance.equals(wallet.balance)).toBe(true);
  });

  it('wallet: movimentações persistidas via update mantêm versão e saldo', async () => {
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: randomUUID(),
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      at: now,
    });
    const em = orm.em.fork();
    await em.insert(WalletRecord, walletToRecord(wallet));

    wallet.debit(Money.from({ amount: '80.00', currency: 'BRL' }), now);
    await em.nativeUpdate(WalletRecord, { id: wallet.id }, { balance: wallet.balance.toJSON().amount, version: wallet.version });
    em.clear();

    const restored = walletFromRecord(await em.findOneOrFail(WalletRecord, wallet.id));
    expect(restored.balance.toJSON().amount).toBe('20.00');
    expect(restored.version).toBe(2);
  });

  it('transação: estado PENDING → PROCESSED persistido e reidratado', async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const em = orm.em.fork();
    await em.insert(WalletRecord, walletToRecord(Wallet.open({
      id: walletId,
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      at: now,
    })));

    const tx = WagerTransaction.create({
      id: randomUUID(),
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      idempotencyKey: 'provider-a:transaction-123',
      payloadHash: 'f'.repeat(64),
      walletId,
      playerId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      createdAt: now,
    });
    await em.insert(WagerTransactionRecord, wagerTransactionToRecord(tx));

    tx.markProcessed(undefined, now);
    await em.nativeUpdate(
      WagerTransactionRecord,
      { id: tx.id },
      { status: tx.status, processedAt: tx.processedAt ?? null },
    );
    em.clear();

    const restored = wagerTransactionFromRecord(await em.findOneOrFail(WagerTransactionRecord, tx.id));
    expect(restored.status).toBe(WagerTransactionStatus.Processed);
    expect(restored.money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(restored.payloadHash).toBe('f'.repeat(64));
    expect(restored.processedAt?.toISOString()).toBe(now.toISOString());
  });

  it('transação REJECTED com failureCode e referência sobrevivem ao round-trip', async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const em = orm.em.fork();
    await em.insert(WalletRecord, walletToRecord(Wallet.open({
      id: walletId,
      playerId,
      initialBalance: Money.from({ amount: '0.00', currency: 'BRL' }),
      at: now,
    })));

    const bet = WagerTransaction.create({
      id: randomUUID(),
      providerId: 'provider-a',
      externalTransactionId: 'bet-1',
      idempotencyKey: 'provider-a:bet-1',
      payloadHash: 'a'.repeat(64),
      walletId,
      playerId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      createdAt: now,
    });
    bet.reject(FailureCode.InsufficientBalance);
    await em.insert(WagerTransactionRecord, wagerTransactionToRecord(bet));
    em.clear();

    const restored = wagerTransactionFromRecord(await em.findOneOrFail(WagerTransactionRecord, bet.id));
    expect(restored.status).toBe(WagerTransactionStatus.Rejected);
    expect(restored.failureCode).toBe(FailureCode.InsufficientBalance);
    expect(restored.referenceExternalTransactionId).toBeUndefined();
    expect(restored.processedAt).toBeUndefined();
  });

  it('ledger: lançamento criado pelo domínio é gravado, reidratado e continua balanceado', async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const wallet = Wallet.open({
      id: walletId,
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      at: now,
    });
    const em = orm.em.fork();
    await em.insert(WalletRecord, walletToRecord(wallet));

    const tx = WagerTransaction.create({
      id: randomUUID(),
      providerId: 'provider-a',
      externalTransactionId: 'bet-ledger',
      idempotencyKey: 'provider-a:bet-ledger',
      payloadHash: 'b'.repeat(64),
      walletId,
      playerId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      createdAt: now,
    });
    await em.insert(WagerTransactionRecord, wagerTransactionToRecord(tx));

    const movement = wallet.debit(tx.money, now);
    const entry = WalletLedgerEntry.create({
      id: randomUUID(),
      walletId,
      transactionId: tx.id,
      direction: LedgerDirection.Debit,
      money: movement.money,
      balanceBefore: movement.balanceBefore,
      balanceAfter: movement.balanceAfter,
      createdAt: now,
    });
    await em.insert(WalletLedgerEntryRecord, ledgerEntryToRecord(entry));
    em.clear();

    const restored = ledgerEntryFromRecord(await em.findOneOrFail(WalletLedgerEntryRecord, entry.id));
    expect(restored.direction).toBe(LedgerDirection.Debit);
    expect(restored.money.toJSON().amount).toBe('25.00');
    expect(restored.balanceAfter.toJSON().amount).toBe('75.00');
    expect(restored.isBalanced()).toBe(true);
  });
});
