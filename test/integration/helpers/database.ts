import { MikroORM } from '@mikro-orm/postgresql';
import { Client } from 'pg';
import config from '../../../mikro-orm.config';
import { loadEnv } from '../../../src/config/env';

/**
 * Banco dedicado aos testes de integração. Nunca usa o banco de desenvolvimento.
 * Pode ser trocado por TEST_DB_NAME.
 */
export const TEST_DB_NAME = process.env['TEST_DB_NAME'] ?? 'junglegaming_test';

const env = loadEnv();
const connection = {
  host: env.database.host,
  port: env.database.port,
  user: env.database.user,
  password: env.database.password,
};

let ensured: Promise<void> | undefined;

/** Cria o banco de teste se ele não existir. */
export function ensureTestDatabase(): Promise<void> {
  ensured ??= (async () => {
    const admin = new Client({ ...connection, database: 'postgres' });
    await admin.connect();
    try {
      const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB_NAME]);
      if (exists.rowCount === 0) {
        await admin.query(`CREATE DATABASE "${TEST_DB_NAME}"`);
      }
    } finally {
      await admin.end();
    }
  })();
  return ensured;
}

/** ORM apontando para o banco de teste. Chame `orm.close()` ao final. */
export async function createTestOrm(): Promise<MikroORM> {
  await ensureTestDatabase();
  return MikroORM.init({ ...config, dbName: TEST_DB_NAME, discovery: { warnWhenNoEntities: true } });
}

/** Cliente pg direto: usado nos testes de constraint para inspecionar códigos de erro do PostgreSQL. */
export async function createPgClient(): Promise<Client> {
  await ensureTestDatabase();
  const client = new Client({ ...connection, database: TEST_DB_NAME });
  await client.connect();
  return client;
}

/** Esvazia todas as tabelas de domínio. TRUNCATE não é bloqueado pela trigger de linha do ledger. */
export async function truncateAll(client: Client): Promise<void> {
  await client.query(
    'TRUNCATE wallet_ledger_entries, wager_transactions, wallets, inbox_messages, outbox_messages RESTART IDENTITY CASCADE',
  );
}
