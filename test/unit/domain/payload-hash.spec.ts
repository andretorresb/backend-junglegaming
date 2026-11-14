import { describe, expect, it } from 'bun:test';
import { canonicalJson, computePayloadHash, type PayloadHashInput } from '../../../src/domain/wagering/payload-hash';

const base: PayloadHashInput = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
  referenceExternalTransactionId: null,
};

describe('computePayloadHash', () => {
  it('retorna SHA-256 em hexadecimal minúsculo (64 caracteres)', () => {
    expect(computePayloadHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('é determinístico', () => {
    expect(computePayloadHash(base)).toBe(computePayloadHash({ ...base }));
  });

  it('ignora a ordem de chaves no objeto de entrada', () => {
    const reordered = {
      referenceExternalTransactionId: null,
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'fortune-chimp',
      roundId: 'round-987',
      walletId: base.walletId,
      playerId: base.playerId,
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
    } as PayloadHashInput;
    expect(computePayloadHash(reordered)).toBe(computePayloadHash(base));
  });

  it('muda quando qualquer campo de negócio muda', () => {
    const h = computePayloadHash(base);
    expect(computePayloadHash({ ...base, money: { amount: '25.01', currency: 'BRL' } })).not.toBe(h);
    expect(computePayloadHash({ ...base, kind: 'WIN' })).not.toBe(h);
    expect(computePayloadHash({ ...base, roundId: 'round-988' })).not.toBe(h);
    expect(computePayloadHash({ ...base, money: { amount: '25.00', currency: 'USD' } })).not.toBe(h);
  });

  it('referência nula difere de referência preenchida', () => {
    expect(computePayloadHash({ ...base, referenceExternalTransactionId: 'bet-1' })).not.toBe(computePayloadHash(base));
  });

  it('canonicalJson ordena chaves recursivamente e não emite espaços', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 0, y: 1 }] } })).toBe('{"a":{"c":[3,{"y":1,"z":0}],"d":2},"b":1}');
  });

  it('arrays preservam a ordem', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });
});
