import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from '../errors';

/**
 * Precisão alta o bastante para somas de valores com 2 casas dentro de DECIMAL(19,2).
 * Nenhuma operação arredonda: entradas com mais de 2 casas são rejeitadas antes.
 */
const D = Decimal.clone({ precision: 40, toExpNeg: -40, toExpPos: 40 });

/** Aceita: "25", "25.0", "25.00", "-3.50". Rejeita: "", NaN, Infinity, "1e3", "+5", "1.234". */
const AMOUNT_PATTERN = /^-?\d+(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Formato de DTO / contrato. Interface é adequada aqui (seção 6.1 do enunciado). */
export interface MoneyProps {
  amount: string;
  currency: string;
}

/**
 * Valor monetário imutável. Nunca usa `number`.
 * Representação interna: Decimal. Serialização: string decimal com escala fixa de 2.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /** Aceita valores negativos (ex.: diferenças internas, lançamentos). */
  static from(props: MoneyProps): Money {
    return Money.build(props, false);
  }

  /** Para contratos de entrada: rejeita valores negativos. */
  static fromInput(props: MoneyProps): Money {
    return Money.build(props, true);
  }

  static zero(currency: string): Money {
    assertCurrency(currency);
    return new Money(new D(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.of(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  /** Lança CurrencyMismatchError se as moedas forem diferentes. */
  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  /** Moedas diferentes resultam em `false` (não lança). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static build(props: MoneyProps, rejectNegative: boolean): Money {
    if (typeof props.amount !== 'string') {
      throw new InvalidMoneyError('amount deve ser string decimal');
    }
    if (!AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(`amount inválido: "${props.amount}"`);
    }
    assertCurrency(props.currency);

    const value = new D(props.amount);
    if (rejectNegative && value.lessThan(0)) {
      throw new InvalidMoneyError('amount negativo não é aceito neste contrato');
    }
    return new Money(normalize(value), props.currency);
  }

  private static of(value: Decimal, currency: string): Money {
    return new Money(normalize(value), currency);
  }
}

function assertCurrency(currency: unknown): asserts currency is string {
  if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
    throw new InvalidMoneyError(`currency inválida: "${String(currency)}"`);
  }
}

/** Remove o sinal de zero (-0 → 0). */
function normalize(value: Decimal): Decimal {
  return value.isZero() ? new D(0) : value;
}
