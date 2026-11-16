import { InvalidInvariantError } from '../../domain/errors';
import type { MoneyProps } from '../../domain/money/money';
import type { EventContext } from '../../domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/events/wagering-events';
import type { WalletMovement } from '../../domain/wallet/wallet';
import { WagerTransactionStatus, type WagerTransaction } from '../../domain/wagering/wager-transaction';

/** Contexto comum: id do evento vem do gerador injetado; correlação vem do comando. */
export function eventContext(
  nextId: () => string,
  correlationId: string,
  occurredAt: Date,
  causationId?: string,
): EventContext {
  return { eventId: nextId(), correlationId, occurredAt, causationId };
}

export function balanceChangedEvent(
  movement: WalletMovement,
  walletId: string,
  transactionId: string,
  ctx: EventContext,
): WalletBalanceChanged {
  return WalletBalanceChanged.from(
    {
      walletId,
      transactionId,
      direction: movement.direction,
      money: movement.money.toJSON(),
      balanceBefore: movement.balanceBefore.toJSON(),
      balanceAfter: movement.balanceAfter.toJSON(),
      walletVersion: movement.walletVersion,
    },
    ctx,
  );
}

/** Evento de desfecho de uma transação aplicada (inclusive LOSS) ou rejeitada. */
export function outcomeEvent(
  tx: WagerTransaction,
  balance: MoneyProps,
  ctx: EventContext,
): WagerTransactionProcessed | WagerTransactionRejected {
  const base = {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    kind: tx.kind,
    balance,
  };
  if (tx.status === WagerTransactionStatus.Processed) {
    return WagerTransactionProcessed.from({ ...base, status: 'PROCESSED' }, ctx);
  }
  if (tx.status === WagerTransactionStatus.Rejected) {
    if (tx.failureCode === undefined) {
      throw new InvalidInvariantError(`transação rejeitada ${tx.id} sem failureCode`);
    }
    return WagerTransactionRejected.from({ ...base, status: 'REJECTED', failureCode: tx.failureCode }, ctx);
  }
  throw new InvalidInvariantError(`evento de desfecho para status ${tx.status} não existe`);
}

export function pendingReferenceEvent(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
  if (tx.referenceExternalTransactionId === undefined) {
    throw new InvalidInvariantError(`transação ${tx.id} aguardando referência sem referenceExternalTransactionId`);
  }
  return WagerTransactionPendingReference.from(
    {
      transactionId: tx.id,
      providerId: tx.providerId,
      referenceExternalTransactionId: tx.referenceExternalTransactionId,
      walletId: tx.walletId,
      nextAttemptAt: tx.nextReferenceAttemptAt?.toISOString() ?? null,
    },
    ctx,
  );
}
