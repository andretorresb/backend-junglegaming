import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { Client } from 'pg';
import config from '../../../mikro-orm.config';
import { WagerModule } from '../../../src/interfaces/http/wagering/wagering.module';
import { METRICS } from '../../../src/interfaces/http/wagering/wagering.tokens';
import { RECONCILIATION_DIVERGENCE_METRIC } from '../../../src/infrastructure/persistence/wallet.queries';
import { MetricsRegistry } from '../../../src/infrastructure/observability/metrics-registry';
import { encodeCursor } from '../../../src/interfaces/http/wallets/cursor';
import { createPgClient, TEST_DB_NAME, truncateAll } from '../helpers/database';
import { assertLedgerInvariant, command, seedWallet, useCase } from '../helpers/wagering';
import type { EntityManager } from '@mikro-orm/core';

describe('HTTP — consultas de wallet, ledger e reconciliação', () => {
  let app: INestApplication;
  let client: Client;
  let base: string;
  let em: EntityManager;

  beforeAll(async () => {
    process.env['PENDING_REFERENCE_POLL_MS'] = '0';
    const moduleRef = await Test.createTestingModule({
      imports: [MikroOrmModule.forRoot({ ...config, dbName: TEST_DB_NAME }), WagerModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
    const orm = app.get(MikroORM);
    await orm.getMigrator().up();
    em = orm.em;
    client = await createPgClient();
  });

  beforeEach(async () => {
    await truncateAll(client);
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  async function fillLedger(w: { walletId: string; playerId: string }, count: number, prefix = 'win') {
    const uc = useCase(em);
    for (let i = 0; i < count; i++) {
      await uc.execute(command({ walletId: w.walletId, playerId: w.playerId, kind: 'WIN', amount: '1.00', externalTransactionId: `${prefix}-${i}-${randomUUID()}` }));
    }
  }

  describe('GET /wallets/:walletId', () => {
    it('200 com saldo e versão', async () => {
      const w = await seedWallet(client, { balance: '250.00' });
      const res = await get(`/wallets/${w.walletId}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: w.walletId, playerId: w.playerId, currency: 'BRL', balance: { amount: '250.00', currency: 'BRL' }, version: 1 });
    });

    it('404 para wallet inexistente e para id que não é UUID', async () => {
      expect((await get(`/wallets/${randomUUID()}`)).status).toBe(404);
      expect((await get('/wallets/nao-e-uuid')).status).toBe(404);
    });
  });

  describe('GET /wallets/:walletId/ledger', () => {
    it('pagina em ordem cronológica, sem repetir e sem pular, com limite de 50 por padrão', async () => {
      const w = await seedWallet(client, { balance: '0.00' });
      await fillLedger(w, 120);

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
        const res = await get(`/wallets/${w.walletId}/ledger${query}`);
        expect(res.status).toBe(200);
        const items = res.body['items'] as Array<{ id: string }>;
        expect(items.length).toBeLessThanOrEqual(50);
        seen.push(...items.map((i) => i.id));
        cursor = res.body['nextCursor'] as string | null;
        pages += 1;
      } while (cursor !== null);

      expect(pages).toBe(3);
      expect(seen).toHaveLength(120); // saldo inicial zero: sem OPENING, só os 120 WIN
      expect(new Set(seen).size).toBe(seen.length);
    });

    it('limit explícito é respeitado; limites fora de 1..100 são 400', async () => {
      const w = await seedWallet(client, { balance: '0.00' });
      await fillLedger(w, 5);
      const res = await get(`/wallets/${w.walletId}/ledger?limit=2`);
      expect((res.body['items'] as unknown[]).length).toBe(2);
      expect(res.body['nextCursor']).not.toBeNull();

      for (const bad of ['0', '101', 'abc', '1.5']) {
        expect((await get(`/wallets/${w.walletId}/ledger?limit=${bad}`)).status).toBe(400);
      }
    });

    it('cursor adulterado ou malformado é 400', async () => {
      const w = await seedWallet(client, { balance: '0.00' });
      expect((await get(`/wallets/${w.walletId}/ledger?cursor=lixo`)).status).toBe(400);
      const forged = Buffer.from(JSON.stringify({ t: 'não-é-data', i: randomUUID() })).toString('base64url');
      expect((await get(`/wallets/${w.walletId}/ledger?cursor=${forged}`)).status).toBe(400);
    });

    it('paginação estável com inserções concorrentes: nenhum item original repetido ou perdido', async () => {
      const w = await seedWallet(client, { balance: '0.00' });
      await fillLedger(w, 30);
      const original = (await client.query<{ id: string }>('SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1', [w.walletId])).rows.map((r) => r.id);

      const seen: string[] = [];
      const first = await get(`/wallets/${w.walletId}/ledger?limit=10`);
      seen.push(...(first.body['items'] as Array<{ id: string }>).map((i) => i.id));
      await fillLedger(w, 20, 'late');
      let cursor = first.body['nextCursor'] as string | null;
      while (cursor !== null) {
        const page = await get(`/wallets/${w.walletId}/ledger?limit=10&cursor=${encodeURIComponent(cursor)}`);
        seen.push(...(page.body['items'] as Array<{ id: string }>).map((i) => i.id));
        cursor = page.body['nextCursor'] as string | null;
      }

      expect(new Set(seen).size).toBe(seen.length);
      for (const id of original) expect(seen).toContain(id);
    });

    it('wallet inexistente → 404', async () => {
      expect((await get(`/wallets/${randomUUID()}/ledger`)).status).toBe(404);
    });

    it('cursor codificado com encodeCursor é aceito', async () => {
      const w = await seedWallet(client, { balance: '0.00' });
      const cursor = encodeCursor({ createdAt: new Date('2000-01-01T00:00:00.000Z'), id: randomUUID() });
      const res = await get(`/wallets/${w.walletId}/ledger?cursor=${encodeURIComponent(cursor)}`);
      expect(res.status).toBe(200);
    });
  });

  describe('POST /wallets/:walletId/reconciliation', () => {
    it('consistente: calcula pelo ledger e responde o contrato do enunciado', async () => {
      const w = await seedWallet(client, { balance: '100.00' });
      await fillLedger(w, 3);
      const res = await fetch(`${base}/wallets/${w.walletId}/reconciliation`, { method: 'POST' });
      const body = (await res.json()) as Record<string, unknown>;

      expect(res.status).toBe(200);
      expect(body).toEqual({
        walletId: w.walletId,
        storedBalance: { amount: '103.00', currency: 'BRL' },
        calculatedBalance: { amount: '103.00', currency: 'BRL' },
        difference: { amount: '0.00', currency: 'BRL' },
        consistent: true,
        checkedEntries: 4,
      });
    });

    it('ignora saldos enviados pelo cliente', async () => {
      const w = await seedWallet(client, { balance: '100.00' });
      const res = await fetch(`${base}/wallets/${w.walletId}/reconciliation`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ storedBalance: { amount: '999999.00', currency: 'BRL' }, consistent: true }),
      });
      const body = (await res.json()) as { storedBalance: { amount: string } };
      expect(res.status).toBe(200);
      expect(body.storedBalance.amount).toBe('100.00');
    });

    it('divergência: não corrige, sinaliza na resposta e conta em métrica', async () => {
      const w = await seedWallet(client, { balance: '100.00' });
      await fillLedger(w, 2);
      // saldo armazenado adulterado por fora do domínio
      await client.query("UPDATE wallets SET balance = balance + 7 WHERE id = $1", [w.walletId]);
      const metrics = app.get<MetricsRegistry>(METRICS);
      const before = metrics.value(RECONCILIATION_DIVERGENCE_METRIC);

      const res = await fetch(`${base}/wallets/${w.walletId}/reconciliation`, { method: 'POST' });
      const body = (await res.json()) as { consistent: boolean; difference: { amount: string } };

      expect(body.consistent).toBe(false);
      expect(body.difference.amount).toBe('7.00');
      expect(metrics.value(RECONCILIATION_DIVERGENCE_METRIC)).toBe(before + 1);
      // não corrigido
      const stored = await client.query<{ balance: string }>('SELECT balance::text AS balance FROM wallets WHERE id = $1', [w.walletId]);
      expect(stored.rows[0]?.balance).toBe('109.00');
    });

    it('wallet inexistente → 404', async () => {
      const res = await fetch(`${base}/wallets/${randomUUID()}/reconciliation`, { method: 'POST' });
      expect(res.status).toBe(404);
    });

    it('o invariante fecha após operações reais', async () => {
      const w = await seedWallet(client, { balance: '50.00' });
      await fillLedger(w, 5);
      await assertLedgerInvariant(client, w.walletId);
    });
  });
});
