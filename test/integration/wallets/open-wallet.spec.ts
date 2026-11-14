import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { Client } from 'pg';
import { createPgClient, createTestOrm, truncateAll } from '../helpers/database';
import { assertLedgerInvariant, countRows, fixedClock } from '../helpers/wagering';
import { OpenWallet } from '../../../src/application/wallets/open-wallet.use-case';
import { MikroOrmWagerUnitOfWork } from '../../../src/infrastructure/persistence/wagering.persistence';
import { DuplicateWalletError } from '../../../src/application/wagering/errors';
import type { WagerUnitOfWork, WagerRepositories } from '../../../src/application/wagering/ports';

describe('POST /wallets — OpenWallet', () => {
  let orm: MikroORM;
  let client: Client;
  let em: EntityManager;

  beforeAll(async () => {
    orm = await createTestOrm();
    await orm.getMigrator().up();
    client = await createPgClient();
    em = orm.em;
  });

  beforeEach(async () => {
    await truncateAll(client);
  });

  afterAll(async () => {
    await client.end();
    await orm.close();
  });

  const open = (uow: WagerUnitOfWork, playerId: string, amount: string, currency = 'BRL') =>
    new OpenWallet(uow, fixedClock(), randomUUID).execute({
      playerId,
      initialBalance: { amount, currency },
      correlationId: randomUUID(),
    });

  it('saldo zero: cria a wallet sem OPENING nem lançamento', async () => {
    const playerId = randomUUID();
    const result = await open(new MikroOrmWagerUnitOfWork(em), playerId, '0.00');

    expect(result).toMatchObject({ playerId, balance: { amount: '0.00', currency: 'BRL' }, version: 1 });
    expect(await countRows(client, 'SELECT id FROM wager_transactions')).toBe(0);
    expect(await countRows(client, 'SELECT id FROM wallet_ledger_entries')).toBe(0);
    expect(await countRows(client, 'SELECT id FROM outbox_messages')).toBe(0);
  });

  it('saldo positivo: wallet + OPENING + lançamento CREDIT + evento, e o invariante fecha', async () => {
    const playerId = randomUUID();
    const result = await open(new MikroOrmWagerUnitOfWork(em), playerId, '1000.00');

    expect(result.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    const tx = await client.query<{ kind: string; status: string; balance_observed: string }>(
      'SELECT kind, status, balance_observed::text FROM wager_transactions WHERE wallet_id = $1',
      [result.id],
    );
    expect(tx.rows).toEqual([{ kind: 'OPENING', status: 'PROCESSED', balance_observed: '1000.00' }]);
    const ledger = await client.query<{ direction: string; balance_before: string; balance_after: string }>(
      'SELECT direction, balance_before::text, balance_after::text FROM wallet_ledger_entries WHERE wallet_id = $1',
      [result.id],
    );
    expect(ledger.rows).toEqual([{ direction: 'CREDIT', balance_before: '0.00', balance_after: '1000.00' }]);
    const events = await client.query<{ event_type: string }>('SELECT event_type FROM outbox_messages');
    expect(events.rows.map((r) => r.event_type)).toEqual(['WalletBalanceChanged']);
    await assertLedgerInvariant(client, result.id);
  });

  it('duplicata (mesmo playerId + currency) → DuplicateWalletError', async () => {
    const playerId = randomUUID();
    const uow = new MikroOrmWagerUnitOfWork(em);
    await open(uow, playerId, '10.00');
    await expect(open(uow, playerId, '20.00')).rejects.toBeInstanceOf(DuplicateWalletError);
    expect(await countRows(client, 'SELECT id FROM wallets WHERE player_id = $1', [playerId])).toBe(1);
  });

  it('mesmo playerId em outra moeda é permitido', async () => {
    const playerId = randomUUID();
    const uow = new MikroOrmWagerUnitOfWork(em);
    await open(uow, playerId, '10.00', 'BRL');
    await expect(open(uow, playerId, '10.00', 'USD')).resolves.toBeDefined();
  });

  it('saldo negativo é rejeitado antes de qualquer escrita', async () => {
    await expect(open(new MikroOrmWagerUnitOfWork(em), randomUUID(), '-1.00')).rejects.toMatchObject({
      failureCode: 'INVALID_PAYLOAD',
    });
    expect(await countRows(client, 'SELECT id FROM wallets')).toBe(0);
  });

  it('atomicidade: falha na outbox desfaz wallet e OPENING (nada fica gravado pela metade)', async () => {
    const real = new MikroOrmWagerUnitOfWork(em);
    const failingOutbox: WagerUnitOfWork = {
      run: (work) =>
        real.run((repos) => {
          const broken = new Proxy(repos, {
            get(target, prop, receiver) {
              if (prop === 'enqueueOutbox') {
                return async () => {
                  throw new Error('falha simulada na outbox');
                };
              }
              return Reflect.get(target, prop, receiver);
            },
          }) as WagerRepositories;
          return work(broken);
        }),
    };

    await expect(open(failingOutbox, randomUUID(), '500.00')).rejects.toThrow('falha simulada');

    expect(await countRows(client, 'SELECT id FROM wallets')).toBe(0);
    expect(await countRows(client, 'SELECT id FROM wager_transactions')).toBe(0);
    expect(await countRows(client, 'SELECT id FROM wallet_ledger_entries')).toBe(0);
  });
});
