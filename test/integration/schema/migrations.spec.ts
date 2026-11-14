import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Client } from 'pg';
import { createPgClient, createTestOrm } from '../helpers/database';

const DOMAIN_TABLES = ['inbox_messages', 'outbox_messages', 'wager_transactions', 'wallet_ledger_entries', 'wallets'];

async function publicTables(client: Client): Promise<string[]> {
  const result = await client.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'mikro_orm_migrations' ORDER BY tablename",
  );
  return result.rows.map((row) => row.tablename);
}

async function triggerExists(client: Client): Promise<boolean> {
  const result = await client.query(
    "SELECT 1 FROM pg_trigger WHERE tgname = 'wallet_ledger_entries_no_update_delete'",
  );
  return (result.rowCount ?? 0) > 0;
}

describe('Migrations — ciclo completo', () => {
  let orm: MikroORM;
  let client: Client;

  beforeAll(async () => {
    orm = await createTestOrm();
    client = await createPgClient();
  });

  afterAll(async () => {
    // Deixa o banco de teste no estado migrado para as demais suítes.
    await orm.getMigrator().up();
    await client.end();
    await orm.close();
  });

  it('sobe do zero: cria todas as tabelas de domínio e a trigger do ledger', async () => {
    await orm.getMigrator().down({ to: 0 });
    expect(await publicTables(client)).toEqual([]);

    await orm.getMigrator().up();
    expect(await publicTables(client)).toEqual(DOMAIN_TABLES);
    expect(await triggerExists(client)).toBe(true);
  });

  it('down reverte tudo, inclusive trigger e função', async () => {
    await orm.getMigrator().down({ to: 0 });

    expect(await publicTables(client)).toEqual([]);
    expect(await triggerExists(client)).toBe(false);
    const fn = await client.query("SELECT 1 FROM pg_proc WHERE proname = 'wallet_ledger_entries_immutable'");
    expect(fn.rowCount).toBe(0);
  });

  it('up após down volta ao mesmo schema', async () => {
    await orm.getMigrator().up();
    expect(await publicTables(client)).toEqual(DOMAIN_TABLES);
    expect(await triggerExists(client)).toBe(true);
  });

  it('a migration pendente é zero após up', async () => {
    expect(await orm.getMigrator().getPendingMigrations()).toEqual([]);
  });
});
