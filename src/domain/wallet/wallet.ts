import { InsufficientBalanceError, InvalidInvariantError, InvalidMoneyError } from '../errors';
import { LedgerDirection } from '../ledger/ledger-direction';
import { Money, type MoneyProps } from '../money/money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Resultado de uma movimentação. A camada de aplicação usa isto para gravar
 * exatamente um lançamento no ledger (invariante: saldo e ledger sempre juntos).
 */
export interface WalletMovement {
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number;
  at: Date;
}

/**
 * Aggregate Root. Estado encapsulado; alterações só por `debit` e `credit`.
 *
 * Invariantes:
 * - saldo nunca negativo;
 * - moeda da movimentação = moeda da wallet;
 * - `version` começa em 1 e incrementa somente quando o saldo muda.
 *
 * Unicidade por (playerId, currency) é garantida no banco (Etapa 2).
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money; at: Date }): Wallet {
    assertText(props.id, 'id');
    assertText(props.playerId, 'playerId');
    if (props.initialBalance.isNegative()) {
      throw new InvalidMoneyError('saldo inicial não pode ser negativo');
    }
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.at,
      props.at,
    );
  }

  /** Reconstrução a partir da persistência. Não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      Money.from(state.balance),
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Débito. Lança InsufficientBalanceError se o saldo não cobre o valor. */
  debit(money: Money, at: Date): WalletMovement {
    this.assertMovable(money);
    if (this._balance.isLessThan(money)) {
      throw new InsufficientBalanceError();
    }
    return this.apply(LedgerDirection.Debit, money, this._balance.subtract(money), at);
  }

  credit(money: Money, at: Date): WalletMovement {
    this.assertMovable(money);
    return this.apply(LedgerDirection.Credit, money, this._balance.add(money), at);
  }

  private assertMovable(money: Money): void {
    if (money.currency !== this.currency) {
      throw new InvalidInvariantError(
        `moeda da movimentação (${money.currency}) difere da wallet (${this.currency})`,
      );
    }
    if (!money.isPositive()) {
      throw new InvalidMoneyError('movimentação deve ter valor positivo');
    }
  }

  private apply(direction: LedgerDirection, money: Money, after: Money, at: Date): WalletMovement {
    const before = this._balance;
    this._balance = after;
    this._version += 1;
    this._updatedAt = at;
    return { direction, money, balanceBefore: before, balanceAfter: after, walletVersion: this._version, at };
  }
}

function assertText(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidInvariantError(`${field} é obrigatório`);
  }
}
