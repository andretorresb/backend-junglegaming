import { Migration } from '@mikro-orm/migrations';

/**
 * Índice da outbox na ordem em que o publisher lê (achado do teste de carga).
 *
 * O índice anterior começava por next_attempt_at e não servia ao ORDER BY occurred_at, id.
 * Com backlog de 80 mil eventos, cada reivindicação de lote ordenava todas as pendentes
 * (sort em disco, ~480 ms por lote de 10). Com este índice, a leitura é uma varredura
 * de índice que para no LIMIT (~0,1 ms), e a consulta de lag também passa a usá-lo.
 */
export class Migration20261116120000_outbox_pending_order extends Migration {
  override async up(): Promise<void> {
    this.addSql('CREATE INDEX outbox_pending_order_idx ON outbox_messages (occurred_at, id) WHERE published_at IS NULL');
    this.addSql('DROP INDEX IF EXISTS outbox_pending_idx');
  }

  override async down(): Promise<void> {
    this.addSql(
      'CREATE INDEX outbox_pending_idx ON outbox_messages (next_attempt_at, occurred_at, id) WHERE published_at IS NULL',
    );
    this.addSql('DROP INDEX IF EXISTS outbox_pending_order_idx');
  }
}
