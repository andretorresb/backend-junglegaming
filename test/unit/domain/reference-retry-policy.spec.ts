import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_REFERENCE_RETRY_POLICY,
  isReferenceWaitExhausted,
  nextAttemptDelayMs,
  type ReferenceRetryPolicy,
} from '../../../src/domain/wagering/reference-retry-policy';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../src/domain/wagering/wager-transaction';
import { Money } from '../../../src/domain/money/money';
import { FailureCode } from '../../../src/domain/failure-code';

const policy: ReferenceRetryPolicy = { baseDelayMs: 1000, maxDelayMs: 8000, maxAttempts: 3, ttlMs: 60_000 };
const arrived = new Date('2026-07-29T15:00:00.000Z');

describe('nextAttemptDelayMs — backoff exponencial com teto e jitter', () => {
  it('cresce exponencialmente com jitter máximo', () => {
    expect([0, 1, 2, 3].map((a) => nextAttemptDelayMs(a, policy, 1))).toEqual([1000, 2000, 4000, 8000]);
  });

  it('respeita o teto', () => {
    expect(nextAttemptDelayMs(10, policy, 1)).toBe(8000);
  });

  it('jitter 0 devolve metade do atraso; jitter fora de [0,1] é limitado', () => {
    expect(nextAttemptDelayMs(2, policy, 0)).toBe(2000);
    expect(nextAttemptDelayMs(2, policy, 5)).toBe(4000);
    expect(nextAttemptDelayMs(2, policy, -5)).toBe(2000);
  });

  it('o padrão tem teto de 5 min e limite de 10 tentativas', () => {
    expect(nextAttemptDelayMs(50, DEFAULT_REFERENCE_RETRY_POLICY, 1)).toBe(300_000);
    expect(DEFAULT_REFERENCE_RETRY_POLICY.maxAttempts).toBe(10);
  });
});

describe('isReferenceWaitExhausted', () => {
  it('esgota pelo número de tentativas', () => {
    expect(isReferenceWaitExhausted(2, arrived, arrived, policy)).toBe(false);
    expect(isReferenceWaitExhausted(3, arrived, arrived, policy)).toBe(true);
  });

  it('esgota pelo TTL, mesmo com tentativas sobrando', () => {
    const later = new Date(arrived.getTime() + 60_000);
    expect(isReferenceWaitExhausted(0, arrived, later, policy)).toBe(true);
    expect(isReferenceWaitExhausted(0, arrived, new Date(later.getTime() - 1), policy)).toBe(false);
  });
});

describe('WagerTransaction — agendamento de referência pendente', () => {
  function pendingRollback(): WagerTransaction {
    const tx = WagerTransaction.create({
      id: 'rb',
      providerId: 'provider-a',
      externalTransactionId: 'rb-1',
      idempotencyKey: 'k',
      payloadHash: 'a'.repeat(64),
      walletId: 'w',
      playerId: 'p',
      roundId: 'r',
      gameId: 'g',
      kind: WagerTransactionKind.Rollback,
      money: Money.from({ amount: '5.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'bet-1',
      createdAt: arrived,
    });
    tx.markPendingReference(new Date(arrived.getTime() + 1000));
    return tx;
  }

  it('markPendingReference zera as tentativas e agenda a primeira', () => {
    const tx = pendingRollback();
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.referenceAttempts).toBe(0);
    expect(tx.nextReferenceAttemptAt?.getTime()).toBe(arrived.getTime() + 1000);
  });

  it('incrementReferenceAttempts e rescheduleReference atualizam o agendamento', () => {
    const tx = pendingRollback();
    tx.incrementReferenceAttempts();
    tx.rescheduleReference(new Date(arrived.getTime() + 5000));
    expect(tx.referenceAttempts).toBe(1);
    expect(tx.nextReferenceAttemptAt?.getTime()).toBe(arrived.getTime() + 5000);
  });

  it('operações de agendamento só valem em PENDING_REFERENCE', () => {
    const bet = WagerTransaction.create({
      id: 'b', providerId: 'p', externalTransactionId: 'e', idempotencyKey: 'k', payloadHash: 'a'.repeat(64),
      walletId: 'w', playerId: 'p', roundId: 'r', gameId: 'g', kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '1.00', currency: 'BRL' }), createdAt: arrived,
    });
    expect(() => bet.incrementReferenceAttempts()).toThrow();
    expect(() => bet.rescheduleReference(arrived)).toThrow();
  });

  it('transição para terminal limpa o agendamento', () => {
    const tx = pendingRollback();
    tx.reject(FailureCode.ReferenceNotFound);
    expect(tx.nextReferenceAttemptAt).toBeUndefined();
  });
});
