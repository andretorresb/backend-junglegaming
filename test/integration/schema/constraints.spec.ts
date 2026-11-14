import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Client } from 'pg';
import { createPgClient, createTestOrm, truncateAll } from '../helpers/database';

/**
 * Garantias do schema (seção 5, item 9 do enunciado).
 * Cada teste prova que o PostgreSQL rejeita a violação, independentemente do código da aplicação.
 *
 * Códigos SQLSTATE usados:
 *   23505 unique_violation · 23514 check_violation · 23503 foreign_key_violation
 */

const PAYLOAD_HASH = 'a'.repeat(64);

async function expectSqlState(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`esperava erro SQLSTATE ${code}, mas a operação foi aceita`);
}

async function insertWallet(
  client: Client,
  overrides: Partial<{ id: string; playerId: string; currency: string; balance: string; version: number }> = {},
): Promise<{ id: string; playerId: string; currency: string }> {
  const row = {
    id: randomUUID(),
    playerId: randomUUID(),
    currency: 'BRL',
    balance: '100.00',
    version: 1,
    ...overrides,
  };
  await client.query(
    `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())`,
    [row.id, row.playerId, row.currency, row.balance, row.version],
  );
  return row;
}

interface TxOverrides {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  currency: string;
  kind: string;
  amount: string;
  status: string;
  referenceExternalTransactionId: string | null;
}

async function insertTransaction(client: Client, overrides: Partial<TxOverrides> & { walletId: string; playerId: string }): Promise<string> {
  const id = randomUUID();
  const row: TxOverrides = {
    id,
    providerId: 'provider-a',
    externalTransactionId: `tx-${id}`,
    idempotencyKey: `provider-a:tx-${id}`,
    currency: 'BRL',
    kind: 'BET',
    amount: '25.00',
    status: 'PENDING',
    referenceExternalTransactionId: null,
    ...overrides,
  };
  await client.query(
    `INSERT INTO wager_transactions (
       id, provider_id, external_transaction_id, idempotency_key, payload_hash,
       wallet_id, player_id, round_id, game_id, kind, amount, currency,
       reference_external_transaction_id, status, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'round-987', 'fortune-chimp', $8, $9, $10, $11, $12, now())`,
    [
      row.id,
      row.providerId,
      row.externalTransactionId,
      row.idempotencyKey,
      PAYLOAD_HASH,
      row.walletId,
      row.playerId,
      row.kind,
      row.amount,
      row.currency,
      row.referenceExternalTransactionId,
      row.status,
    ],
  );
  return id;
}

async function insertLedger(
  client: Client,
  overrides: Partial<{ walletId: string; transactionId: string; direction: string; amount: string; currency: string; balanceBefore: string; balanceAfter: string }> & {
    walletId: string;
    transactionId: string;
  },
): Promise<string> {
  const id = randomUUID();
  const row = {
    direction: 'DEBIT',
    amount: '25.00',
    currency: 'BRL',
    balanceBefore: '100.00',
    balanceAfter: '75.00',
    ...overrides,
  };
  await client.query(
    `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
    [id, row.walletId, row.transactionId, row.direction, row.amount, row.currency, row.balanceBefore, row.balanceAfter],
  );
  return id;
}

describe('Schema — constraints', () => {
  let orm: MikroORM;
  let client: Client;

  beforeAll(async () => {
    orm = await createTestOrm();
    await orm.getMigrator().up();
    client = await createPgClient();
  });

  beforeEach(async () => {
    await truncateAll(client);
  });

  afterAll(async () => {
    await client.end();
    await orm.close();
  });

  describe('wallets', () => {
    it('aceita wallet válida', async () => {
      await expect(insertWallet(client)).resolves.toBeDefined();
    });

    it('rejeita segunda wallet para o mesmo player + currency', async () => {
      const first = await insertWallet(client);
      await expectSqlState(insertWallet(client, { playerId: first.playerId }), '23505');
    });

    it('permite o mesmo player em outra moeda', async () => {
      const first = await insertWallet(client);
      await expect(insertWallet(client, { playerId: first.playerId, currency: 'USD' })).resolves.toBeDefined();
    });

    it('rejeita saldo negativo', async () => {
      await expectSqlState(insertWallet(client, { balance: '-0.01' }), '23514');
    });

    it('rejeita versão menor que 1', async () => {
      await expectSqlState(insertWallet(client, { version: 0 }), '23514');
    });

    it('rejeita moeda fora do formato ISO (minúscula ou com 2 letras)', async () => {
      await expectSqlState(insertWallet(client, { currency: 'brl' }), '23514');
      await expectSqlState(insertWallet(client, { currency: 'BR' }), '23514');
    });

    it('coluna tem escala 2: o banco arredonda, por isso o Money rejeita entradas com 3 casas antes', async () => {
      await insertWallet(client, { balance: '10.005' });
      const stored = await client.query<{ balance: string }>('SELECT balance FROM wallets LIMIT 1');
      expect(stored.rows[0]?.balance).toBe('10.01');
    });
  });

  describe('wager_transactions', () => {
    it('rejeita duplicidade de (provider, external_transaction_id)', async () => {
      const w = await insertWallet(client);
      await insertTransaction(client, { walletId: w.id, playerId: w.playerId, externalTransactionId: 'same', idempotencyKey: 'k1' });
      await expectSqlState(
        insertTransaction(client, { walletId: w.id, playerId: w.playerId, externalTransactionId: 'same', idempotencyKey: 'k2' }),
        '23505',
      );
    });

    it('rejeita duplicidade de idempotency_key', async () => {
      const w = await insertWallet(client);
      await insertTransaction(client, { walletId: w.id, playerId: w.playerId, idempotencyKey: 'key-1' });
      await expectSqlState(
        insertTransaction(client, { walletId: w.id, playerId: w.playerId, idempotencyKey: 'key-1' }),
        '23505',
      );
    });

    it('rejeita valor zero ou negativo', async () => {
      const w = await insertWallet(client);
      await expectSqlState(insertTransaction(client, { walletId: w.id, playerId: w.playerId, amount: '0' }), '23514');
      await expectSqlState(insertTransaction(client, { walletId: w.id, playerId: w.playerId, amount: '-1.00' }), '23514');
    });

    it('rejeita kind e status desconhecidos', async () => {
      const w = await insertWallet(client);
      await expectSqlState(insertTransaction(client, { walletId: w.id, playerId: w.playerId, kind: 'DEPOSIT' }), '23514');
      await expectSqlState(insertTransaction(client, { walletId: w.id, playerId: w.playerId, status: 'DONE' }), '23514');
    });

    it('REFUND e ROLLBACK exigem referência', async () => {
      const w = await insertWallet(client);
      await expectSqlState(insertTransaction(client, { walletId: w.id, playerId: w.playerId, kind: 'REFUND' }), '23514');
      await expectSqlState(insertTransaction(client, { walletId: w.id, playerId: w.playerId, kind: 'ROLLBACK' }), '23514');
      await expect(
        insertTransaction(client, {
          walletId: w.id,
          playerId: w.playerId,
          kind: 'REFUND',
          referenceExternalTransactionId: 'bet-1',
        }),
      ).resolves.toBeDefined();
    });

    it('BET, WIN e LOSS não aceitam referência', async () => {
      const w = await insertWallet(client);
      await expectSqlState(
        insertTransaction(client, { walletId: w.id, playerId: w.playerId, kind: 'BET', referenceExternalTransactionId: 'x' }),
        '23514',
      );
    });

    it('rejeita transação com moeda diferente da wallet (FK composta)', async () => {
      const w = await insertWallet(client, { currency: 'BRL' });
      await expectSqlState(insertTransaction(client, { walletId: w.id, playerId: w.playerId, currency: 'USD' }), '23503');
    });

    it('rejeita transação de wallet inexistente', async () => {
      const w = await insertWallet(client);
      await expectSqlState(insertTransaction(client, { walletId: randomUUID(), playerId: w.playerId }), '23503');
    });
  });

  describe('wallet_ledger_entries', () => {
    async function setupTransaction(): Promise<{ walletId: string; txId: string }> {
      const w = await insertWallet(client);
      const txId = await insertTransaction(client, { walletId: w.id, playerId: w.playerId });
      return { walletId: w.id, txId };
    }

    it('aceita lançamento válido', async () => {
      const { walletId, txId } = await setupTransaction();
      await expect(insertLedger(client, { walletId, transactionId: txId })).resolves.toBeDefined();
    });

    it('bloqueia UPDATE no ledger (imutabilidade)', async () => {
      const { walletId, txId } = await setupTransaction();
      const id = await insertLedger(client, { walletId, transactionId: txId });
      await expect(client.query('UPDATE wallet_ledger_entries SET amount = 1 WHERE id = $1', [id])).rejects.toThrow(
        /immutable/,
      );
    });

    it('bloqueia DELETE no ledger (imutabilidade)', async () => {
      const { walletId, txId } = await setupTransaction();
      const id = await insertLedger(client, { walletId, transactionId: txId });
      await expect(client.query('DELETE FROM wallet_ledger_entries WHERE id = $1', [id])).rejects.toThrow(/immutable/);
    });

    it('no máximo um lançamento por (wallet, transação)', async () => {
      const { walletId, txId } = await setupTransaction();
      await insertLedger(client, { walletId, transactionId: txId });
      await expectSqlState(insertLedger(client, { walletId, transactionId: txId }), '23505');
    });

    it('rejeita direção inválida', async () => {
      const { walletId, txId } = await setupTransaction();
      await expectSqlState(insertLedger(client, { walletId, transactionId: txId, direction: 'SIDEWAYS' }), '23514');
    });

    it('rejeita saldo posterior negativo', async () => {
      const { walletId, txId } = await setupTransaction();
      await expectSqlState(insertLedger(client, { walletId, transactionId: txId, balanceAfter: '-5.00' }), '23514');
    });

    it('rejeita lançamento com moeda diferente da wallet', async () => {
      const { walletId, txId } = await setupTransaction();
      await expectSqlState(insertLedger(client, { walletId, transactionId: txId, currency: 'USD' }), '23503');
    });
  });

  describe('inbox_messages e outbox_messages', () => {
    it('inbox: chave (consumer_name, message_id) é única', async () => {
      const insert = () =>
        client.query(
          `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
           VALUES ('wager-transactions', 'msg-1', $1, now())`,
          [PAYLOAD_HASH],
        );
      await insert();
      await expectSqlState(insert(), '23505');
    });

    it('inbox: mesmo message_id para consumidores diferentes é permitido', async () => {
      await client.query(
        `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
         VALUES ('a', 'msg-1', $1, now()), ('b', 'msg-1', $1, now())`,
        [PAYLOAD_HASH],
      );
      const count = await client.query('SELECT count(*)::int AS n FROM inbox_messages');
      expect(count.rows[0]?.n).toBe(2);
    });

    it('outbox: attempts não pode ser negativo', async () => {
      await expectSqlState(
        client.query(
          `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
           VALUES ($1, $2, 'WalletBalanceChanged', '{}', now(), -1)`,
          [randomUUID(), randomUUID()],
        ),
        '23514',
      );
    });

    it('outbox: payload deve ser objeto JSON', async () => {
      await expectSqlState(
        client.query(
          `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
           VALUES ($1, $2, 'WalletBalanceChanged', '[1,2]', now())`,
          [randomUUID(), randomUUID()],
        ),
        '23514',
      );
    });

    it('outbox: aceita evento válido com attempts default 0', async () => {
      await client.query(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
         VALUES ($1, $2, 'WalletBalanceChanged', '{"a":1}', now())`,
        [randomUUID(), randomUUID()],
      );
      const row = await client.query<{ attempts: number }>('SELECT attempts FROM outbox_messages LIMIT 1');
      expect(row.rows[0]?.attempts).toBe(0);
    });
  });
});
