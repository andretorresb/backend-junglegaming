import { InsufficientBalanceError } from '../../domain/errors';
import { FailureCode } from '../../domain/failure-code';
import { LedgerDirection } from '../../domain/ledger/ledger-direction';
import type { Wallet, WalletMovement } from '../../domain/wallet/wallet';
import { validateReversalReference } from '../../domain/wagering/reversal-rules';
import { WagerTransactionStatus, type WagerTransaction } from '../../domain/wagering/wager-transaction';

/**
 * Regra de REFUND e ROLLBACK, compartilhada entre o caso de uso (chegada da reversão)
 * e o worker de referências pendentes (Etapa 5). Uma única implementação, um único comportamento.
 */

/** Referência já resolvida e se ela já foi revertida por uma operação processada. */
export interface ReversalContext {
  reference: WagerTransaction | undefined;
  alreadyReversed: boolean;
}

export function applyReversal(
  tx: WagerTransaction,
  wallet: Wallet,
  now: Date,
  { reference, alreadyReversed }: ReversalContext,
): WalletMovement | undefined {
  const rejection = validateReversalReference(tx, reference, alreadyReversed);
  if (rejection !== undefined || reference === undefined) {
    tx.reject(rejection ?? FailureCode.ReferenceNotFound, wallet.balance);
    return undefined;
  }

  const direction = tx.ledgerDirectionFor(reference);
  if (direction === LedgerDirection.Credit) {
    const movement = wallet.credit(tx.money, now);
    tx.markProcessed(reference.id, now, wallet.balance);
    return movement;
  }

  // Reversão que debitaria: se o saldo não cobre, é rejeitada com código próprio (regra 9).
  try {
    const movement = wallet.debit(tx.money, now);
    tx.markProcessed(reference.id, now, wallet.balance);
    return movement;
  } catch (error) {
    if (!(error instanceof InsufficientBalanceError)) throw error;
    tx.reject(FailureCode.NegativeBalanceOnReversal, wallet.balance);
    return undefined;
  }
}

/**
 * Referência ainda aguardando a própria referência (ex.: ROLLBACK de um REFUND pendente).
 * Nesse caso a reversão também aguarda, em vez de ser rejeitada como NOT_PROCESSED.
 */
export function isWaitingForReference(reference: WagerTransaction): boolean {
  return reference.status === WagerTransactionStatus.PendingReference;
}
