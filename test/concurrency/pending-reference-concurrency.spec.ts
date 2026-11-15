import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { Client } from 'pg';
import { createPgClient, createTestOrm, truncateAll } from '../integration/helpers/database';
import { assertLedgerInvariant, command, countRows, mutableClock, seedWallet, useCase } from '../integration/helpers/wagering';
import { PendingReferenceWorker } from '../../src/application/wagering/pending-reference.worker';
import { MikroOrmWagerUnitOfWork } from '../../src/infrastructure/persistence/wagering.persistence';
import type { ReferenceRetryPolicy } from '../../src/domain/wagering/reference-retry-policy';

const POLICY: ReferenceRetryPolicy = { baseDelayMs: 1000, maxDelayMs: 8000, maxAttempts: 10, ttlMs: 24 * 60 * 60 * 1000 };
const START = new Date('2026-07-29T15:00:00.000Z');
const ONE_HOUR = 60 * 60 * 1000;

describe('Concorrência — worker de referências pendentes', () => {
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

  it('50 ROLLBACKs pendentes, dois workers em paralelo → cada um resolvido exatamente uma vez', async () => {
    const clock = mutableClock(START);
    const uc = useCase(em, clock);
    const wallets = await Promise.all(Array.from({ length: 5 }, () => seedWallet(client, { balance: '1000.00' })));

    // ROLLBACKs chegam antes das apostas
    for (let i = 0; i < 50; i++) {
      const w = wallets[i % wallets.length]!;
      await uc.execute({
        ...command({ walletId: w.walletId, playerId: w.playerId, kind: 'ROLLBACK', amount: '10.00', externalTransactionId: `rb-${i}` }),
        kind: 'ROLLBACK' as never,
        referenceExternalTransactionId: `bet-${i}`,
      });
    }
    // as apostas chegam depois
    for (let i = 0; i < 50; i++) {
      const w = wallets[i % wallets.length]!;
      await uc.execute(command({ walletId: w.walletId, playerId: w.playerId, amount: '10.00', externalTransactionId: `bet-${i}` }));
    }

    const makeWorker = () =>
      new PendingReferenceWorker(new MikroOrmWagerUnitOfWork(em), clock, randomUUID, { retryPolicy: POLICY, random: () => 1 });
    const workers = [makeWorker(), makeWorker()];

    clock.advance(ONE_HOUR);
    // dois workers drenam a fila em paralelo até não haver nada vencido
    let claimed = 1;
    for (let round = 0; round < 20 && claimed > 0; round++) {
      const results = await Promise.all(workers.map((w) => w.runCycle(10)));
      claimed = results.reduce((sum, r) => sum + r.claimed, 0);
      clock.advance(1000);
    }

    const pending = await countRows(client, "SELECT id FROM wager_transactions WHERE status = 'PENDING_REFERENCE'");
    expect(pending).toBe(0);
    const processed = await countRows(client, "SELECT id FROM wager_transactions WHERE external_transaction_id LIKE 'rb-%' AND status = 'PROCESSED'");
    expect(processed).toBe(50);
    // nenhuma reversão processada duplicada para a mesma referência
    const duplicates = await countRows(
      client,
      "SELECT reference_transaction_id FROM wager_transactions WHERE kind = 'ROLLBACK' AND status = 'PROCESSED' GROUP BY reference_transaction_id HAVING count(*) > 1",
    );
    expect(duplicates).toBe(0);
    // cada wallet: 10 apostas de 10.00 debitadas e 10 reversões creditadas → saldo intacto
    for (const w of wallets) {
      const r = await client.query<{ balance: string }>('SELECT balance::text AS balance FROM wallets WHERE id = $1', [w.walletId]);
      expect(r.rows[0]?.balance).toBe('1000.00');
      await assertLedgerInvariant(client, w.walletId);
    }
  }, 120_000);
});
