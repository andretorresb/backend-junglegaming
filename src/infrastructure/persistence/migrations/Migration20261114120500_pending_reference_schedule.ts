import { Migration } from '@mikro-orm/migrations';

/**
 * Agendamento de transações PENDING_REFERENCE (Etapa 5).
 * - reference_attempts: consultas sem sucesso à referência;
 * - reference_next_attempt_at: quando reprocessar. Obrigatório enquanto pendente.
 */
export class Migration20261114120500_pending_reference_schedule extends Migration {
  override async up(): Promise<void> {
    this.addSql('ALTER TABLE wager_transactions ADD COLUMN reference_attempts integer NOT NULL DEFAULT 0');
    this.addSql('ALTER TABLE wager_transactions ADD COLUMN reference_next_attempt_at timestamptz NULL');
    this.addSql(
      'ALTER TABLE wager_transactions ADD CONSTRAINT wt_reference_attempts_non_negative CHECK (reference_attempts >= 0)',
    );
    this.addSql(`
      ALTER TABLE wager_transactions ADD CONSTRAINT wt_pending_has_schedule
        CHECK (status <> 'PENDING_REFERENCE' OR reference_next_attempt_at IS NOT NULL)
    `);
    this.addSql(`
      CREATE INDEX wt_pending_due_idx ON wager_transactions (reference_next_attempt_at, id)
        WHERE status = 'PENDING_REFERENCE'
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP INDEX IF EXISTS wt_pending_due_idx');
    this.addSql('ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS wt_pending_has_schedule');
    this.addSql('ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS wt_reference_attempts_non_negative');
    this.addSql('ALTER TABLE wager_transactions DROP COLUMN IF EXISTS reference_next_attempt_at');
    this.addSql('ALTER TABLE wager_transactions DROP COLUMN IF EXISTS reference_attempts');
  }
}
