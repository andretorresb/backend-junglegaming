import { DEFAULT_OUTBOX_RETRY_POLICY, type OutboxMessage, type OutboxRetryPolicy } from '../../domain/outbox/outbox-message';
import type { Clock } from '../ports/clock';
import type { EventPublisher, OutboundEvent, PublishOutcome } from '../ports/event-publisher';
import type { Logger, Metrics } from '../ports/observability';
import type { OutboxRepositories, OutboxUnitOfWork } from './ports';

export const OUTBOX_PUBLISHED_METRIC = 'outbox_published_total';
export const OUTBOX_PUBLISH_FAILED_METRIC = 'outbox_publish_failed_total';
export const OUTBOX_LAG_METRIC = 'outbox_lag_seconds';

/** Mensagens por transação. Igual ao limite do SendMessageBatch do SQS. */
export const OUTBOX_CHUNK_SIZE = 10;

export interface OutboxPublisherCycleStats {
  claimed: number;
  published: number;
  failed: number;
}

export interface OutboxPublisherOptions {
  retryPolicy: OutboxRetryPolicy;
  /** Faixas concorrentes por processo. Cada faixa reivindica lotes disjuntos (SKIP LOCKED). */
  parallelism?: number | undefined;
}

interface ChunkResult {
  claimed: number;
  published: number;
  failed: number;
}

/**
 * Publica eventos pendentes da outbox (seção 11 do enunciado).
 *
 * Cada transação reivindica um lote (até 10, SKIP LOCKED), publica, marca e comita. Várias
 * faixas rodam em paralelo no mesmo processo, e vários processos rodam em paralelo entre si,
 * sem pegar a mesma mensagem. Falha de publicação de uma mensagem agenda o retry só dela.
 *
 * Semântica: at-least-once. Se o processo morrer depois de publicar e antes do commit, o lote
 * continua pendente e será publicado de novo, com os mesmos `eventId`.
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

  /** Publica até `batchSize` mensagens vencidas neste ciclo. */
  async runCycle(batchSize: number): Promise<OutboxPublisherCycleStats> {
    const stats: OutboxPublisherCycleStats = { claimed: 0, published: 0, failed: 0 };
    const excluded: string[] = [];
    let budget = batchSize;
    let exhausted = false;

    const lane = async (): Promise<void> => {
      while (!exhausted && budget > 0) {
        const take = Math.min(OUTBOX_CHUNK_SIZE, budget);
        budget -= take;
        const claimedIds: string[] = [];
        try {
          const result = await this.uow.run((repos) => this.publishChunk(repos, take, excluded, (ids) => claimedIds.push(...ids)));
          stats.claimed += result.claimed;
          stats.published += result.published;
          stats.failed += result.failed;
          if (result.claimed < take) exhausted = true;
        } catch (error) {
          // falha da transação (banco): nada foi marcado; o lote volta no próximo ciclo
          stats.failed += Math.max(1, claimedIds.length);
          excluded.push(...claimedIds);
          this.metrics.increment(OUTBOX_PUBLISH_FAILED_METRIC);
          this.logger.error('outbox_publish_error', {
            messageIds: claimedIds,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    const lanes = Math.max(1, this.options.parallelism ?? 1);
    await Promise.all(Array.from({ length: lanes }, lane));
    await this.reportLag();
    return stats;
  }

  private async publishChunk(
    repos: OutboxRepositories,
    limit: number,
    excluded: readonly string[],
    onClaim: (ids: string[]) => void,
  ): Promise<ChunkResult> {
    const now = this.clock.now();
    const messages = await repos.claimDueOutboxBatch(now, limit, excluded);
    if (messages.length === 0) return { claimed: 0, published: 0, failed: 0 };
    onClaim(messages.map((m) => m.id));

    const outcomes = await this.publishAll(messages);
    const byId = new Map(outcomes.map((o) => [o.eventId, o]));
    let published = 0;
    let failed = 0;

    for (const message of messages) {
      const outcome = byId.get(message.id);
      if (outcome?.ok) {
        message.markPublished(now);
        published += 1;
        this.metrics.increment(OUTBOX_PUBLISHED_METRIC, { eventType: message.eventType });
      } else {
        message.scheduleRetry(now, this.options.retryPolicy);
        failed += 1;
        this.metrics.increment(OUTBOX_PUBLISH_FAILED_METRIC);
        this.metrics.increment('retries_total', { component: 'outbox' });
        this.logger.error('outbox_publish_failed', {
          messageId: message.id,
          eventType: message.eventType,
          attempts: message.attempts,
          nextAttemptAt: message.nextAttemptAt?.toISOString() ?? null,
          reason: outcome?.error ?? 'sem resultado do publisher',
        });
      }
      await repos.updateOutbox(message);
    }
    return { claimed: messages.length, published, failed };
  }

  /** Usa o lote do publisher quando existe; senão publica um a um. Nunca lança: falhas viram resultado. */
  private async publishAll(messages: readonly OutboxMessage[]): Promise<PublishOutcome[]> {
    const events: OutboundEvent[] = messages.map((m) => ({ eventId: m.id, eventType: m.eventType, body: JSON.stringify(m.payload) }));
    if (this.publisher.publishBatch) {
      return this.publisher.publishBatch(events);
    }
    const outcomes: PublishOutcome[] = [];
    for (const event of events) {
      try {
        await this.publisher.publish(event);
        outcomes.push({ eventId: event.eventId, ok: true });
      } catch (error) {
        outcomes.push({ eventId: event.eventId, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return outcomes;
  }

  /** Lag = idade, em segundos, da mensagem pendente mais antiga. Zero quando não há pendências. */
  private async reportLag(): Promise<void> {
    const oldest = await this.uow.run((repos) => repos.oldestPendingOccurredAt());
    const lag = oldest === undefined ? 0 : Math.max(0, (this.clock.now().getTime() - oldest.getTime()) / 1000);
    this.metrics.set(OUTBOX_LAG_METRIC, lag);
  }
}
