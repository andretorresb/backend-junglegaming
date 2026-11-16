import type { IntegrationEvent } from '../events/integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date | undefined;
  publishedAt?: Date | undefined;
}

export interface OutboxRetryPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_OUTBOX_RETRY_POLICY: OutboxRetryPolicy = { baseDelayMs: 1_000, maxDelayMs: 300_000 };

/**
 * Mensagem a publicar (seção 6.5 do enunciado). Gravada na mesma transação da alteração
 * financeira; só é publicada depois do commit, porque o publisher lê apenas linhas comitadas.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON() as unknown as Record<string, unknown>,
      event.occurredAt,
      0,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  /** Vencida: nunca tentada, ou com a próxima tentativa já no passado. */
  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime());
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new Error(`mensagem ${this.id} já publicada`);
    }
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Conta a tentativa falha e agenda a próxima com backoff exponencial, limitado pelo teto. */
  scheduleRetry(now: Date, policy: OutboxRetryPolicy = DEFAULT_OUTBOX_RETRY_POLICY): void {
    if (!this.isPending()) {
      throw new Error(`mensagem ${this.id} já publicada`);
    }
    this._attempts += 1;
    const delay = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (this._attempts - 1));
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}
