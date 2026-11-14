import { Migration } from '@mikro-orm/migrations';

/**
 * Saldo observado na decisão da transação (Etapa 3).
 * Necessário para o replay idempotente devolver o saldo daquele momento,
 * e não o saldo atual da wallet (regra 7 da seção 7 do enunciado).
 */
export class Migration20261114120300_observed_balance extends Migration {
  override async up(): Promise<void> {
    this.addSql('ALTER TABLE wager_transactions ADD COLUMN balance_observed numeric(19,2) NULL');
    this.addSql(
      'ALTER TABLE wager_transactions ADD CONSTRAINT wt_balance_observed_non_negative CHECK (balance_observed IS NULL OR balance_observed >= 0)',
    );
  }

  override async down(): Promise<void> {
    this.addSql('ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS wt_balance_observed_non_negative');
    this.addSql('ALTER TABLE wager_transactions DROP COLUMN IF EXISTS balance_observed');
  }
}
