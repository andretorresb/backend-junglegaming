import { LedgerArithmeticError } from '../errors';
import { LedgerDirection } from '../ledger/ledger-direction';
import { Money, type MoneyProps } from '../money/money';

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: Date;
}

/**
 * Lançamento imutável do ledger.
 * Sem campos mutáveis e sem métodos de transição: a imutabilidade é estrutural.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new LedgerArithmeticError('lançamento deve ter valor positivo');
    }
    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt,
    );
    if (!entry.isBalanced()) {
      throw new LedgerArithmeticError('balanceBefore ± money não é igual a balanceAfter');
    }
    if (entry.balanceAfter.isNegative()) {
      throw new LedgerArithmeticError('balanceAfter não pode ser negativo');
    }
    return entry;
  }

  /** Reconstrução a partir da persistência: não revalida regras, apenas reconstrói. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      Money.from(state.money),
      Money.from(state.balanceBefore),
      Money.from(state.balanceAfter),
      state.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter, na moeda do lançamento. */
  isBalanced(): boolean {
    const sameCurrency =
      this.money.currency === this.balanceBefore.currency &&
      this.money.currency === this.balanceAfter.currency;
    if (!sameCurrency) return false;

    const expected =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);
    return expected.equals(this.balanceAfter);
  }
}
