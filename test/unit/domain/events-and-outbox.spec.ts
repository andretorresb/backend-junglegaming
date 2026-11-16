import { describe, expect, it } from 'bun:test';
import { WagerTransactionProcessed, WagerTransactionRejected, WalletBalanceChanged, WagerTransactionPendingReference } from '../../../src/domain/events/wagering-events';
import { OutboxMessage, type OutboxRetryPolicy } from '../../../src/domain/outbox/outbox-message';
import { FailureCode } from '../../../src/domain/failure-code';

const at = new Date('2026-07-29T15:00:00.000Z');
const ctx = { eventId: 'e-1', correlationId: 'c-1', occurredAt: at };

describe('IntegrationEvent — envelope', () => {
  it('toJSON traz o envelope completo, com occurredAt em ISO-8601 e version', () => {
    const ev = WagerTransactionProcessed.from(
      { transactionId: 't', providerId: 'p', externalTransactionId: 'x', walletId: 'w', kind: 'BET', status: 'PROCESSED', balance: { amount: '75.00', currency: 'BRL' } },
      ctx,
    );
    expect(ev.toJSON()).toEqual({
      eventId: 'e-1',
      eventType: 'WagerTransactionProcessed',
      aggregateId: 't',
      correlationId: 'c-1',
      occurredAt: '2026-07-29T15:00:00.000Z',
      version: 1,
      data: { transactionId: 't', providerId: 'p', externalTransactionId: 'x', walletId: 'w', kind: 'BET', status: 'PROCESSED', balance: { amount: '75.00', currency: 'BRL' } },
    });
  });

  it('eventType e version pertencem ao tipo concreto', () => {
    expect(WagerTransactionRejected.from({ transactionId: 't', providerId: 'p', externalTransactionId: 'x', walletId: 'w', kind: 'BET', status: 'REJECTED', failureCode: FailureCode.InsufficientBalance, balance: { amount: '0.00', currency: 'BRL' } }, ctx).eventType).toBe('WagerTransactionRejected');
    expect(WalletBalanceChanged.from({ walletId: 'w', transactionId: 't', direction: 'CREDIT', money: { amount: '1.00', currency: 'BRL' }, balanceBefore: { amount: '0.00', currency: 'BRL' }, balanceAfter: { amount: '1.00', currency: 'BRL' }, walletVersion: 2 }, ctx).version).toBe(1);
    expect(WagerTransactionPendingReference.from({ transactionId: 't', providerId: 'p', referenceExternalTransactionId: 'b', walletId: 'w', nextAttemptAt: null }, ctx).aggregateId).toBe('t');
  });

  it('causationId só aparece quando informado', () => {
    const withCause = WalletBalanceChanged.from({ walletId: 'w', transactionId: 't', direction: 'DEBIT', money: { amount: '1.00', currency: 'BRL' }, balanceBefore: { amount: '2.00', currency: 'BRL' }, balanceAfter: { amount: '1.00', currency: 'BRL' }, walletVersion: 3 }, { ...ctx, causationId: 'cause-1' });
    expect(withCause.toJSON().causationId).toBe('cause-1');
    expect('causationId' in WalletBalanceChanged.from({ walletId: 'w', transactionId: 't', direction: 'DEBIT', money: { amount: '1.00', currency: 'BRL' }, balanceBefore: { amount: '2.00', currency: 'BRL' }, balanceAfter: { amount: '1.00', currency: 'BRL' }, walletVersion: 3 }, ctx).toJSON()).toBe(false);
  });
});

describe('OutboxMessage', () => {
  const event = () => WagerTransactionProcessed.from({ transactionId: 't', providerId: 'p', externalTransactionId: 'x', walletId: 'w', kind: 'LOSS', status: 'PROCESSED', balance: { amount: '1.00', currency: 'BRL' } }, ctx);
  const policy: OutboxRetryPolicy = { baseDelayMs: 1000, maxDelayMs: 8000 };

  it('enqueue nasce pendente, sem tentativas, e vencida', () => {
    const m = OutboxMessage.enqueue(event());
    expect(m.id).toBe('e-1');
    expect(m.isPending()).toBe(true);
    expect(m.attempts).toBe(0);
    expect(m.isDue(at)).toBe(true);
  });

  it('markPublished encerra a mensagem e não é mais vencida', () => {
    const m = OutboxMessage.enqueue(event());
    m.markPublished(at);
    expect(m.isPending()).toBe(false);
    expect(m.isDue(new Date(at.getTime() + 1e9))).toBe(false);
    expect(() => m.markPublished(at)).toThrow();
  });

  it('scheduleRetry aumenta tentativas e agenda com backoff exponencial limitado', () => {
    const m = OutboxMessage.enqueue(event());
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      m.scheduleRetry(at, policy);
      delays.push(m.nextAttemptAt!.getTime() - at.getTime());
    }
    expect(m.attempts).toBe(5);
    expect(delays).toEqual([1000, 2000, 4000, 8000, 8000]);
  });

  it('não é vencida antes de nextAttemptAt', () => {
    const m = OutboxMessage.enqueue(event());
    m.scheduleRetry(at, policy);
    expect(m.isDue(new Date(at.getTime() + 999))).toBe(false);
    expect(m.isDue(new Date(at.getTime() + 1000))).toBe(true);
  });
});
