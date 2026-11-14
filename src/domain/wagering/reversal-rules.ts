import { FailureCode } from '../failure-code';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerTransaction,
} from './wager-transaction';

/**
 * Validação da referência de REFUND e ROLLBACK (seção 7, regras 1 a 5 e 9 do enunciado).
 *
 * Função pura: recebe a transação de reversão, a referência já resolvida (ou `undefined`)
 * e se a referência já foi revertida por uma operação processada. Retorna o motivo da
 * rejeição, ou `undefined` quando a reversão pode ser aplicada.
 *
 * A ausência da referência é tratada aqui como REFERENCE_NOT_FOUND nesta etapa.
 * A Etapa 5 troca esse caso por PENDING_REFERENCE.
 */
export function validateReversalReference(
  reversal: WagerTransaction,
  reference: WagerTransaction | undefined,
  alreadyReversed: boolean,
): FailureCode | undefined {
  if (reference === undefined) {
    return FailureCode.ReferenceNotFound;
  }

  if (
    reference.playerId !== reversal.playerId ||
    reference.walletId !== reversal.walletId ||
    reference.roundId !== reversal.roundId ||
    reference.providerId !== reversal.providerId ||
    reference.money.currency !== reversal.money.currency
  ) {
    return FailureCode.ReferenceContextMismatch;
  }

  if (!allowedReferenceKinds(reversal.kind).includes(reference.kind)) {
    return FailureCode.ReferenceTypeNotAllowed;
  }

  if (reference.status !== WagerTransactionStatus.Processed) {
    return FailureCode.ReferenceNotProcessed;
  }

  if (alreadyReversed) {
    return FailureCode.ReferenceAlreadyReversed;
  }

  if (!reference.money.equals(reversal.money)) {
    return FailureCode.AmountMismatchOnReversal;
  }

  return undefined;
}

/** REFUND referencia apenas BET; ROLLBACK referencia BET, WIN ou REFUND. */
export function allowedReferenceKinds(kind: WagerTransactionKind): WagerTransactionKind[] {
  switch (kind) {
    case WagerTransactionKind.Refund:
      return [WagerTransactionKind.Bet];
    case WagerTransactionKind.Rollback:
      return [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund];
    default:
      return [];
  }
}
