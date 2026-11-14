import { LedgerDirection } from '../../domain/ledger/ledger-direction';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { Wallet } from '../../domain/wallet/wallet';
import { WagerTransaction, type WagerTransactionKind, type WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import { FailureCode } from '../../domain/failure-code';
import type { WalletLedgerEntryRecord, WagerTransactionRecord, WalletRecord } from './entities/records';

/**
 * Mapeadores entre registros de persistência e agregados de domínio.
 * - `fromRecord` usa a factory `rehydrate` (não revalida transições).
 * - `toRecord` é usado para inserir/atualizar; a aplicação decide quando gravar.
 */

export function walletFromRecord(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: { amount: record.balance, currency: record.currency },
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function walletToRecord(wallet: Wallet): WalletRecord {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toJSON().amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

export function ledgerEntryFromRecord(record: WalletLedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    direction: record.direction as LedgerDirection,
    money: { amount: record.amount, currency: record.currency },
    balanceBefore: { amount: record.balanceBefore, currency: record.currency },
    balanceAfter: { amount: record.balanceAfter, currency: record.currency },
    createdAt: record.createdAt,
  });
}

export function ledgerEntryToRecord(entry: WalletLedgerEntry): WalletLedgerEntryRecord {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.toJSON().amount,
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.toJSON().amount,
    balanceAfter: entry.balanceAfter.toJSON().amount,
    createdAt: entry.createdAt,
  };
}

export function wagerTransactionFromRecord(record: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash.trimEnd(),
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind as WagerTransactionKind,
    money: { amount: record.amount, currency: record.currency },
    referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
    createdAt: record.createdAt,
    status: record.status as WagerTransactionStatus,
    referenceTransactionId: record.referenceTransactionId ?? undefined,
    failureCode: (record.failureCode ?? undefined) as FailureCode | undefined,
    processedAt: record.processedAt ?? undefined,
    observedBalance:
      record.balanceObserved === null ? undefined : { amount: record.balanceObserved, currency: record.currency },
  });
}

export function wagerTransactionToRecord(tx: WagerTransaction): WagerTransactionRecord {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    amount: tx.money.toJSON().amount,
    currency: tx.money.currency,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    createdAt: tx.createdAt,
    processedAt: tx.processedAt ?? null,
    balanceObserved: tx.observedBalance?.toJSON().amount ?? null,
  };
}

