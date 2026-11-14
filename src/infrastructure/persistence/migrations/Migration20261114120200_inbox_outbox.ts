import { Migration } from '@mikro-orm/migrations';

/**
 * Inbox (deduplicação de mensagens consumidas) e outbox (eventos a publicar).
 * Usadas nas Etapas 7 e 8; criadas aqui para que o schema seja completo desde a Etapa 2.
 */
export class Migration20261114120200_inbox_outbox extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text NOT NULL,
        message_id text NOT NULL,
        payload_hash char(64) NOT NULL,
        received_at timestamptz NOT NULL,
        processed_at timestamptz NULL,
        PRIMARY KEY (consumer_name, message_id)
      )
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id uuid PRIMARY KEY,
        aggregate_id uuid NOT NULL,
        event_type text NOT NULL,
        payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NULL,
        published_at timestamptz NULL,
        CONSTRAINT outbox_attempts_non_negative CHECK (attempts >= 0),
        CONSTRAINT outbox_payload_is_object CHECK (jsonb_typeof(payload) = 'object')
      )
    `);

    this.addSql(
      'CREATE INDEX outbox_pending_idx ON outbox_messages (next_attempt_at, occurred_at, id) WHERE published_at IS NULL',
    );
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS outbox_messages');
    this.addSql('DROP TABLE IF EXISTS inbox_messages');
  }
}
