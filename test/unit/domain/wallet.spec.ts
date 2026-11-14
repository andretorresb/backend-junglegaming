import { describe, expect, it } from 'bun:test';
import { InsufficientBalanceError, InvalidInvariantError, InvalidMoneyError } from '../../../src/domain/errors';
import { LedgerDirection } from '../../../src/domain/ledger/ledger-direction';
import { Money } from '../../../src/domain/money/money';
import { Wallet } from '../../../src/domain/wallet/wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-07-29T15:00:00.000Z');
const later = new Date('2026-07-29T15:00:01.000Z');

function openWallet(initial = '100.00'): Wallet {
  return Wallet.open({ id: 'w-1', playerId: 'p-1', initialBalance: brl(initial), at });
}

describe('Wallet.open', () => {
  it('versão inicia em 1 e saldo é o inicial', () => {
    const w = openWallet('100.00');
    expect(w.version).toBe(1);
    expect(w.balance.toJSON().amount).toBe('100.00');
    expect(w.currency).toBe('BRL');
  });

  it('aceita saldo inicial zero', () => {
    expect(openWallet('0').balance.isZero()).toBe(true);
  });

  it('rejeita saldo inicial negativo', () => {
    expect(() =>
      Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('-1.00'), at }),
    ).toThrow(InvalidMoneyError);
  });

  it('rejeita id ou playerId vazio', () => {
    expect(() => Wallet.open({ id: ' ', playerId: 'p', initialBalance: brl('1'), at })).toThrow(InvalidInvariantError);
    expect(() => Wallet.open({ id: 'w', playerId: '', initialBalance: brl('1'), at })).toThrow(InvalidInvariantError);
  });
});

describe('Wallet.debit', () => {
  it('debita, incrementa versão e retorna a movimentação', () => {
    const w = openWallet('100.00');
    const movement = w.debit(brl('25.00'), later);

    expect(movement.direction).toBe(LedgerDirection.Debit);
    expect(movement.balanceBefore.toJSON().amount).toBe('100.00');
    expect(movement.balanceAfter.toJSON().amount).toBe('75.00');
    expect(movement.walletVersion).toBe(2);
    expect(w.balance.toJSON().amount).toBe('75.00');
    expect(w.updatedAt).toEqual(later);
  });

  it('permite debitar exatamente o saldo até zero', () => {
    const w = openWallet('80.00');
    w.debit(brl('80.00'), later);
    expect(w.balance.isZero()).toBe(true);
  });

  it('rejeita débito maior que o saldo, sem alterar estado', () => {
    const w = openWallet('79.99');
    expect(() => w.debit(brl('80.00'), later)).toThrow(InsufficientBalanceError);
    expect(w.balance.toJSON().amount).toBe('79.99');
    expect(w.version).toBe(1);
  });

  it('rejeita débito de valor zero (movimentação sem efeito não é aceita)', () => {
    const w = openWallet();
    expect(() => w.debit(brl('0'), later)).toThrow(InvalidMoneyError);
    expect(w.version).toBe(1);
  });

  it('rejeita débito com moeda diferente da wallet', () => {
    const w = openWallet();
    expect(() => w.debit(Money.from({ amount: '1.00', currency: 'USD' }), later)).toThrow(InvalidInvariantError);
  });
});

describe('Wallet.credit', () => {
  it('credita e incrementa versão', () => {
    const w = openWallet('10.00');
    const movement = w.credit(brl('5.50'), later);

    expect(movement.direction).toBe(LedgerDirection.Credit);
    expect(movement.balanceAfter.toJSON().amount).toBe('15.50');
    expect(w.version).toBe(2);
  });

  it('rejeita crédito de valor zero ou negativo', () => {
    const w = openWallet();
    expect(() => w.credit(brl('0'), later)).toThrow(InvalidMoneyError);
    expect(() => w.credit(brl('-1.00'), later)).toThrow(InvalidMoneyError);
  });

  it('rejeita crédito com moeda diferente', () => {
    const w = openWallet();
    expect(() => w.credit(Money.from({ amount: '1.00', currency: 'EUR' }), later)).toThrow(InvalidInvariantError);
  });
});

describe('Wallet — versão e invariantes', () => {
  it('versão incrementa somente quando o saldo muda', () => {
    const w = openWallet('50.00');
    w.credit(brl('1.00'), later);
    w.debit(brl('1.00'), later);
    expect(w.version).toBe(3);
    expect(w.balance.toJSON().amount).toBe('50.00');
  });

  it('sequência de operações mantém saldo consistente', () => {
    const w = openWallet('100.00');
    w.debit(brl('80.00'), later);
    expect(() => w.debit(brl('80.00'), later)).toThrow(InsufficientBalanceError);
    w.credit(brl('30.00'), later);
    w.debit(brl('50.00'), later);
    expect(w.balance.toJSON().amount).toBe('0.00');
    expect(w.version).toBe(4);
  });

  it('rehydrate reconstrói estado sem revalidar transições', () => {
    const w = Wallet.rehydrate({
      id: 'w-9',
      playerId: 'p-9',
      currency: 'BRL',
      balance: { amount: '42.00', currency: 'BRL' },
      version: 7,
      createdAt: at,
      updatedAt: later,
    });
    expect(w.balance.toJSON().amount).toBe('42.00');
    expect(w.version).toBe(7);
  });
});
