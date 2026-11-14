import { describe, expect, it } from 'bun:test';
import { LedgerArithmeticError } from '../../../src/domain/errors';
import { LedgerDirection } from '../../../src/domain/ledger/ledger-direction';
import { Money } from '../../../src/domain/money/money';
import { WalletLedgerEntry } from '../../../src/domain/wallet/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-07-29T15:00:00.000Z');

function entry(direction: LedgerDirection, before: string, money: string, after: string) {
  return WalletLedgerEntry.create({
    id: 'e-1',
    walletId: 'w-1',
    transactionId: 't-1',
    direction,
    money: brl(money),
    balanceBefore: brl(before),
    balanceAfter: brl(after),
    createdAt: now,
  });
}

describe('WalletLedgerEntry.create', () => {
  it('aceita débito aritmeticamente correto', () => {
    const e = entry(LedgerDirection.Debit, '100.00', '25.00', '75.00');
    expect(e.isBalanced()).toBe(true);
  });

  it('aceita crédito aritmeticamente correto', () => {
    expect(entry(LedgerDirection.Credit, '75.00', '25.00', '100.00').isBalanced()).toBe(true);
  });

  it('rejeita débito com aritmética errada', () => {
    expect(() => entry(LedgerDirection.Debit, '100.00', '25.00', '70.00')).toThrow(LedgerArithmeticError);
  });

  it('rejeita crédito com aritmética errada', () => {
    expect(() => entry(LedgerDirection.Credit, '75.00', '25.00', '99.00')).toThrow(LedgerArithmeticError);
  });

  it('rejeita saldo posterior negativo', () => {
    expect(() => entry(LedgerDirection.Debit, '10.00', '20.00', '-10.00')).toThrow(LedgerArithmeticError);
  });

  it('rejeita lançamento de valor zero', () => {
    expect(() => entry(LedgerDirection.Credit, '10.00', '0', '10.00')).toThrow(LedgerArithmeticError);
  });

  it('isBalanced é falso quando moedas divergem (sem lançar)', () => {
    const usd = Money.from({ amount: '75.00', currency: 'USD' });
    const e = WalletLedgerEntry.rehydrate({
      id: 'e-2',
      walletId: 'w-1',
      transactionId: 't-2',
      direction: LedgerDirection.Debit,
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: usd.toJSON(),
      createdAt: now,
    });
    expect(e.isBalanced()).toBe(false);
  });

  it('não expõe métodos de transição (imutabilidade estrutural)', () => {
    const e = entry(LedgerDirection.Debit, '100.00', '25.00', '75.00') as unknown as Record<string, unknown>;
    expect(e['markProcessed']).toBeUndefined();
    expect(e['update']).toBeUndefined();
  });
});
