import type { MoneyProps } from '../money/money';
import { IntegrationEvent, type EventContext } from './integration-event';

/** Qualquer transação aplicada, inclusive LOSS. */
export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  status: 'PROCESSED';
  balance: MoneyProps;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(data: WagerTransactionProcessedData, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({ ...ctx, aggregateId: data.transactionId, data });
  }
}

/** Transação rejeitada por regra de negócio. */
export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  status: 'REJECTED';
  failureCode: string;
  balance: MoneyProps;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(data: WagerTransactionRejectedData, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({ ...ctx, aggregateId: data.transactionId, data });
  }
}

/** Saldo mudou. Emitido somente quando há movimentação de saldo. */
export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: 'DEBIT' | 'CREDIT';
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(data: WalletBalanceChangedData, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({ ...ctx, aggregateId: data.walletId, data });
  }
}

/** Referência ausente: a transação aguarda o reprocessamento. */
export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  referenceExternalTransactionId: string;
  walletId: string;
  nextAttemptAt: string | null;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(data: WagerTransactionPendingReferenceData, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({ ...ctx, aggregateId: data.transactionId, data });
  }
}
