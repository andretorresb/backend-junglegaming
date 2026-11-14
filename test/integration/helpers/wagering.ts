import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { expect } from 'bun:test';
import { Money } from '../../../src/domain/money/money';
import { ProcessWagerTransaction } from '../../../src/application/wagering/process-wager-transaction.use-case';
import { MikroOrmWagerUnitOfWork } from '../../../src/infrastructure/persistence/wagering.persistence';
import type { EntityManager } from '@mikro-orm/core';
import type { Clock } from '../../../src/application/ports/clock';
import { computePayloadHash } from '../../../src/domain/wagering/payload-hash';

/**
 * Cria uma wallet com saldo inicial e o lançamento OPENING correspondente,
 * do mesmo modo que a Etapa 4 fará pelo POST /wallets. Sem isso, o invariante não fecha.
 */
export async function seedWallet(
  client: Client,
  options: { balance?: string; currency?: string; playerId?: string } = {},
): Promise<{ walletId: string; playerId: string; currency: string }> {
  const walletId = randomUUID();
  const playerId = options.playerId ?? randomUUID();
  const currency = options.currency ?? 'BRL';
  const balance = options.balance ?? '0.00';
  const now = new Date('2026-07-29T15:00:00.000Z');

  await client.query(
    `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 1, $5, $5)`,
    [walletId, playerId, currency, balance, now],
  );

  if (Number(balance) > 0) {
    const txId = randomUUID();
    await client.query(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at, processed_at, balance_observed)
       VALUES ($1, 'internal', $2, $3, $4, $5, $6, 'opening', 'opening', 'OPENING', $7, $8, 'PROCESSED', $9, $9, $7)`,
      [txId, `opening-${txId}`, `opening-${txId}`, '0'.repeat(64), walletId, playerId, balance, currency, now],
    );
    await client.query(
      `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
         balance_before, balance_after, created_at)
       VALUES ($1, $2, $3, 'CREDIT', $4, $5, '0.00', $4, $6)`,
      [randomUUID(), walletId, txId, balance, currency, now],
    );
  }

  return { walletId, playerId, currency };
}

/** Invariante final (seção 13): wallet.balance == soma reconstruída pelo ledger. */
export async function assertLedgerInvariant(client: Client, walletId: string): Promise<void> {
  const result = await client.query<{ stored: string; calculated: string }>(
    `SELECT w.balance::text AS stored,
            COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::text AS calculated
       FROM wallets w
       LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
      WHERE w.id = $1
      GROUP BY w.balance`,
    [walletId],
  );
  const row = result.rows[0];
  expect(row).toBeDefined();
  expect(Number(row?.calculated)).toBe(Number(row?.stored));
}

export async function countRows(client: Client, sql: string, params: unknown[] = []): Promise<number> {
  const result = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM (${sql}) AS q`, params);
  return Number(result.rows[0]?.n ?? 0);
}

export interface CommandOverrides {
  idempotencyKey?: string | undefined;
  providerId?: string | undefined;
  externalTransactionId?: string | undefined;
  playerId: string;
  walletId: string;
  kind?: 'BET' | 'WIN' | 'LOSS' | 'OPENING' | 'REFUND' | 'ROLLBACK';
  amount: string;
  currency?: string;
}

/** Monta o comando do caso de uso. A chave padrão segue o enunciado: provider:externalTransactionId. */
export function command(overrides: CommandOverrides) {
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${randomUUID()}`;
  const providerId = overrides.providerId ?? 'provider-a';
  return {
    idempotencyKey: overrides.idempotencyKey ?? `${providerId}:${externalTransactionId}`,
    providerId,
    externalTransactionId,
    playerId: overrides.playerId,
    walletId: overrides.walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: (overrides.kind ?? 'BET') as never,
    money: { amount: overrides.amount, currency: overrides.currency ?? 'BRL' },
    correlationId: randomUUID(),
  };
}

export function fixedClock(at = new Date('2026-07-29T15:00:00.000Z')): Clock {
  return { now: () => at };
}

/** Caso de uso com a unidade de trabalho real sobre o banco de teste. */
export function useCase(em: EntityManager, clock: Clock = fixedClock()): ProcessWagerTransaction {
  return new ProcessWagerTransaction(new MikroOrmWagerUnitOfWork(em), clock, randomUUID);
}

export { computePayloadHash, Money };
