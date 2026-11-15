import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { Client } from 'pg';
import { createPgClient, createTestOrm, truncateAll } from '../helpers/database';
import { assertLedgerInvariant, command, countRows, mutableClock, seedWallet, useCase } from '../helpers/wagering';
import { PendingReferenceWorker, type WorkerLogEntry } from '../../../src/application/wagering/pending-reference.worker';
import { MikroOrmWagerUnitOfWork } from '../../../src/infrastructure/persistence/wagering.persistence';
import type { WagerRepositories, WagerUnitOfWork } from '../../../src/application/wagering/ports';
import { TransientInfrastructureError } from '../../../src/application/wagering/errors';
import type { ReferenceRetryPolicy } from '../../../src/domain/wagering/reference-retry-policy';
import { FailureCode } from '../../../src/domain/failure-code';
import { WagerTransactionStatus } from '../../../src/domain/wagering/wager-transaction';

const POLICY: ReferenceRetryPolicy = { baseDelayMs: 1000, maxDelayMs: 8000, maxAttempts: 3, ttlMs: 24 * 60 * 60 * 1000 };
const START = new Date('2026-07-29T15:00:00.000Z');
const ONE_HOUR = 60 * 60 * 1000;

describe('Referências fora de ordem — PENDING_REFERENCE e worker', () => {
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

  async function balanceOf(walletId: string): Promise<string> {
    const r = await client.query<{ balance: string }>('SELECT balance::text AS balance FROM wallets WHERE id = $1', [walletId]);
    return r.rows[0]?.balance ?? '';
  }

  function worker(uow: WagerUnitOfWork, clock: { now(): Date }, logs: WorkerLogEntry[] = [], policy = POLICY) {
    return new PendingReferenceWorker(uow, clock, randomUUID, { retryPolicy: policy, random: () => 1 }, (e) => logs.push(e));
  }

  /** Executa ciclos até não haver mais nada vencido, avançando o relógio entre eles. */
  async function drain(w: PendingReferenceWorker, clock: { advance(ms: number): void }, maxCycles = 20) {
    const totals = { resolved: 0, rejected: 0, rescheduled: 0, expired: 0, failed: 0 };
    for (let i = 0; i < maxCycles; i++) {
      clock.advance(ONE_HOUR);
      const s = await w.runCycle(50);
      totals.resolved += s.resolved;
      totals.rejected += s.rejected;
      totals.rescheduled += s.rescheduled;
      totals.expired += s.expired;
      totals.failed += s.failed;
      if (s.claimed === 0) break;
    }
    return totals;
  }

  const rollback = (w: { walletId: string; playerId: string }, ext: string, refExt: string, amount: string, kind: 'ROLLBACK' | 'REFUND' = 'ROLLBACK') => ({
    ...command({ walletId: w.walletId, playerId: w.playerId, kind, amount, externalTransactionId: ext }),
    kind: kind as never,
    referenceExternalTransactionId: refExt,
  });

  it('ROLLBACK antes da BET: PENDING_REFERENCE, agendado, sem movimento, evento PendingReference na outbox', async () => {
    const clock = mutableClock(START);
    const w = await seedWallet(client, { balance: '100.00' });
    const res = await useCase(em, clock).execute(rollback(w, 'rb-1', 'bet-1', '25.00'));

    expect(res.status).toBe(WagerTransactionStatus.PendingReference);
    expect(res.failureCode).toBeUndefined();
    expect(await balanceOf(w.walletId)).toBe('100.00');
    const row = await client.query<{ status: string; reference_next_attempt_at: Date; reference_attempts: number; reference_transaction_id: string | null }>(
      "SELECT status, reference_next_attempt_at, reference_attempts, reference_transaction_id FROM wager_transactions WHERE external_transaction_id = 'rb-1'",
    );
    expect(row.rows[0]?.status).toBe('PENDING_REFERENCE');
    expect(row.rows[0]?.reference_attempts).toBe(0);
    expect(row.rows[0]?.reference_transaction_id).toBeNull();
    expect(row.rows[0]?.reference_next_attempt_at.getTime()).toBeGreaterThan(START.getTime());
    const events = await client.query<{ event_type: string }>("SELECT event_type FROM outbox_messages WHERE event_type = 'WagerTransactionPendingReference'");
    expect(events.rowCount).toBe(1);
    expect(await countRows(client, "SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1", [w.walletId])).toBe(1); // só o OPENING
  });

  it('antes do horário agendado, o worker não reivindica nada', async () => {
    const clock = mutableClock(START);
    const w = await seedWallet(client, { balance: '100.00' });
    await useCase(em, clock).execute(rollback(w, 'rb-early', 'bet-early', '25.00'));

    const stats = await worker(new MikroOrmWagerUnitOfWork(em), clock).runCycle(10);
    expect(stats.claimed).toBe(0);
  });

  it('BET chega depois: o worker resolve o ROLLBACK, restaura o saldo e não duplica no ciclo seguinte', async () => {
    const clock = mutableClock(START);
    const w = await seedWallet(client, { balance: '100.00' });
    const uc = useCase(em, clock);
    await uc.execute(rollback(w, 'rb-2', 'bet-2', '25.00'));
    await uc.execute(command({ walletId: w.walletId, playerId: w.playerId, amount: '25.00', externalTransactionId: 'bet-2' }));
    expect(await balanceOf(w.walletId)).toBe('75.00');

    const wk = worker(new MikroOrmWagerUnitOfWork(em), clock);
    clock.advance(ONE_HOUR);
    const first = await wk.runCycle(10);
    expect(first.resolved).toBe(1);
    expect(await balanceOf(w.walletId)).toBe('100.00');

    const second = await wk.runCycle(10);
    expect(second.claimed).toBe(0);
    expect(await balanceOf(w.walletId)).toBe('100.00');
    const status = await client.query<{ status: string; reference_transaction_id: string | null }>(
      "SELECT status, reference_transaction_id FROM wager_transactions WHERE external_transaction_id = 'rb-2'",
    );
    expect(status.rows[0]?.status).toBe('PROCESSED');
    expect(status.rows[0]?.reference_transaction_id).not.toBeNull();
    await assertLedgerInvariant(client, w.walletId);
  });

  it('a referência nunca chega: esgota as tentativas → REJECTED REFERENCE_NOT_FOUND e evento Rejected', async () => {
    const clock = mutableClock(START);
    const w = await seedWallet(client, { balance: '100.00' });
    await useCase(em, clock).execute(rollback(w, 'rb-never', 'bet-never', '25.00'));
    const wk = worker(new MikroOrmWagerUnitOfWork(em), clock);

    const totals = await drain(wk, clock);

    expect(totals.rescheduled).toBe(POLICY.maxAttempts - 1);
    expect(totals.expired).toBe(1);
    const row = await client.query<{ status: string; failure_code: string; reference_attempts: number }>(
      "SELECT status, failure_code, reference_attempts FROM wager_transactions WHERE external_transaction_id = 'rb-never'",
    );
    expect(row.rows[0]).toEqual({ status: 'REJECTED', failure_code: FailureCode.ReferenceNotFound, reference_attempts: POLICY.maxAttempts });
    const events = await client.query<{ event_type: string }>("SELECT event_type FROM outbox_messages WHERE event_type = 'WagerTransactionRejected'");
    expect(events.rowCount).toBe(1);
    expect(await balanceOf(w.walletId)).toBe('100.00');
    await assertLedgerInvariant(client, w.walletId);
  });

  it('TTL vence antes do limite de tentativas → expira na primeira consulta após o TTL', async () => {
    const clock = mutableClock(START);
    const shortTtl: ReferenceRetryPolicy = { ...POLICY, maxAttempts: 100, ttlMs: 10 * 60 * 1000 };
    const w = await seedWallet(client, { balance: '100.00' });
    await useCase(em, clock).execute(rollback(w, 'rb-ttl', 'bet-ttl', '25.00'));

    clock.advance(11 * 60 * 1000);
    const stats = await worker(new MikroOrmWagerUnitOfWork(em), clock, [], shortTtl).runCycle(10);

    expect(stats.expired).toBe(1);
    const row = await client.query<{ status: string; reference_attempts: number }>(
      "SELECT status, reference_attempts FROM wager_transactions WHERE external_transaction_id = 'rb-ttl'",
    );
    expect(row.rows[0]).toEqual({ status: 'REJECTED', reference_attempts: 1 });
  });

  it('ROLLBACK de REFUND pendente aguarda o REFUND e resolve na ordem certa', async () => {
    const clock = mutableClock(START);
    const w = await seedWallet(client, { balance: '100.00' });
    const uc = useCase(em, clock);
    await uc.execute(rollback(w, 'refund-p', 'bet-chain', '25.00', 'REFUND'));
    await uc.execute(rollback(w, 'rb-chain', 'refund-p', '25.00', 'ROLLBACK'));
    await uc.execute(command({ walletId: w.walletId, playerId: w.playerId, amount: '25.00', externalTransactionId: 'bet-chain' }));

    const totals = await drain(worker(new MikroOrmWagerUnitOfWork(em), clock), clock);

    expect(totals.failed).toBe(0);
    expect(await balanceOf(w.walletId)).toBe('75.00');
    const statuses = await client.query<{ external_transaction_id: string; status: string }>(
      "SELECT external_transaction_id, status FROM wager_transactions WHERE external_transaction_id IN ('refund-p', 'rb-chain')",
    );
    expect(statuses.rows.every((r) => r.status === 'PROCESSED')).toBe(true);
    await assertLedgerInvariant(client, w.walletId);
  });

  it('a referência chega com valor diferente → REJECTED AMOUNT_MISMATCH_ON_REVERSAL, sem movimento', async () => {
    const clock = mutableClock(START);
    const w = await seedWallet(client, { balance: '100.00' });
    await useCase(em, clock).execute(rollback(w, 'rb-amt', 'bet-amt', '25.00'));
    await useCase(em, clock).execute(command({ walletId: w.walletId, playerId: w.playerId, amount: '20.00', externalTransactionId: 'bet-amt' }));

    await drain(worker(new MikroOrmWagerUnitOfWork(em), clock), clock);

    const row = await client.query<{ status: string; failure_code: string }>(
      "SELECT status, failure_code FROM wager_transactions WHERE external_transaction_id = 'rb-amt'",
    );
    expect(row.rows[0]).toEqual({ status: 'REJECTED', failure_code: FailureCode.AmountMismatchOnReversal });
    expect(await balanceOf(w.walletId)).toBe('80.00');
    await assertLedgerInvariant(client, w.walletId);
  });

  it('ROLLBACK de WIN chega antes do WIN e o saldo já foi gasto → NEGATIVE_BALANCE_ON_REVERSAL', async () => {
    const clock = mutableClock(START);
    const w = await seedWallet(client, { balance: '0.00' });
    const uc = useCase(em, clock);
    await uc.execute(rollback(w, 'rb-win', 'win-late', '40.00'));
    await uc.execute(command({ walletId: w.walletId, playerId: w.playerId, kind: 'WIN', amount: '40.00', externalTransactionId: 'win-late' }));
    await uc.execute(command({ walletId: w.walletId, playerId: w.playerId, amount: '40.00', externalTransactionId: 'bet-spend' }));
    expect(await balanceOf(w.walletId)).toBe('0.00');

    await drain(worker(new MikroOrmWagerUnitOfWork(em), clock), clock);

    const row = await client.query<{ status: string; failure_code: string }>(
      "SELECT status, failure_code FROM wager_transactions WHERE external_transaction_id = 'rb-win'",
    );
    expect(row.rows[0]).toEqual({ status: 'REJECTED', failure_code: FailureCode.NegativeBalanceOnReversal });
    expect(await balanceOf(w.walletId)).toBe('0.00');
    await assertLedgerInvariant(client, w.walletId);
  });

  it('falha transitória em um item não bloqueia os demais; o item volta no ciclo seguinte', async () => {
    const clock = mutableClock(START);
    const a = await seedWallet(client, { balance: '100.00' });
    const b = await seedWallet(client, { balance: '100.00' });
    const uc = useCase(em, clock);
    await uc.execute(rollback(a, 'rb-a', 'bet-a', '10.00'));
    await uc.execute(rollback(b, 'rb-b', 'bet-b', '10.00'));
    await uc.execute(command({ walletId: a.walletId, playerId: a.playerId, amount: '10.00', externalTransactionId: 'bet-a' }));
    await uc.execute(command({ walletId: b.walletId, playerId: b.playerId, amount: '10.00', externalTransactionId: 'bet-b' }));

    const real = new MikroOrmWagerUnitOfWork(em);
    const flaky: WagerUnitOfWork = {
      run: (work) =>
        real.run((repos: WagerRepositories) =>
          work(
            new Proxy(repos, {
              get(target, prop, receiver) {
                if (prop === 'lockWallet') {
                  return async (walletId: string) => {
                    if (walletId === a.walletId) throw new TransientInfrastructureError('lock timeout simulado');
                    return target.lockWallet(walletId);
                  };
                }
                return Reflect.get(target, prop, receiver);
              },
            }) as WagerRepositories,
          ),
        ),
    };

    clock.advance(ONE_HOUR);
    const first = await worker(flaky, clock).runCycle(10);
    expect(first.failed).toBe(1);
    expect(first.resolved).toBe(1);
    const stillPending = await client.query("SELECT 1 FROM wager_transactions WHERE external_transaction_id = 'rb-a' AND status = 'PENDING_REFERENCE'");
    expect(stillPending.rowCount).toBe(1);

    const second = await worker(new MikroOrmWagerUnitOfWork(em), clock).runCycle(10);
    expect(second.resolved).toBe(1);
    await assertLedgerInvariant(client, a.walletId);
    await assertLedgerInvariant(client, b.walletId);
  });

  it('logs estruturados por tentativa, sem valores monetários', async () => {
    const clock = mutableClock(START);
    const w = await seedWallet(client, { balance: '100.00' });
    await useCase(em, clock).execute(rollback(w, 'rb-log', 'bet-log', '25.00'));
    const logs: WorkerLogEntry[] = [];
    clock.advance(ONE_HOUR);
    await worker(new MikroOrmWagerUnitOfWork(em), clock, logs).runCycle(10);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event: 'pending_reference_attempt', outcome: 'rescheduled', attempts: 1 });
    expect(JSON.stringify(logs)).not.toContain('25.00');
  });
});
