import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../../src/domain/errors';
import { FailureCode } from '../../../src/domain/failure-code';
import { Money } from '../../../src/domain/money/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money — construção e validação', () => {
  it.each(['25', '25.0', '25.00', '-3.50', '0', '0.00', '1000000000000000.99'])('aceita "%s"', (amount) => {
    expect(() => Money.from({ amount, currency: 'BRL' })).not.toThrow();
  });

  it.each([
    ['vazia', ''],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['notação científica', '1e3'],
    ['sinal de mais', '+5'],
    ['mais de 2 casas', '1.234'],
    ['espaços', ' 10.00 '],
    ['vírgula decimal', '10,00'],
    ['ponto final', '10.'],
  ])('rejeita %s', (_label, amount) => {
    expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  it('rejeita amount que não é string (ex.: number)', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  it('rejeita moeda fora do formato ISO-4217 (3 letras maiúsculas)', () => {
    expect(() => Money.from({ amount: '1.00', currency: 'brl' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '1.00', currency: 'BR' })).toThrow(InvalidMoneyError);
  });

  it('fromInput rejeita negativos, from aceita', () => {
    expect(() => Money.fromInput({ amount: '-1.00', currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(brl('-1.00').isNegative()).toBe(true);
  });

  it('erro de amount inválido carrega INVALID_PAYLOAD', () => {
    try {
      brl('1e3');
      throw new Error('deveria ter lançado');
    } catch (error) {
      expect((error as InvalidMoneyError).failureCode).toBe(FailureCode.InvalidPayload);
    }
  });
});

describe('Money — serialização com escala fixa de 2', () => {
  it('normaliza para 2 casas', () => {
    expect(brl('25').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(brl('25.5').toJSON()).toEqual({ amount: '25.50', currency: 'BRL' });
  });

  it('toString usa a mesma escala', () => {
    expect(brl('25').toString()).toBe('25.00 BRL');
  });

  it('não produz -0.00', () => {
    expect(brl('0').negate().toJSON().amount).toBe('0.00');
    expect(brl('-0.00').toJSON().amount).toBe('0.00');
  });

  it('round-trip JSON é exato', () => {
    const original = brl('1234567.89');
    expect(Money.from(original.toJSON()).equals(original)).toBe(true);
  });
});

describe('Money — aritmética exata', () => {
  it('0.1 + 0.2 = 0.30 (sem erro de ponto flutuante)', () => {
    expect(brl('0.1').add(brl('0.2')).toJSON().amount).toBe('0.30');
  });

  it('soma e subtração', () => {
    expect(brl('100.00').subtract(brl('80.00')).toJSON().amount).toBe('20.00');
    expect(brl('10.00').add(brl('5.25')).toJSON().amount).toBe('15.25');
  });

  it('negate inverte o sinal', () => {
    expect(brl('12.34').negate().toJSON().amount).toBe('-12.34');
  });

  it('operações retornam nova instância (imutabilidade)', () => {
    const a = brl('10.00');
    const b = a.add(brl('1.00'));
    expect(a.toJSON().amount).toBe('10.00');
    expect(b).not.toBe(a);
  });

  it('soma de muitos centavos permanece exata', () => {
    let total = Money.zero('BRL');
    for (let i = 0; i < 10_000; i++) total = total.add(brl('0.01'));
    expect(total.toJSON().amount).toBe('100.00');
  });
});

describe('Money — comparações e predicados', () => {
  it('isZero / isPositive / isNegative', () => {
    expect(brl('0').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('-0.01').isNegative()).toBe(true);
    expect(brl('0').isPositive()).toBe(false);
  });

  it('isLessThan compara valores', () => {
    expect(brl('19.99').isLessThan(brl('20.00'))).toBe(true);
    expect(brl('20.00').isLessThan(brl('20.00'))).toBe(false);
  });

  it('equals compara valor e moeda', () => {
    expect(brl('5').equals(brl('5.00'))).toBe(true);
    expect(brl('5').equals(Money.from({ amount: '5.00', currency: 'USD' }))).toBe(false);
  });
});

describe('Money — conflito de moeda', () => {
  const usd = Money.from({ amount: '1.00', currency: 'USD' });

  it('add lança CurrencyMismatchError com CURRENCY_MISMATCH', () => {
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    try {
      brl('1.00').add(usd);
    } catch (error) {
      expect((error as CurrencyMismatchError).failureCode).toBe(FailureCode.CurrencyMismatch);
    }
  });

  it('subtract, isLessThan também lançam', () => {
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });
});
