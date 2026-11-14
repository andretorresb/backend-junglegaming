import { describe, expect, it } from 'bun:test';
import { FailureCode } from '../../../src/domain/failure-code';
import { Money } from '../../../src/domain/money/money';
import { validateReversalReference } from '../../../src/domain/wagering/reversal-rules';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerTransactionKind as Kind,
} from '../../../src/domain/wagering/wager-transaction';

const now = new Date('2026-07-29T15:00:00.000Z');
const ctx = { providerId: 'provider-a', playerId: 'p-1', walletId: 'w-1', roundId: 'r-1' };

function tx(kind: Kind, overrides: Partial<{ amount: string; status: WagerTransactionStatus; playerId: string; walletId: string; roundId: string; providerId: string }> = {}) {
  const needsRef = kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
  const base = WagerTransaction.create({
    id: `${kind}-${Math.random().toString(36).slice(2, 8)}`,
    providerId: overrides.providerId ?? ctx.providerId,
    externalTransactionId: `ext-${kind}-${Math.random().toString(36).slice(2, 8)}`,
    idempotencyKey: `k-${Math.random().toString(36).slice(2)}`,
    payloadHash: 'a'.repeat(64),
    walletId: overrides.walletId ?? ctx.walletId,
    playerId: overrides.playerId ?? ctx.playerId,
    roundId: overrides.roundId ?? ctx.roundId,
    gameId: 'g',
    kind,
    money: Money.from({ amount: overrides.amount ?? '25.00', currency: 'BRL' }),
    referenceExternalTransactionId: needsRef ? 'ref' : undefined,
    createdAt: now,
  });
  if (overrides.status === WagerTransactionStatus.Processed) {
    base.markProcessed(needsRef ? 'ref-id' : undefined, now);
  }
  return base;
}

const reversalOf = (kind: Kind, amount = '25.00') => tx(kind, { amount });

describe('validateReversalReference — matriz de regras', () => {
  it('referência ausente → REFERENCE_NOT_FOUND', () => {
    expect(validateReversalReference(reversalOf(WagerTransactionKind.Refund), undefined, false)).toBe(FailureCode.ReferenceNotFound);
  });

  it('contexto divergente (jogador, wallet, rodada, provedor) → REFERENCE_CONTEXT_MISMATCH', () => {
    const bet = tx(WagerTransactionKind.Bet, { status: WagerTransactionStatus.Processed });
    expect(validateReversalReference(reversalOf(WagerTransactionKind.Refund), tx(WagerTransactionKind.Bet, { status: WagerTransactionStatus.Processed, playerId: 'outro' }), false)).toBe(FailureCode.ReferenceContextMismatch);
    expect(validateReversalReference(reversalOf(WagerTransactionKind.Refund), tx(WagerTransactionKind.Bet, { status: WagerTransactionStatus.Processed, walletId: 'w-2' }), false)).toBe(FailureCode.ReferenceContextMismatch);
    expect(validateReversalReference(reversalOf(WagerTransactionKind.Refund), tx(WagerTransactionKind.Bet, { status: WagerTransactionStatus.Processed, roundId: 'r-2' }), false)).toBe(FailureCode.ReferenceContextMismatch);
    expect(validateReversalReference(reversalOf(WagerTransactionKind.Refund), tx(WagerTransactionKind.Bet, { status: WagerTransactionStatus.Processed, providerId: 'provider-b' }), false)).toBe(FailureCode.ReferenceContextMismatch);
    expect(bet.kind).toBe(WagerTransactionKind.Bet);
  });

  it('REFUND de WIN → REFERENCE_TYPE_NOT_ALLOWED; REFUND de BET é permitido', () => {
    const win = tx(WagerTransactionKind.Win, { status: WagerTransactionStatus.Processed });
    const bet = tx(WagerTransactionKind.Bet, { status: WagerTransactionStatus.Processed });
    expect(validateReversalReference(reversalOf(WagerTransactionKind.Refund), win, false)).toBe(FailureCode.ReferenceTypeNotAllowed);
    expect(validateReversalReference(reversalOf(WagerTransactionKind.Refund), bet, false)).toBeUndefined();
  });

  it('ROLLBACK aceita BET, WIN e REFUND; rejeita LOSS', () => {
    const rb = () => reversalOf(WagerTransactionKind.Rollback);
    expect(validateReversalReference(rb(), tx(WagerTransactionKind.Bet, { status: WagerTransactionStatus.Processed }), false)).toBeUndefined();
    expect(validateReversalReference(rb(), tx(WagerTransactionKind.Win, { status: WagerTransactionStatus.Processed }), false)).toBeUndefined();
    expect(validateReversalReference(rb(), tx(WagerTransactionKind.Refund, { status: WagerTransactionStatus.Processed }), false)).toBeUndefined();
    expect(validateReversalReference(rb(), tx(WagerTransactionKind.Loss, { status: WagerTransactionStatus.Processed }), false)).toBe(FailureCode.ReferenceTypeNotAllowed);
  });

  it('referência não PROCESSED (ex.: REJECTED) → REFERENCE_NOT_PROCESSED', () => {
    const rejected = tx(WagerTransactionKind.Bet);
    rejected.reject(FailureCode.InsufficientBalance);
    expect(validateReversalReference(reversalOf(WagerTransactionKind.Refund), rejected, false)).toBe(FailureCode.ReferenceNotProcessed);
  });

  it('referência já revertida → REFERENCE_ALREADY_REVERSED', () => {
    const bet = tx(WagerTransactionKind.Bet, { status: WagerTransactionStatus.Processed });
    expect(validateReversalReference(reversalOf(WagerTransactionKind.Refund), bet, true)).toBe(FailureCode.ReferenceAlreadyReversed);
  });

  it('valor diferente da referência → AMOUNT_MISMATCH_ON_REVERSAL', () => {
    const bet = tx(WagerTransactionKind.Bet, { status: WagerTransactionStatus.Processed, amount: '25.00' });
    expect(validateReversalReference(reversalOf(WagerTransactionKind.Refund, '24.99'), bet, false)).toBe(FailureCode.AmountMismatchOnReversal);
  });

  it('caso válido → undefined', () => {
    const bet = tx(WagerTransactionKind.Bet, { status: WagerTransactionStatus.Processed });
    expect(validateReversalReference(reversalOf(WagerTransactionKind.Rollback), bet, false)).toBeUndefined();
  });
});
