import { Migration } from '@mikro-orm/migrations';

/**
 * Uma transação só pode ser revertida uma vez, independentemente de ser REFUND ou ROLLBACK.
 *
 * Interpretação deliberada da regra 4 do enunciado: a regra literal fala em "mesmo tipo de
 * operação". Permitir um REFUND e um ROLLBACK da mesma BET criaria dois créditos para um
 * único débito, o que o enunciado proíbe ("não pode duplicar créditos").
 *
 * Índice parcial: só vale para reversões PROCESSED. Uma reversão rejeitada não bloqueia outra.
 */
export class Migration20261114120400_single_reversal extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE UNIQUE INDEX wt_single_processed_reversal_uq
        ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED'
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP INDEX IF EXISTS wt_single_processed_reversal_uq');
  }
}
