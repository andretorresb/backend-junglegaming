import type { MetricsRegistry } from './metrics-registry';

/**
 * Declara as séries obrigatórias com valor zero no startup. Sem isso, uma métrica que ainda não
 * teve evento não aparece em /metrics, e painéis e alertas ficam sem dado.
 */
export function preregisterMetrics(metrics: MetricsRegistry): MetricsRegistry {
  metrics.increment('dlq_messages_total', {}, 0);
  metrics.increment('lock_conflicts_total', {}, 0);
  metrics.increment('reconciliation_divergence_total', {}, 0);
  metrics.increment('outbox_published_total', {}, 0);
  metrics.increment('outbox_publish_failed_total', {}, 0);
  metrics.increment('sqs_messages_received_total', {}, 0);
  metrics.increment('sqs_messages_acked_total', {}, 0);
  for (const component of ['sqs', 'outbox', 'pending_reference']) {
    metrics.increment('retries_total', { component }, 0);
  }
  for (const source of ['http', 'sqs']) {
    metrics.increment('duplicates_detected_total', { source }, 0);
  }
  metrics.set('outbox_lag_seconds', 0);
  for (const kind of ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']) {
    for (const status of ['PROCESSED', 'REJECTED', 'PENDING_REFERENCE']) {
      metrics.increment('wagering_transactions_total', { kind, status }, 0);
    }
  }
  return metrics;
}
