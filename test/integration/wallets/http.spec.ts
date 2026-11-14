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

describe('HTTP — POST /wallets', () => {
  let app: INestApplication;
  let client: Client;
  let base: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MikroOrmModule.forRoot({ ...config, dbName: TEST_DB_NAME }), WagerModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
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

  const post = async (body: unknown) => {
    const res = await fetch(`${base}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('saldo inicial positivo → 201 com id, saldo e versão 1', async () => {
    const playerId = randomUUID();
    const res = await post({ playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ playerId, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
    expect(typeof res.body['id']).toBe('string');
  });

  it('saldo zero → 201', async () => {
    const res = await post({ playerId: randomUUID(), initialBalance: { amount: '0.00', currency: 'BRL' } });
    expect(res.status).toBe(201);
  });

  it('mesmo jogador e moeda de novo → 409 DUPLICATE_WALLET', async () => {
    const playerId = randomUUID();
    await post({ playerId, initialBalance: { amount: '1.00', currency: 'BRL' } });
    const res = await post({ playerId, initialBalance: { amount: '1.00', currency: 'BRL' } });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'DUPLICATE_WALLET', failureCode: 'DUPLICATE_WALLET' });
  });

  it('saldo negativo → 400', async () => {
    const res = await post({ playerId: randomUUID(), initialBalance: { amount: '-1.00', currency: 'BRL' } });
    expect(res.status).toBe(400);
  });

  it('playerId que não é UUID → 400', async () => {
    const res = await post({ playerId: 'nao-uuid', initialBalance: { amount: '1.00', currency: 'BRL' } });
    expect(res.status).toBe(400);
  });

  it('campo desconhecido → 400', async () => {
    const res = await post({ playerId: randomUUID(), initialBalance: { amount: '1.00', currency: 'BRL' }, id: 'forçado' });
    expect(res.status).toBe(400);
  });
});
