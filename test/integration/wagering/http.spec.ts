import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { Client } from 'pg';
import config from '../../../mikro-orm.config';
import { WagerModule } from '../../../src/interfaces/http/wagering/wagering.module';
import { createPgClient, TEST_DB_NAME, truncateAll } from '../helpers/database';
import { seedWallet, assertLedgerInvariant } from '../helpers/wagering';

/**
 * Contrato HTTP de POST /wagering/transactions e das consultas.
 * Sobe o módulo Nest real contra o PostgreSQL de teste.
 */
describe('HTTP — POST /wagering/transactions e consultas', () => {
  let app: INestApplication;
  let client: Client;
  let base: string;

  beforeAll(async () => {
    // Sem agendamento automático: o worker é exercitado diretamente nos testes de referência pendente.
    process.env['PENDING_REFERENCE_POLL_MS'] = '0';
    const moduleRef = await Test.createTestingModule({
      imports: [MikroOrmModule.forRoot({ ...config, dbName: TEST_DB_NAME }), WagerModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    base = `http://127.0.0.1:${address.port}`;
    await app.get(MikroORM).getMigrator().up();
    client = await createPgClient();
  });

  beforeEach(async () => {
    await truncateAll(client);
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  async function post(body: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${base}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown>, headers: response.headers };
  }

  function betBody(walletId: string, playerId: string, extra: Record<string, unknown> = {}) {
    return {
      providerId: 'provider-a',
      externalTransactionId: `transaction-${randomUUID()}`,
      playerId,
      walletId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      ...extra,
    };
  }

  it('BET aprovada → 200 PROCESSED com saldo atualizado', async () => {
    const w = await seedWallet(client, { balance: '1000.00' });
    const body = betBody(w.walletId, w.playerId, { externalTransactionId: 'transaction-123' });
    const res = await post(body, { 'idempotency-key': 'provider-a:transaction-123' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
      failureCode: null,
    });
    expect(typeof res.body['transactionId']).toBe('string');
    await assertLedgerInvariant(client, w.walletId);
  });

  it('repetir a mesma requisição → 200 com idempotentReplay true e mesmo transactionId', async () => {
    const w = await seedWallet(client, { balance: '1000.00' });
    const body = betBody(w.walletId, w.playerId);
    const headers = { 'idempotency-key': 'k-replay' };
    const first = await post(body, headers);
    const second = await post(body, headers);

    expect(second.status).toBe(200);
    expect(second.body['idempotentReplay']).toBe(true);
    expect(second.body['transactionId']).toBe(first.body['transactionId']);
    await assertLedgerInvariant(client, w.walletId);
  });

  it('saldo insuficiente → 422 REJECTED com failureCode INSUFFICIENT_BALANCE', async () => {
    const w = await seedWallet(client, { balance: '10.00' });
    const res = await post(betBody(w.walletId, w.playerId), { 'idempotency-key': 'k-poor' });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_BALANCE', balance: { amount: '10.00', currency: 'BRL' } });
  });

  it('replay de rejeição devolve 422 novamente', async () => {
    const w = await seedWallet(client, { balance: '10.00' });
    const body = betBody(w.walletId, w.playerId);
    await post(body, { 'idempotency-key': 'k-poor-2' });
    const replay = await post(body, { 'idempotency-key': 'k-poor-2' });

    expect(replay.status).toBe(422);
    expect(replay.body['idempotentReplay']).toBe(true);
  });

  it('mesma chave com payload diferente → 409 IDEMPOTENCY_CONFLICT', async () => {
    const w = await seedWallet(client, { balance: '1000.00' });
    const body = betBody(w.walletId, w.playerId);
    await post(body, { 'idempotency-key': 'k-conflict' });
    const res = await post({ ...body, money: { amount: '99.00', currency: 'BRL' } }, { 'idempotency-key': 'k-conflict' });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', failureCode: 'IDEMPOTENCY_CONFLICT' });
  });

  it('header Idempotency-Key ausente → 400', async () => {
    const w = await seedWallet(client, { balance: '1000.00' });
    const res = await post(betBody(w.walletId, w.playerId));
    expect(res.status).toBe(400);
    expect(res.body['code']).toBe('INVALID_PAYLOAD');
  });

  it('Idempotency-Key com mais de 255 caracteres → 400', async () => {
    const w = await seedWallet(client, { balance: '1000.00' });
    const res = await post(betBody(w.walletId, w.playerId), { 'idempotency-key': 'k'.repeat(256) });
    expect(res.status).toBe(400);
  });

  it('valor em notação científica → 400 pela validação do DTO', async () => {
    const w = await seedWallet(client, { balance: '1000.00' });
    const res = await post(betBody(w.walletId, w.playerId, { money: { amount: '1e3', currency: 'BRL' } }), {
      'idempotency-key': 'k-sci',
    });
    expect(res.status).toBe(400);
  });

  it('valor negativo → 400', async () => {
    const w = await seedWallet(client, { balance: '1000.00' });
    const res = await post(betBody(w.walletId, w.playerId, { money: { amount: '-1.00', currency: 'BRL' } }), {
      'idempotency-key': 'k-neg',
    });
    expect(res.status).toBe(400);
  });

  it('campo desconhecido no body → 400 (forbidNonWhitelisted)', async () => {
    const w = await seedWallet(client, { balance: '1000.00' });
    const res = await post(betBody(w.walletId, w.playerId, { balance: '999999.00' }), { 'idempotency-key': 'k-extra' });
    expect(res.status).toBe(400);
  });

  it('kind OPENING → 400 (interno)', async () => {
    const w = await seedWallet(client, { balance: '1000.00' });
    const res = await post(betBody(w.walletId, w.playerId, { kind: 'OPENING' }), { 'idempotency-key': 'k-open' });
    expect(res.status).toBe(400);
    expect(res.body['code']).toBe('INTERNAL_ONLY_KIND');
  });

  it('REFUND sem referência ainda → 202 PENDING_REFERENCE (Etapa 5)', async () => {
    const w = await seedWallet(client, { balance: '1000.00' });
    const res = await post(
      betBody(w.walletId, w.playerId, { kind: 'REFUND', referenceExternalTransactionId: 'bet-missing' }),
      { 'idempotency-key': 'k-refund' },
    );
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'PENDING_REFERENCE', failureCode: null });
  });

  it('REFUND sem referenceExternalTransactionId → 400', async () => {
    const w = await seedWallet(client, { balance: '1000.00' });
    const res = await post(betBody(w.walletId, w.playerId, { kind: 'REFUND' }), { 'idempotency-key': 'k-refund-2' });
    expect(res.status).toBe(400);
  });

  it('wallet inexistente → 404', async () => {
    const res = await post(betBody(randomUUID(), randomUUID()), { 'idempotency-key': 'k-404' });
    expect(res.status).toBe(404);
    expect(res.body['code']).toBe('WALLET_NOT_FOUND');
  });

  it('moeda diferente da wallet → 422 CURRENCY_MISMATCH, sem persistir', async () => {
    const w = await seedWallet(client, { balance: '1000.00' });
    const res = await post(betBody(w.walletId, w.playerId, { money: { amount: '1.00', currency: 'USD' } }), {
      'idempotency-key': 'k-cur',
    });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'CURRENCY_MISMATCH' });
  });

  it('wallet travada além do lock_timeout → 503 com Retry-After', async () => {
    const w = await seedWallet(client, { balance: '1000.00' });
    const holder = await createPgClient();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [w.walletId]);
      const res = await post(betBody(w.walletId, w.playerId), { 'idempotency-key': 'k-busy' });
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('1');
      await holder.query('ROLLBACK');
    } finally {
      await holder.end();
    }
  }, 20_000);

  it('GET /wagering/transactions/:id → 200 com o resultado persistido', async () => {
    const w = await seedWallet(client, { balance: '1000.00' });
    const created = await post(betBody(w.walletId, w.playerId, { externalTransactionId: 'get-me' }), {
      'idempotency-key': 'k-get',
    });
    const res = await fetch(`${base}/wagering/transactions/${created.body['transactionId']}`);
    expect(res.status).toBe(200);
    const view = (await res.json()) as Record<string, unknown>;
    expect(view).toMatchObject({ externalTransactionId: 'get-me', status: 'PROCESSED', kind: 'BET' });
  });

  it('GET /wagering/transactions/:id inexistente → 404', async () => {
    const res = await fetch(`${base}/wagering/transactions/${randomUUID()}`);
    expect(res.status).toBe(404);
  });

  it('GET /providers/:providerId/wagering/transactions/:externalTransactionId → 200', async () => {
    const w = await seedWallet(client, { balance: '1000.00' });
    await post(betBody(w.walletId, w.playerId, { externalTransactionId: 'by-provider' }), { 'idempotency-key': 'k-prov' });
    const res = await fetch(`${base}/providers/provider-a/wagering/transactions/by-provider`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { externalTransactionId: string }).externalTransactionId).toBe('by-provider');
  });
});
