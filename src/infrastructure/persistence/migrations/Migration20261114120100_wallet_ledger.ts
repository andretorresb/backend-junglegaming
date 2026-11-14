import { Migration } from '@mikro-orm/migrations';

/**
 * Ledger imutável.
 * - UPDATE e DELETE são bloqueados por trigger (imutabilidade no banco).
 * - No máximo um lançamento por (wallet, transação).
 * - Moeda do lançamento igual à moeda da wallet (FK composta).
 *
 * Nota: TRUNCATE não é bloqueado por trigger de linha. Testes limpam tabelas com TRUNCATE.
 */
export class Migration20261114120100_wallet_ledger extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id uuid PRIMARY KEY,
        wallet_id uuid NOT NULL,
        transaction_id uuid NOT NULL REFERENCES wager_transactions (id),
        direction text NOT NULL,
        amount numeric(19,2) NOT NULL,
        currency char(3) NOT NULL,
        balance_before numeric(19,2) NOT NULL,
        balance_after numeric(19,2) NOT NULL,
        created_at timestamptz NOT NULL,
        CONSTRAINT wle_wallet_currency_fk FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
        CONSTRAINT wle_wallet_transaction_uq UNIQUE (wallet_id, transaction_id),
        CONSTRAINT wle_direction_valid CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT wle_amount_positive CHECK (amount > 0),
        CONSTRAINT wle_balance_before_non_negative CHECK (balance_before >= 0),
        CONSTRAINT wle_balance_after_non_negative CHECK (balance_after >= 0),
        CONSTRAINT wle_currency_format CHECK (currency ~ '^[A-Z]{3}$')
      )
    `);

    this.addSql('CREATE INDEX wle_wallet_cursor_idx ON wallet_ledger_entries (wallet_id, created_at, id)');

    this.addSql(`
      CREATE FUNCTION wallet_ledger_entries_immutable() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is immutable: % is not allowed', TG_OP;
      END;
      $$
    `);

    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_no_update_delete
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_immutable()
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TRIGGER IF EXISTS wallet_ledger_entries_no_update_delete ON wallet_ledger_entries');
    this.addSql('DROP FUNCTION IF EXISTS wallet_ledger_entries_immutable()');
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries');
  }
}
