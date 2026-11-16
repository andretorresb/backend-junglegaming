import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { createPgClient, createTestOrm, truncateAll } from '../integration/helpers/database';
import { assertLedgerInvariant, countRows, seedWallet } from '../integration/helpers/wagering';
import { startAppProcess, randomPort, type AppProcess } from '../support/app-process';
import type { MikroORM } from '@mikro-orm/postgresql';

/**
 * Três processos da aplicação, cada um com seu pool de conexões, falando com o mesmo PostgreSQL.
 * Requisições distribuídas entre eles ao mesmo tempo. Nenhuma coordenação entre os processos além do banco.
 */
describe('Concorrência — três processos da aplicação simultâneos', () => {
  let orm: MikroORM;
  let client: Client;
  const procs: AppProcess[] = [];

  beforeAll(async () => {
    orm = await createTestOrm();
    await orm.getMigrator().up();
    client = await createPgClient();
    const base = randomPort();
    for (let i = 0; i < 3; i++) procs.push(await startAppProcess(base + i * 2));
  }, 60_000);

  beforeEach(async () => {
    await truncateAll(client);
  });

  afterAll(async () => {
    for (const p of procs) await p.terminate().catch(() => undefined);
    await client.end();
    await orm.close();
  });

  const post = (proc: AppProcess, body: Record<string, unknown>, key: string) =>
    fetch(`${proc.base}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));

  const bet = (w: { walletId: string; playerId: string }, ext: string, amount: string) => ({
    providerId: 'provider-a',
    externalTransactionId: ext,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  });

  async function balanceOf(walletId: string): Promise<string> {
    const r = await client.query<{ balance: string }>('SELECT balance::text AS balance FROM wallets WHERE id = $1', [walletId]);
    return r.rows[0]?.balance ?? '';
  }

  it('30 apostas de 5.00 distribuídas entre os três processos sobre saldo 100.00 → 20 processadas, 10 rejeitadas, saldo 0.00', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => post(procs[i % 3]!, bet(w, `mp-${i}`, '5.00'), `mp-key-${i}`)),
    );

    expect(results.filter((r) => r.body['status'] === 'PROCESSED')).toHaveLength(20);
    expect(results.filter((r) => r.body['status'] === 'REJECTED')).toHaveLength(10);
    expect(await balanceOf(w.walletId)).toBe('0.00');
    expect(await countRows(client, "SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'", [w.walletId])).toBe(20);
    await assertLedgerInvariant(client, w.walletId);
  }, 120_000);

  it('50 requisições idênticas distribuídas entre os três processos → um único débito', async () => {
    const w = await seedWallet(client, { balance: '100.00' });
    const body = bet(w, 'same-across-processes', '25.00');
    const key = `provider-a:same-across-processes`;
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => post(procs[i % 3]!, body, key)));

    expect(new Set(results.map((r) => r.body['transactionId'])).size).toBe(1);
    expect(results.filter((r) => r.body['idempotentReplay'] === false)).toHaveLength(1);
    expect(await balanceOf(w.walletId)).toBe('75.00');
    expect(await countRows(client, "SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'", [w.walletId])).toBe(1);
    await assertLedgerInvariant(client, w.walletId);
  }, 120_000);

  it('wallets distintas em paralelo entre os processos → cada uma consistente', async () => {
    const wallets = await Promise.all(Array.from({ length: 6 }, () => seedWallet(client, { balance: '50.00' })));
    const calls = wallets.flatMap((w, wi) =>
      Array.from({ length: 5 }, (_, i) => post(procs[(wi + i) % 3]!, bet(w, `wx-${wi}-${i}`, '5.00'), randomUUID())),
    );
    const results = await Promise.all(calls);

    expect(results.every((r) => r.body['status'] === 'PROCESSED')).toBe(true);
    for (const w of wallets) {
      expect(await balanceOf(w.walletId)).toBe('25.00');
      await assertLedgerInvariant(client, w.walletId);
    }
  }, 120_000);
});
