import { createHash } from 'node:crypto';
import type { MoneyProps } from '../money/money';

/**
 * Campos de negócio que compõem o hash do payload.
 * Header `Idempotency-Key` e metadados de transporte NÃO entram no hash.
 * `referenceExternalTransactionId` ausente é representado por `null` (não por omissão).
 */
export interface PayloadHashInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
}

/**
 * Algoritmo (documentado em ARCHITECTURE.md):
 *   1. monta o subconjunto de campos acima;
 *   2. serializa como JSON canônico: chaves de objeto ordenadas recursivamente
 *      (ordem de código UTF-16), arrays preservam a ordem, sem espaços;
 *   3. SHA-256 do texto UTF-8, em hexadecimal minúsculo (64 caracteres).
 */
export function computePayloadHash(input: PayloadHashInput): string {
  const canonical = canonicalJson(input);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    sorted[key] = canonicalize(source[key]);
  }
  return sorted;
}
