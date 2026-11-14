import { Migration } from '@mikro-orm/migrations';

/**
 * Wallets e transações de wagering.
 * Garantias no banco (seção 5, item 9 do enunciado):
 * - unicidade (player, currency) em wallets;
 * - saldo nunca negativo;
 * - idempotência persistente: UNIQUE(idempotency_key) e UNIQUE(provider, external_transaction_id);
 * - moeda da transação igual à moeda da wallet (FK composta).
 */
export class Migration20261114120000_wallets_and_transactions extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id uuid PRIMARY KEY,
        player_id uuid NOT NULL,
        currency char(3) NOT NULL,
        balance numeric(19,2) NOT NULL,
        version integer NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        CONSTRAINT wallets_player_currency_uq UNIQUE (player_id, currency),
        CONSTRAINT wallets_id_currency_uq UNIQUE (id, currency),
        CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT wallets_version_positive CHECK (version >= 1),
        CONSTRAINT wallets_currency_format CHECK (currency ~ '^[A-Z]{3}$')
      )
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY,
        provider_id text NOT NULL,
        external_transaction_id text NOT NULL,
        idempotency_key text NOT NULL,
        payload_hash char(64) NOT NULL,
        wallet_id uuid NOT NULL,
        player_id uuid NOT NULL,
        round_id text NOT NULL,
        game_id text NOT NULL,
        kind text NOT NULL,
        amount numeric(19,2) NOT NULL,
        currency char(3) NOT NULL,
        reference_external_transaction_id text NULL,
        reference_transaction_id uuid NULL REFERENCES wager_transactions (id),
        status text NOT NULL,
        failure_code text NULL,
        created_at timestamptz NOT NULL,
        processed_at timestamptz NULL,
        CONSTRAINT wt_provider_external_uq UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wt_idempotency_key_uq UNIQUE (idempotency_key),
        CONSTRAINT wt_wallet_currency_fk FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
        CONSTRAINT wt_amount_positive CHECK (amount > 0),
        CONSTRAINT wt_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wt_kind_valid CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT wt_status_valid CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        CONSTRAINT wt_reference_required CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wt_reference_only_for_reversal CHECK (kind IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NULL)
      )
    `);

    this.addSql('CREATE INDEX wt_wallet_id_idx ON wager_transactions (wallet_id)');
    this.addSql('CREATE INDEX wt_provider_reference_idx ON wager_transactions (provider_id, reference_external_transaction_id)');
    this.addSql(
      "CREATE INDEX wt_pending_reference_idx ON wager_transactions (status, created_at) WHERE status = 'PENDING_REFERENCE'",
    );
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS wager_transactions');
    this.addSql('DROP TABLE IF EXISTS wallets');
  }
}
