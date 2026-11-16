import { DEFAULT_OUTBOX_RETRY_POLICY, type OutboxRetryPolicy } from '../../domain/outbox/outbox-message';
import type { Clock } from '../ports/clock';
import type { EventPublisher } from '../ports/event-publisher';
import type { Logger, Metrics } from '../ports/observability';
import type { OutboxRepositories, OutboxUnitOfWork } from './ports';

export const OUTBOX_PUBLISHED_METRIC = 'outbox_published_total';
export const OUTBOX_PUBLISH_FAILED_METRIC = 'outbox_publish_failed_total';
export const OUTBOX_LAG_METRIC = 'outbox_lag_seconds';

export interface OutboxPublisherCycleStats {
  claimed: number;
  published: number;
  failed: number;
}

export interface OutboxPublisherOptions {
  retryPolicy: OutboxRetryPolicy;
}

/**
 * Publica eventos pendentes da outbox (seção 11 do enunciado).
 *
 * Cada mensagem é tratada em uma transação própria: reivindica (SKIP LOCKED), publica e marca.
 * Falha de publicação conta a tentativa e agenda a próxima, com backoff. Vários publishers
 * podem rodar em paralelo sem pegar a mesma mensagem.
 *
 * Semântica: at-least-once. Se o processo morrer depois de publicar e antes do commit, a
 * mensagem continua pendente e será publicada de novo, com o mesmo `eventId`.
 */
export class OutboxPublisherWorker {
  constructor(
    private readonly uow: OutboxUnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
    private readonly options: OutboxPublisherOptions = { retryPolicy: DEFAULT_OUTBOX_RETRY_POLICY },
  ) {}

  async runCycle(batchSize: number): Promise<OutboxPublisherCycleStats> {
    const stats: OutboxPublisherCycleStats = { claimed: 0, published: 0, failed: 0 };
    const excluded: string[] = [];

    for (let i = 0; i < batchSize; i++) {
      const claim: { id?: string } = {};
      try {
        const outcome = await this.uow.run((repos) => this.publishOne(repos, excluded, (id) => (claim.id = id)));
        if (outcome === undefined) break;
        stats.claimed += 1;
        if (outcome === 'published') stats.published += 1;
        else stats.failed += 1;
      } catch (error) {
        stats.failed += 1;
        if (claim.id !== undefined) excluded.push(claim.id);
        this.metrics.increment(OUTBOX_PUBLISH_FAILED_METRIC);
        this.logger.error('outbox_publish_error', {
          messageId: claim.id ?? null,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await this.reportLag();
    return stats;
  }

  private async publishOne(
    repos: OutboxRepositories,
    excluded: readonly string[],
    onClaim: (id: string) => void,
  ): Promise<'published' | 'failed' | undefined> {
    const now = this.clock.now();
    const message = await repos.claimDueOutbox(now, excluded);
    if (!message) return undefined;
    onClaim(message.id);

    try {
      await this.publisher.publish({
        eventId: message.id,
        eventType: message.eventType,
        body: JSON.stringify(message.payload),
      });
    } catch (error) {
      message.scheduleRetry(now, this.options.retryPolicy);
      await repos.updateOutbox(message);
      this.metrics.increment(OUTBOX_PUBLISH_FAILED_METRIC);
      this.metrics.increment('retries_total', { component: 'outbox' });
      this.logger.error('outbox_publish_failed', {
        messageId: message.id,
        eventType: message.eventType,
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt?.toISOString() ?? null,
        reason: error instanceof Error ? error.message : String(error),
      });
      return 'failed';
    }

    message.markPublished(now);
    await repos.updateOutbox(message);
    this.metrics.increment(OUTBOX_PUBLISHED_METRIC, { eventType: message.eventType });
    return 'published';
  }

  /** Lag = idade, em segundos, da mensagem pendente mais antiga. Zero quando não há pendências. */
  private async reportLag(): Promise<void> {
    const oldest = await this.uow.run((repos) => repos.oldestPendingOccurredAt());
    const lag = oldest === undefined ? 0 : Math.max(0, (this.clock.now().getTime() - oldest.getTime()) / 1000);
    this.metrics.set(OUTBOX_LAG_METRIC, lag);
  }
}

