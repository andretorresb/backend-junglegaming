import { describe, expect, it } from 'bun:test';
import {
  InvalidInvariantError,
  InvalidMoneyError,
  InvalidReferenceTypeError,
  InvalidTransactionStateError,
  MissingReferenceError,
} from '../../../src/domain/errors';
import { FailureCode } from '../../../src/domain/failure-code';
import { LedgerDirection } from '../../../src/domain/ledger/ledger-direction';
import { Money } from '../../../src/domain/money/money';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateWagerTransactionProps,
} from '../../../src/domain/wagering/wager-transaction';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-07-29T15:00:00.000Z');

function make(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  return WagerTransaction.create({
    id: `tx-${Math.random().toString(36).slice(2)}`,
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    payloadHash: 'a'.repeat(64),
    walletId: 'w-1',
    playerId: 'p-1',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    createdAt: now,
    ...overrides,
  });
}

describe('WagerTransaction.create', () => {
  it('nasce em PENDING', () => {
    expect(make().status).toBe(WagerTransactionStatus.Pending);
  });

  it.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])('%s exige referenceExternalTransactionId', (kind) => {
    expect(() => make({ kind })).toThrow(MissingReferenceError);
    expect(() => make({ kind, referenceExternalTransactionId: '' })).toThrow(MissingReferenceError);
  });

  it('REFUND/ROLLBACK aceitam referência', () => {
    expect(make({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'transaction-1' }).requiresReference()).toBe(true);
  });

  it('BET, WIN e LOSS não aceitam referência', () => {
    expect(() => make({ kind: WagerTransactionKind.Bet, referenceExternalTransactionId: 'x' })).toThrow(InvalidMoneyError);
  });

  it('rejeita valor zero ou negativo', () => {
    expect(() => make({ money: brl('0') })).toThrow(InvalidMoneyError);
    expect(() => make({ money: brl('-5.00') })).toThrow(InvalidMoneyError);
  });

  it('rejeita campos de texto vazios', () => {
    expect(() => make({ roundId: '  ' })).toThrow(InvalidInvariantError);
    expect(() => make({ providerId: '' })).toThrow(InvalidInvariantError);
  });
});

describe('WagerTransaction — transições', () => {
  it('PENDING → PROCESSED', () => {
    const tx = make();
    tx.markProcessed(undefined, now);
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.processedAt).toEqual(now);
    expect(tx.isTerminal()).toBe(true);
  });

  it('PENDING → REJECTED com failureCode', () => {
    const tx = make();
    tx.reject(FailureCode.InsufficientBalance);
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientBalance);
    expect(tx.isTerminal()).toBe(true);
  });

  it('PENDING → FAILED é terminal', () => {
    const tx = make();
    tx.fail(FailureCode.InvalidPayload);
    expect(tx.status).toBe(WagerTransactionStatus.Failed);
    expect(tx.isTerminal()).toBe(true);
  });

  it('REFUND PENDING → PENDING_REFERENCE → PROCESSED com referência interna', () => {
    const tx = make({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'transaction-1' });
    tx.markPendingReference();
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.isTerminal()).toBe(false);
    tx.markProcessed('internal-bet-id', now);
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.referenceTransactionId).toBe('internal-bet-id');
  });

  it('PENDING_REFERENCE → REJECTED (esgotamento de referência)', () => {
    const tx = make({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'transaction-1' });
    tx.markPendingReference();
    tx.reject(FailureCode.ReferenceNotFound);
    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  it('apenas REFUND/ROLLBACK podem aguardar referência', () => {
    expect(() => make().markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  it('markProcessed de REFUND exige referência; de BET a proíbe', () => {
    const refund = make({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'transaction-1' });
    expect(() => refund.markProcessed(undefined, now)).toThrow(InvalidTransactionStateError);
    expect(() => make().markProcessed('x', now)).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransaction — terminais não transicionam', () => {
  const finishers: Array<[string, WagerTransactionStatus, (tx: WagerTransaction) => void]> = [
    ['PROCESSED', WagerTransactionStatus.Processed, (tx) => tx.markProcessed(undefined, now)],
    ['REJECTED', WagerTransactionStatus.Rejected, (tx) => tx.reject(FailureCode.InsufficientBalance)],
    ['FAILED', WagerTransactionStatus.Failed, (tx) => tx.fail(FailureCode.InvalidPayload)],
  ];

  for (const [label, expectedStatus, finish] of finishers) {
    it(`a partir de ${label}, nenhuma transição é aceita`, () => {
      const tx = make();
      finish(tx);
      expect(tx.status).toBe(expectedStatus);
      expect(() => tx.markProcessed(undefined, now)).toThrow(InvalidTransactionStateError);
      expect(() => tx.reject(FailureCode.InsufficientBalance)).toThrow(InvalidTransactionStateError);
      expect(() => tx.fail(FailureCode.InvalidPayload)).toThrow(InvalidTransactionStateError);
      expect(tx.status).toBe(expectedStatus);
    });
  }

  it('PENDING_REFERENCE não volta a PENDING_REFERENCE', () => {
    const tx = make({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'transaction-1' });
    tx.markPendingReference();
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransaction — consultas de domínio', () => {
  it('affectsBalance é falso apenas para LOSS', () => {
    expect(make({ kind: WagerTransactionKind.Loss }).affectsBalance()).toBe(false);
    expect(make({ kind: WagerTransactionKind.Bet }).affectsBalance()).toBe(true);
    expect(make({ kind: WagerTransactionKind.Win }).affectsBalance()).toBe(true);
  });

  it('matchesPayload compara o hash', () => {
    const tx = make({ payloadHash: 'b'.repeat(64) });
    expect(tx.matchesPayload('b'.repeat(64))).toBe(true);
    expect(tx.matchesPayload('c'.repeat(64))).toBe(false);
  });

  it('ledgerDirectionFor: BET debita, WIN e OPENING creditam', () => {
    expect(make({ kind: WagerTransactionKind.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(make({ kind: WagerTransactionKind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(make({ kind: WagerTransactionKind.Opening }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  it('ledgerDirectionFor: REFUND credita e só aceita BET como referência', () => {
    const refund = make({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'bet-1' });
    const bet = make({ kind: WagerTransactionKind.Bet });
    const win = make({ kind: WagerTransactionKind.Win });

    expect(refund.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(() => refund.ledgerDirectionFor(win)).toThrow(InvalidReferenceTypeError);
  });

  it('ledgerDirectionFor: ROLLBACK inverte a direção da referência', () => {
    const rollback = make({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'x' });
    expect(rollback.ledgerDirectionFor(make({ kind: WagerTransactionKind.Bet }))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(make({ kind: WagerTransactionKind.Win }))).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(make({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'b' }))).toBe(
      LedgerDirection.Debit,
    );
  });

  it('ledgerDirectionFor: ROLLBACK sem referência ou LOSS lança erro', () => {
    const rollback = make({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'x' });
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidInvariantError);
    expect(() => make({ kind: WagerTransactionKind.Loss }).ledgerDirectionFor()).toThrow();
  });
});

describe('WagerTransaction.rehydrate', () => {
  it('reconstrói estado terminal sem revalidar', () => {
    const tx = WagerTransaction.rehydrate({
      id: 'tx-1',
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      idempotencyKey: 'provider-a:transaction-123',
      payloadHash: 'a'.repeat(64),
      walletId: 'w-1',
      playerId: 'p-1',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
      createdAt: now,
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.InsufficientBalance,
    });
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientBalance);
    expect(() => tx.reject(FailureCode.InvalidPayload)).toThrow(InvalidTransactionStateError);
  });
});
